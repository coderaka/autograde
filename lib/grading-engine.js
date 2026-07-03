import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { gradePdfWithSchema } from './gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Zod Schema for structured grading output ──

const SubQuestionGrade = z.object({
  question_id: z.string().describe('小题编号，如 "1a", "2d", "4b"'),
  max_score: z.number().describe('该小题满分'),
  awarded_score: z.number().describe('给出的分数，0 到 max_score 之间'),
  is_correct: z.boolean().describe('是否完全正确'),
  error_description: z.string().describe('错误描述。如果完全正确则为空字符串 ""'),
  reasoning: z.string().describe('评分理由（简要说明，1-2 句话）'),
  needs_review: z.boolean().describe('当你不确定评分是否正确时设为 true，请助教人工复核'),
});

const GradingResultSchema = z.object({
  student_id: z.string().describe('从卷面读取的学号（如果看不清写 "unknown"）'),
  student_name: z.string().describe('从卷面读取的姓名（如果看不清写 "unknown"）'),
  questions: z.array(SubQuestionGrade).describe('每一小题的评分'),
  total_score: z.number().describe('所有小题的得分之和'),
  overall_comment: z.string().describe('对这份卷子的整体评价，1-2 句话'),
});

export { GradingResultSchema, SubQuestionGrade };

// ── Load rubric ──

export function loadRubric(assignment = 'default') {
  const rubricPath = join(__dirname, '..', 'rubrics', assignment, 'rubric.json');
  return JSON.parse(readFileSync(rubricPath, 'utf-8'));
}

// ── Load standard answers ──

export function loadStandardAnswers(assignment = 'default') {
  const answersPath = join(__dirname, '..', 'rubrics', assignment, 'answers.md');
  try {
    return readFileSync(answersPath, 'utf-8');
  } catch {
    return '';
  }
}

// ── Build grading prompt ──

export function buildSystemPrompt(assignment = 'default') {
  let title = '随机过程作业';
  try {
    const rubric = loadRubric(assignment);
    if (rubric && rubric.assignment) {
      title = rubric.assignment;
    }
  } catch (err) {
    // Ignore loading error
  }
  return `你是一位严谨的大学课程助教，正在批改"${title}"。

## 你的身份与原则

- 你是一位认真负责且数学功底扎实的助教。
- 你的任务是逐题评阅学生的手写答卷，对照评分标准给出精确的分数和评语。
- 你必须公平、一致地对待每一份卷子。

## 批改规则（本次期末采用偏宽松、鼓励性、一致性的评分口径）

1. **逐题对照**：按照给定的题号清单和当前 rubric 的分值逐小题检查。若某题完全空白或完全无关，给 0 分；否则尽量识别其中可得分的数学内容。
2. **容易题权重提高**：本次 rubric 已把若干基础/标准题的分值调高。对于定义、生成矩阵、平稳分布、基础反射原理、基本随机游走性质等容易题，只要核心概念、关键公式或主要结论正确，应给较高分；不要因记号、表述、少量跳步扣太多。
3. **非标准解法**：如果学生使用了与标准答案不同但数学上正确或基本正确的解法，应给满分或接近满分；不要要求答案必须和参考答案同构。
4. **跳步与表述容忍**：如果学生跳过基础代数、文字解释不够完整、符号略不规范，但关键思路和结论清楚，这是可以接受的。除非影响核心逻辑，不要大幅扣分。
5. **部分给分偏宽**：若学生有正确思路但证明不完整，通常应给该小题 50%-80%；若关键结论正确且推导大体可信，通常应给 70%-100%；若只是最后常数、符号或边界小错，应小扣。只有核心对象构造错误、方向完全错误、或关键论证缺失时才给低分。
6. **条件正确原则**：如果学生前一步计算出错，但后续在其错误结论基础上逻辑自洽，应给予后续步骤的相应部分分。
7. **严格但不苛刻**：关键的不等式放缩、常数计算、特征方程求解仍需验算；但扣分应与该错误在 rubric 中的实际重要性匹配，避免因一个局部瑕疵拖低整题。
8. **手写识别**：如果局部字迹不清但能结合上下文合理判断其意图，按有利于学生的方式评分；只有确实无法辨认且影响评分时才设置 needs_review 为 true。
9. **草稿过滤**：学生可能在答卷中留有探索性草稿文字，你应提取最终答案进行评分；如果最终答案不明确，选择最有利且数学上可自洽的一版。

## 学生身份识别

1. **识别学号和姓名**：在试卷的第一页/封面或顶部页眉处，通常有学生手写的姓名和学号。你必须非常仔细地辨认手写体。
2. **拒绝猜测**：如果第一页/封面或页眉处没有任何字迹，或者字迹完全模糊不可认，则将 student_id 和 student_name 填写为 "unknown"。
3. **避免混淆**：不要将试卷上的其他数字（如日期、得分、题目序号）混淆为学号。学号通常为课程规定格式的纯数字（例如：202600000001）。
4. **拼写比对**：请务必确保识别的学号和姓名的准确性，特别是数字（如 8 和 9，0 和 6，1 和 7 等手写体容易混淆的字符），要结合姓名和学号进行双重校验，确保学号长度及格式正确。

## 输出要求

- 严格按照下面的 JSON 字段名输出，**禁止使用其他字段名**。
- total_score 必须等于所有 questions 中 awarded_score 的总和。
- 每小题都必须出现在 questions 数组中，即使学生没有作答（此时 awarded_score = 0）。

### 输出示例（仅展示字段格式，内容为占位）

\`\`\`json
{
  "student_id": "202600000001",
  "student_name": "张三",
  "total_score": 85,
  "overall_comment": "基础概念掌握较好，但第3题推导有疏漏。",
  "questions": [
    {
      "question_id": "1a",
      "max_score": 5,
      "awarded_score": 5,
      "is_correct": true,
      "error_description": "",
      "reasoning": "计算完全正确。",
      "needs_review": false
    },
    {
      "question_id": "1b",
      "max_score": 7,
      "awarded_score": 4,
      "is_correct": false,
      "error_description": "Markov 不等式应用步骤缺失",
      "reasoning": "前半部分期望计算正确，但缺少最后一步 Markov 不等式。",
      "needs_review": false
    }
  ]
}
\`\`\`

**必须使用上面的精确字段名**：question_id, max_score, awarded_score, is_correct, error_description, reasoning, needs_review。`;
}

export function buildUserPrompt(rubric, standardAnswers) {
  let prompt = `## 评分标准\n\n`;
  prompt += `试卷总分：${rubric.total_score} 分\n\n`;

  for (const q of rubric.questions) {
    prompt += `### 第${q.id}题：${q.title}（${q.max_score} 分）\n\n`;
    for (const sq of q.sub_questions) {
      prompt += `- **${sq.id}**（${sq.max_score} 分）：${sq.description}\n`;
      prompt += `  - 关键得分点：${sq.key_points.join('；')}\n`;
      if (sq.common_mistakes && sq.common_mistakes.length > 0) {
        prompt += `  - 常见错误：${sq.common_mistakes.join('；')}\n`;
      }
    }
    prompt += '\n';
  }

  if (standardAnswers) {
    prompt += `\n## 参考标准答案\n\n${standardAnswers}\n`;
  }

  prompt += `\n## 任务\n\n请仔细阅读上面附带的学生答卷 PDF，逐小题对照评分标准进行评分。请采用本次期末的偏宽松评分口径：优先奖励正确概念、关键公式、合理方法与正确结论；对轻微跳步、记号不规范和非核心细节错误少扣分。输出结构化 JSON。`;

  return prompt;
}

// ── Shared normalization helpers ──

function canonicalQuestionDefs(assignment) {
  const rubric = loadRubric(assignment || 'default');
  const defs = [];
  for (const q of rubric.questions || []) {
    for (const sq of q.sub_questions || []) {
      defs.push({ ...sq, parent_id: q.id, parent_title: q.title });
    }
  }
  return defs;
}

function compactQuestionId(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/^question\s*/i, '')
    .replace(/^q\s*/i, '')
    .replace(/第/g, '')
    .replace(/题/g, '')
    .replace(/[\s_().（）-]/g, '');
}

function loadQuestionAliasConfig(assignment) {
  const aliasPath = join(__dirname, '..', 'rubrics', assignment || 'default', 'aliases.json');
  if (!existsSync(aliasPath)) return null;
  try {
    return JSON.parse(readFileSync(aliasPath, 'utf-8'));
  } catch {
    return null;
  }
}

function markerMatches(marker, ids, questions) {
  if (typeof marker === 'string') return ids.has(compactQuestionId(marker));
  if (!marker || typeof marker !== 'object') return false;

  const id = compactQuestionId(marker.question_id || marker.id || marker.qid);
  if (!id || !ids.has(id)) return false;
  if (marker.max_score === undefined) return true;

  return questions.some(q => {
    const qid = compactQuestionId(q.question_id || q.question_number || q.id);
    return qid === id && Number(q.max_score) === Number(marker.max_score);
  });
}

function inferAliasVariant(config, questions = []) {
  const ids = new Set(questions.map(q => compactQuestionId(q.question_id || q.question_number || q.id)));
  const markers = config?.variant_markers || {};
  for (const [variant, variantMarkers] of Object.entries(markers)) {
    const list = Array.isArray(variantMarkers) ? variantMarkers : [variantMarkers];
    if (list.some(marker => markerMatches(marker, ids, questions))) return variant;
  }
  return config?.default_variant || Object.keys(config?.variants || {})[0] || null;
}

function questionAliasMap(assignment, questions) {
  const config = loadQuestionAliasConfig(assignment);
  if (!config) return {};
  if (config.aliases && typeof config.aliases === 'object') return config.aliases;

  const variant = inferAliasVariant(config, questions);
  const variants = config.variants || {};
  return variants[variant] || {};
}

function resolveQuestionId(rawId, defs, aliases) {
  const id = String(rawId || '').trim();
  const byExact = new Map(defs.map(def => [String(def.id).toLowerCase(), def.id]));
  if (byExact.has(id.toLowerCase())) return byExact.get(id.toLowerCase());

  const compact = compactQuestionId(id);
  if (aliases[compact]) return aliases[compact];
  return id || 'unknown';
}

function normalizeQuestionFields(q, def) {
  if (!q.reasoning) q.reasoning = q.comments || q.comment || '';
  if (q.awarded_score === undefined && q.score !== undefined) q.awarded_score = q.score;

  const targetMax = Number(def?.max_score ?? q.max_score ?? 0);
  const sourceMax = Number(q.max_score);
  let awarded = Number(q.awarded_score || 0);

  if (def && Number.isFinite(sourceMax) && sourceMax > 0 && sourceMax !== targetMax) {
    awarded = Math.round((awarded / sourceMax) * targetMax * 2) / 2;
  }

  q.max_score = targetMax;
  q.awarded_score = Math.max(0, Math.min(targetMax, Number.isFinite(awarded) ? awarded : 0));
  q.is_correct = q.awarded_score >= q.max_score;
  if (q.needs_review === undefined) q.needs_review = false;
  if (q.error_description === undefined) {
    q.error_description = q.is_correct ? '' : (q.reasoning || q.comment || '');
  }
  delete q.question_number;
  return q;
}

export function normalizeGradingResult(result, assignment = 'default') {
  if (!result || typeof result !== 'object') {
    throw new Error('AI 返回结果不是有效 JSON 对象');
  }
  if (!Array.isArray(result.questions)) result.questions = [];

  let defs = [];
  let defById = new Map();
  try {
    defs = canonicalQuestionDefs(assignment);
    defById = new Map(defs.map(def => [def.id, def]));
  } catch {
    defs = [];
  }

  const aliases = questionAliasMap(assignment, result.questions);
  const byId = new Map();

  for (const raw of result.questions) {
    const rawId = raw.question_id || raw.question_number || raw.id;
    const questionId = resolveQuestionId(rawId, defs, aliases);
    raw.question_id = questionId;
    const normalized = normalizeQuestionFields(raw, defById.get(questionId));

    const existing = byId.get(questionId);
    if (!existing || Number(normalized.awarded_score || 0) > Number(existing.awarded_score || 0)) {
      byId.set(questionId, normalized);
    }
  }

  if (defs.length > 0) {
    result.questions = defs.map(def => byId.get(def.id) || normalizeQuestionFields({
      question_id: def.id,
      awarded_score: 0,
      max_score: def.max_score,
      is_correct: false,
      error_description: '模型未返回该小题评分',
      reasoning: '模型未返回该小题评分。',
      needs_review: true,
    }, def));
  } else {
    result.questions = Array.from(byId.values());
  }

  result.total_score = result.questions.reduce((sum, q) => sum + Number(q.awarded_score || 0), 0);
  return result;
}

export function normalizeSingleQuestionResult(result, questionId, assignment = 'default') {
  if (!result || typeof result !== 'object') {
    throw new Error('AI 返回结果不是有效 JSON 对象');
  }

  let defs = [];
  try {
    defs = canonicalQuestionDefs(assignment);
  } catch {
    defs = [];
  }
  const aliases = questionAliasMap(assignment, [result]);
  const resolvedId = resolveQuestionId(result.question_id || questionId, defs, aliases);
  const def = defs.find(item => item.id === resolvedId) || defs.find(item => item.id === questionId);

  result.question_id = def?.id || resolvedId || questionId;
  return normalizeQuestionFields(result, def);
}

// ── Main grading function ──

export async function gradeSubmission(pdfPath, assignment = 'default', model = null, { onRetry } = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers(assignment);
  const systemPrompt = buildSystemPrompt(assignment);
  const userPrompt = buildUserPrompt(rubric, standardAnswers);
  const jsonSchema = zodToJsonSchema(GradingResultSchema);

  const result = await gradePdfWithSchema(pdfPath, systemPrompt, userPrompt, jsonSchema, model, { onRetry });
  return normalizeGradingResult(result, assignment);
}

// ── Grade a single sub-question individually ──

export async function gradeSingleQuestion(pdfPath, questionId, assignment = 'default', model = null, { onRetry } = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers(assignment);
  const jsonSchema = zodToJsonSchema(SubQuestionGrade);

  // Find the sub-question definition in the rubric
  let questionDef = null;
  for (const q of rubric.questions) {
    const sq = q.sub_questions.find(s => s.id === questionId);
    if (sq) {
      questionDef = {
        parentTitle: q.title,
        ...sq
      };
      break;
    }
  }

  if (!questionDef) {
    throw new Error(`找不到小题编号: ${questionId}`);
  }

  const title = rubric.assignment || '作业';

  // Build a specific prompt for this single sub-question
  const systemPrompt = `你是一位严谨的大学课程助教，正在批改"${title}"。
你的任务是**仅仅批改第 ${questionId} 题**。
不要检查或批改试卷上的其他任何题目，只专注评估第 ${questionId} 题学生答案是否正确并给出对应分数和理由。

## 批改规则（偏宽松）
1. **对照评分标准**：按照给定的 ${questionId} 题评分标准检查。如果学生完全没有作答或完全无关，给 0 分；否则尽量识别可得分内容。
2. **奖励核心思路**：若关键概念、主要公式、构造方法或结论正确，即使证明不完整、记号略乱、跳过细节，也应给较高部分分。
3. **非标准解法**：不同于参考答案但数学上正确或基本正确的解法，给满分或接近满分。
4. **部分给分偏宽**：正确思路但证明不完整通常给 50%-80%；关键结论正确且推导大体可信通常给 70%-100%；轻微常数/符号/边界错误小扣。
5. **输出要求**：必须严格按照指定的 JSON 字段输出。`;

  let userPrompt = `## 第 ${questionId} 题 评分标准

大题：${questionDef.parentTitle}
小题：${questionId}（满分：${questionDef.max_score} 分）
题目及步骤描述：${questionDef.description}
关键得分点：
${questionDef.key_points.map(kp => `- ${kp}`).join('\n')}
`;

  if (questionDef.common_mistakes && questionDef.common_mistakes.length > 0) {
    userPrompt += `常见错误：
${questionDef.common_mistakes.map(cm => `- ${cm}`).join('\n')}
`;
  }

  if (standardAnswers) {
    userPrompt += `\n## 参考标准答案\n\n${standardAnswers}\n`;
  }

  userPrompt += `\n## 任务\n\n请仔细阅读附加的学生答卷 PDF，在整份答卷中找到第 ${questionId} 题的解答（通常包含在对应大题下，请根据公式和文字线索自行检索）。对照评分标准进行偏宽松但一致的评分，优先奖励正确思路、关键公式和合理结论，并输出结构化 JSON。`;

  const result = await gradePdfWithSchema(pdfPath, systemPrompt, userPrompt, jsonSchema, model, { onRetry });

  return normalizeSingleQuestionResult(result, questionId, assignment);
}

// ── Build chat system prompt ──

export function buildChatSystemPrompt(gradeJson) {
  let context = `你是一位严谨的大学数学课助教。助教正在和你讨论一份学生的答卷。

## 当前评分情况

`;
  if (gradeJson) {
    const grade = typeof gradeJson === 'string' ? JSON.parse(gradeJson) : gradeJson;
    context += `学生：${grade.student_name}（${grade.student_id}）\n`;
    const maxScore = grade.questions && grade.questions.length > 0
      ? grade.questions.reduce((s, q) => s + (q.max_score || 0), 0)
      : 120;
    context += `总分：${grade.total_score}/${maxScore}\n\n`;
    for (const q of grade.questions) {
      const status = q.is_correct ? '✅' : (q.needs_review ? '⚠️' : '❌');
      context += `- ${q.question_id}：${q.awarded_score}/${q.max_score} ${status}`;
      if (q.error_description) context += ` — ${q.error_description}`;
      context += '\n';
    }
  }

  context += `\n## 规则
- 回答助教关于这份卷子的问题，引用 PDF 中的具体内容。
- 如果助教质疑某道题的评分，重新审视并给出你的分析。
- 数学公式用 LaTeX 格式（$..$ 行内，$$...$$ 行间）。
- 用中文回答。`;

  return context;
}
