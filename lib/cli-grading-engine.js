import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  GradingResultSchema,
  SubQuestionGrade,
  buildSystemPrompt,
  buildUserPrompt,
  loadRubric,
  loadStandardAnswers,
  normalizeGradingResult,
  normalizeSingleQuestionResult,
} from './grading-engine.js';
import { getModelConfig } from './gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DEFAULT_CODEX_PATH = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_AGY_PATH = 'agy';
const DEFAULT_PDFTOPPM_PATH = 'pdftoppm';
const RENDER_DPI = Number(process.env.CLI_GRADING_RENDER_DPI || 160);
const MAX_PAGES = Number(process.env.CLI_GRADING_MAX_PAGES || 32);
const CLI_TIMEOUT_MS = Number(process.env.CLI_GRADING_TIMEOUT_MS || 20 * 60 * 1000);
const AGY_PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || '20m';

function resolveExecutable(envName, defaultPath, fallbackName) {
  if (process.env[envName]) return process.env[envName];
  return existsSync(defaultPath) ? defaultPath : fallbackName;
}

function cliEnv() {
  const pathParts = [
    '/Applications/Codex.app/Contents/Resources',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    process.env.PATH || '',
  ];
  return {
    ...process.env,
    PATH: Array.from(new Set(pathParts.filter(Boolean))).join(':'),
  };
}

function limitedAppend(current, chunk, limit = 1024 * 1024) {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function runCommand(command, args, options = {}) {
  const cwd = options.cwd || PROJECT_ROOT;
  const timeoutMs = options.timeoutMs || CLI_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, { cwd, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout = limitedAppend(stdout, chunk.toString()); });
    child.stderr.on('data', chunk => { stderr = limitedAppend(stderr, chunk.toString()); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      const label = basename(command);
      const detail = (stderr || stdout || '').trim().slice(-2000);
      const timeoutText = timedOut ? '（超时）' : '';
      reject(new Error(label + ' 执行失败' + timeoutText + '，退出码 ' + code + ': ' + detail));
    });
  });
}

function schemaFor(zodSchema) {
  const schema = zodToJsonSchema(zodSchema);
  if (schema && typeof schema === 'object') {
    delete schema.$schema;
    delete schema.default;
  }
  return schema;
}

async function renderPdfToImages(pdfPath, tempDir) {
  const pdftoppm = resolveExecutable('PDFTOPPM_PATH', DEFAULT_PDFTOPPM_PATH, 'pdftoppm');
  const prefix = join(tempDir, 'page');
  await runCommand(pdftoppm, [
    '-png',
    '-r', String(RENDER_DPI),
    '-f', '1',
    '-l', String(MAX_PAGES),
    pdfPath,
    prefix,
  ], { timeoutMs: 2 * 60 * 1000 });

  const pageNumber = file => Number((file.match(/-(\d+)\.png$/) || [])[1] || 0);
  const images = readdirSync(tempDir)
    .filter(file => file.endsWith('.png'))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .map(file => join(tempDir, file));

  if (images.length === 0) {
    throw new Error('无法将 PDF 渲染为页面图片');
  }
  return images;
}

function imageContext(imagePaths) {
  return imagePaths.map((imagePath, index) => String(index + 1) + '. ' + imagePath).join('\n');
}

function buildCliPrompt(systemPrompt, userPrompt, imagePaths, jsonSchema, includeSchema) {
  let prompt = systemPrompt + '\n\n' + userPrompt + '\n\n';
  prompt += '## 学生答卷页面图片\n\n';
  prompt += '原始 PDF 已按页渲染成图片。请按顺序阅读这些页面图片，不要忽略页眉中的姓名/学号。\n';
  prompt += imageContext(imagePaths) + '\n\n';
  prompt += '## 输出要求\n\n只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加解释性前后缀。';
  if (includeSchema) {
    prompt += '\nJSON Schema 如下：\n' + JSON.stringify(jsonSchema, null, 2);
  }
  return prompt;
}

function stripFence(text) {
  const fence = String.fromCharCode(96, 96, 96);
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith(fence)) {
    cleaned = cleaned.slice(fence.length).trim();
    if (cleaned.toLowerCase().startsWith('json')) cleaned = cleaned.slice(4).trim();
    if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -fence.length).trim();
  }
  return cleaned;
}

function extractJson(rawText) {
  const unfenced = stripFence(rawText);
  if (!unfenced) throw new Error('CLI 没有返回可解析内容');
  try {
    return JSON.parse(unfenced);
  } catch {}

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(unfenced.slice(start, end + 1));
  }
  throw new Error('无法从 CLI 输出中解析 JSON: ' + unfenced.slice(0, 300));
}

async function runCodexGrader(modelInfo, prompt, imagePaths, jsonSchema, tempDir) {
  const codex = resolveExecutable('CODEX_CLI_PATH', DEFAULT_CODEX_PATH, 'codex');
  const schemaPath = join(tempDir, 'schema.json');
  const outputPath = join(tempDir, 'codex-output.json');
  writeFileSync(schemaPath, JSON.stringify(jsonSchema, null, 2), 'utf-8');

  const args = [
    'exec',
    prompt,
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '-m', modelInfo.model,
    '-c', 'model_reasoning_effort="' + (modelInfo.reasoningEffort || 'high') + '"',
    '--output-schema', schemaPath,
    '-o', outputPath,
  ];
  for (const imagePath of imagePaths) {
    args.push('-i', imagePath);
  }

  const { stdout } = await runCommand(codex, args);
  const raw = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : stdout;
  return extractJson(raw);
}

async function runAgyGrader(modelInfo, prompt, tempDir) {
  const agy = resolveExecutable('AGY_CLI_PATH', DEFAULT_AGY_PATH, 'agy');
  const args = [
    '--print', prompt,
    '--model', modelInfo.model,
    '--print-timeout', AGY_PRINT_TIMEOUT,
    '--add-dir', tempDir,
  ];
  const { stdout } = await runCommand(agy, args);
  return extractJson(stdout);
}

async function runCliGrader({ pdfPath, modelKey, systemPrompt, userPrompt, zodSchema }) {
  const modelInfo = getModelConfig(modelKey);
  if (!modelInfo || (modelInfo.provider !== 'codex-cli' && modelInfo.provider !== 'agy-cli')) {
    throw new Error('不是可用的 CLI 批改模型: ' + modelKey);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'autograde-cli-'));
  try {
    const jsonSchema = schemaFor(zodSchema);
    const imagePaths = await renderPdfToImages(pdfPath, tempDir);
    const prompt = buildCliPrompt(systemPrompt, userPrompt, imagePaths, jsonSchema, modelInfo.provider === 'agy-cli');

    if (modelInfo.provider === 'codex-cli') {
      return await runCodexGrader(modelInfo, prompt, imagePaths, jsonSchema, tempDir);
    }
    return await runAgyGrader(modelInfo, prompt, tempDir);
  } finally {
    if (process.env.CLI_GRADING_KEEP_TEMP !== '1') {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function buildSingleQuestionCliPrompt(questionId, assignment) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers(assignment);
  let questionDef = null;

  for (const q of rubric.questions || []) {
    const sq = (q.sub_questions || []).find(s => s.id === questionId);
    if (sq) {
      questionDef = { parentTitle: q.title, ...sq };
      break;
    }
  }

  if (!questionDef) {
    throw new Error('找不到小题编号: ' + questionId);
  }

  const title = rubric.assignment || '作业';
  const systemPrompt = '你是一位严谨但偏宽松的大学课程助教，正在批改"' + title + '"。\n'
    + '你的任务是仅仅批改第 ' + questionId + ' 题。\n'
    + '不要检查或批改试卷上的其他任何题目，只专注评估第 ' + questionId + ' 题学生答案是否正确并给出对应分数和理由。\n\n'
    + '## 批改规则（偏宽松）\n'
    + '1. 对照评分标准：按照给定的 ' + questionId + ' 题的评分标准检查学生答案。完全空白或完全无关给 0 分；否则尽量识别其中可得分的数学内容。\n'
    + '2. 容易题高给分：本次 rubric 已提高基础/标准题权重。若学生写出核心概念、关键公式、正确对象或主要结论，应给较高分，不因轻微记号、表述或跳步大扣。\n'
    + '3. 非标准解法：如果学生使用了与标准答案不同但数学上正确或基本正确的解法，给满分或接近满分。\n'
    + '4. 部分给分偏宽：正确思路但证明不完整通常给该小题 50%-80%；关键结论正确且推导大体可信通常给 70%-100%；最后常数、边界、符号小错只小扣。\n'
    + '5. 条件正确原则：如果学生前一步计算出错，但后续在其错误结论基础上逻辑自洽，应给予后续步骤相应部分分。\n'
    + '6. 手写识别：如果局部字迹不清但上下文可合理判断其意图，按有利于学生的方式评分；确实无法辨认时再标记 needs_review。\n'
    + '7. 输出要求：必须严格按照指定的 JSON 字段输出。';

  let userPrompt = '## 第 ' + questionId + ' 题评分标准\n\n'
    + '大题：' + questionDef.parentTitle + '\n'
    + '小题：' + questionId + '（满分：' + questionDef.max_score + ' 分）\n'
    + '题目及步骤描述：' + questionDef.description + '\n'
    + '关键得分点：\n'
    + questionDef.key_points.map(kp => '- ' + kp).join('\n') + '\n';

  if (questionDef.common_mistakes && questionDef.common_mistakes.length > 0) {
    userPrompt += '常见错误：\n' + questionDef.common_mistakes.map(cm => '- ' + cm).join('\n') + '\n';
  }
  if (standardAnswers) {
    userPrompt += '\n## 参考标准答案\n\n' + standardAnswers + '\n';
  }
  userPrompt += '\n## 任务\n\n请仔细阅读附加的学生答卷，在整份答卷中找到第 ' + questionId + ' 题的解答。对照评分标准进行偏宽松但一致的评分，优先奖励正确思路、关键公式、合理方法和正确结论；轻微跳步、记号不规范和非核心细节错误少扣分。输出结构化 JSON。';

  return { systemPrompt, userPrompt };
}

export function isCliGradingModel(modelKey) {
  const modelInfo = getModelConfig(modelKey);
  return modelInfo?.provider === 'codex-cli' || modelInfo?.provider === 'agy-cli';
}

export async function gradeSubmissionWithCli(pdfPath, assignment = 'default', modelKey, options = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers(assignment);
  const systemPrompt = buildSystemPrompt(assignment);
  const userPrompt = buildUserPrompt(rubric, standardAnswers);
  const result = await runCliGrader({
    pdfPath,
    modelKey,
    systemPrompt,
    userPrompt,
    zodSchema: GradingResultSchema,
  });
  return normalizeGradingResult(result, assignment);
}

export async function gradeSingleQuestionWithCli(pdfPath, questionId, assignment = 'default', modelKey, options = {}) {
  const prompts = buildSingleQuestionCliPrompt(questionId, assignment);
  const result = await runCliGrader({
    pdfPath,
    modelKey,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    zodSchema: SubQuestionGrade,
  });
  return normalizeSingleQuestionResult(result, questionId, assignment);
}

function compactGradeForPrompt(label, grade) {
  return {
    label,
    student_id: grade?.student_id,
    student_name: grade?.student_name,
    total_score: grade?.total_score,
    overall_comment: grade?.overall_comment,
    questions: (grade?.questions || []).map(q => ({
      question_id: q.question_id,
      max_score: q.max_score,
      awarded_score: q.awarded_score,
      is_correct: q.is_correct,
      needs_review: q.needs_review,
      error_description: q.error_description,
      reasoning: q.reasoning,
    })),
  };
}

export async function arbitrateGradesWithCodex(pdfPath, assignment = 'default', initialGrades, options = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers(assignment);
  const expected = options.expectedStudent || {};
  const expectedText = expected.student_id || expected.student_name
    ? '已由系统/花名册匹配的学生身份：' + (expected.student_name || 'unknown') + '（' + (expected.student_id || 'unknown') + '）。如卷面 OCR 与此不一致，除非非常确定系统匹配错误，否则最终输出应使用这个身份。\n\n'
    : '';

  const systemPrompt = '你是一位非常严谨但偏宽松的随机过程期末考试总评仲裁员。你将看到学生答卷页面、评分标准、参考答案，以及两个独立初评模型的逐题评分。你的任务是给出最终仲裁评分。\n\n'
    + '仲裁原则（按本次新 rubric 的宽松口径）：\n'
    + '1. 不要机械平均两个初评分；必须亲自阅读卷面并核对参考答案。\n'
    + '2. 本次 rubric 已提高容易题/基础题权重。对定义、构造、生成矩阵、平稳分布、基础反射原理、基本耦合递推等标准题，若核心公式、对象或结论正确，应给较高分。\n'
    + '3. 两个初评分差异较大时，优先检查学生是否有可辨认的正确思路和关键推导；若一个较高分数在数学上可辩护，通常向较宽松的一侧靠拢。\n'
    + '4. 不要比两个初评都更严，除非两者都明显漏掉了核心错误；如果一个模型因证明不完整给很低分，但学生写出了关键思路或结论，通常应提高到合理部分分。\n'
    + '5. 非标准解法数学上正确或基本正确，应给满分或接近满分，不要求与参考答案同构。\n'
    + '6. 轻微符号、边界、常数、小跳步或文字解释不足只小扣；正确思路但证明不完整通常给 50%-80%，关键结论正确且推导大体可信通常给 70%-100%。\n'
    + '7. 若字迹或题号对应仍不确定，needs_review 设为 true，并在 reasoning 中说明；能结合上下文合理判断时按有利于学生的方式评分。\n'
    + '8. 每题 reasoning 必须包含简短仲裁依据，建议格式为“Gemini 初评 x，AGY 初评 y；仲裁认为……”。\n'
    + '9. 输出必须是最终可登记成绩，total_score 必须等于各小题得分之和。';

  let userPrompt = expectedText;
  userPrompt += buildUserPrompt(rubric, standardAnswers);
  userPrompt += '\n\n## 两个独立初评结果\n\n';
  userPrompt += JSON.stringify([
    compactGradeForPrompt('Gemini 3.5 Flash', initialGrades.gemini),
    compactGradeForPrompt('AGY Gemini 3.1 Pro High', initialGrades.agy),
  ], null, 2);
  userPrompt += '\n\n## 仲裁任务\n\n请阅读学生答卷页面，比较两份初评，并输出最终仲裁 JSON。对两个初评分相差 2 分及以上的小题尤其仔细。';

  const result = await runCliGrader({
    pdfPath,
    modelKey: 'codex-gpt-5.5-xhigh',
    systemPrompt,
    userPrompt,
    zodSchema: GradingResultSchema,
  });
  return normalizeGradingResult(result, assignment);
}
