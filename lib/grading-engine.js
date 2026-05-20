import { readFileSync } from 'fs';
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

export function loadRubric(assignment = 'midterm') {
  const rubricPath = join(__dirname, '..', 'rubrics', assignment, 'rubric.json');
  return JSON.parse(readFileSync(rubricPath, 'utf-8'));
}

// ── Load standard answers ──

function loadStandardAnswers() {
  const answersPath = join(__dirname, '..', 'rubrics', 'midterm', 'answers.md');
  try {
    return readFileSync(answersPath, 'utf-8');
  } catch {
    return '';
  }
}

// ── Build grading prompt ──

function buildSystemPrompt() {
  return `你是一位严谨的大学数学课助教，正在批改"AI2613 随机过程"课程的期中考试。

## 你的身份与原则

- 你是一位认真负责且数学功底扎实的助教。
- 你的任务是逐题评阅学生的手写答卷，对照评分标准给出精确的分数和评语。
- 你必须公平、一致地对待每一份卷子。

## 批改规则

1. **逐题对照**：按照给定的题号清单，逐小题检查学生答案。如果某题学生没有作答，给 0 分。
2. **非标准解法**：如果学生使用了与标准答案不同但数学上正确且逻辑严密的解法，给满分。
3. **跳步容忍**：如果学生跳过了基础代数步骤直接得出正确结论，这是可以接受的，不要因此扣分。
4. **部分给分**：如果学生的推导中某一步出错，但之后的步骤在错误结论基础上逻辑正确（即"条件正确"），应给予适当的部分分数。
5. **手写识别**：如果某处手写字迹看不清，设置 needs_review 为 true，不要猜测。
6. **严格验算**：对于关键的不等式放缩、常数计算、特征方程求解等步骤，你必须亲自验算，不能因为排版工整就默认正确。
7. **草稿过滤**：学生可能在答卷中留有探索性草稿文字，你应提取最终答案进行评分，忽略试错过程。

## 学生身份识别

1. **识别学号和姓名**：在试卷的第一页/封面或顶部页眉处，通常有学生手写的姓名和学号。你必须非常仔细地辨认手写体。
2. **拒绝猜测**：如果第一页/封面或页眉处没有任何字迹，或者字迹完全模糊不可认，则将 student_id 和 student_name 填写为 "unknown"。
3. **避免混淆**：不要将试卷上的其他数字（如日期、得分、题目序号）混淆为学号。学号通常为 12 位纯数字（例如：524030910196）。
4. **拼写比对**：请务必确保识别的学号和姓名的准确性，特别是数字（如 8 和 9，0 和 6，1 和 7 等手写体容易混淆的字符），要结合姓名和学号进行双重校验，确保学号长度及格式正确。

## 输出要求

- 严格按照下面的 JSON 字段名输出，**禁止使用其他字段名**。
- total_score 必须等于所有 questions 中 awarded_score 的总和。
- 每小题都必须出现在 questions 数组中，即使学生没有作答（此时 awarded_score = 0）。

### 输出示例（仅展示字段格式，内容为占位）

\`\`\`json
{
  "student_id": "524030910001",
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

function buildUserPrompt(rubric, standardAnswers) {
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

  prompt += `\n## 任务\n\n请仔细阅读上面附带的学生答卷 PDF，逐小题对照评分标准进行评分。输出结构化 JSON。`;

  return prompt;
}

// ── Main grading function ──

export async function gradeSubmission(pdfPath, assignment = 'midterm', model = null, { onRetry } = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(rubric, standardAnswers);
  const jsonSchema = zodToJsonSchema(GradingResultSchema);

  const result = await gradePdfWithSchema(pdfPath, systemPrompt, userPrompt, jsonSchema, model, { onRetry });

  // Normalize field names — models sometimes deviate from schema
  if (result.questions) {
    for (const q of result.questions) {
      // question_number → question_id
      if (!q.question_id && q.question_number) {
        q.question_id = q.question_number;
        delete q.question_number;
      }
      // comment → reasoning (if reasoning is missing)
      if (!q.reasoning && q.comment) {
        q.reasoning = q.comment;
      }
      // Ensure error_description exists
      if (q.error_description === undefined) {
        q.error_description = q.is_correct ? '' : (q.comment || q.reasoning || '');
      }
      // Ensure is_correct exists
      if (q.is_correct === undefined) {
        q.is_correct = q.awarded_score === q.max_score;
      }
      // Ensure needs_review exists
      if (q.needs_review === undefined) {
        q.needs_review = false;
      }
    }
  }

  // Validate total_score consistency
  const calculatedTotal = result.questions.reduce((sum, q) => sum + q.awarded_score, 0);
  if (result.total_score !== calculatedTotal) {
    result.total_score = calculatedTotal;
  }

  return result;
}

// ── Grade a single sub-question individually ──

export async function gradeSingleQuestion(pdfPath, questionId, assignment = 'midterm', model = null, { onRetry } = {}) {
  const rubric = loadRubric(assignment);
  const standardAnswers = loadStandardAnswers();
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

  // Build a specific prompt for this single sub-question
  const systemPrompt = `你是一位严谨的大学数学课助教，正在批改"AI2613 随机过程"课程的期中考试。
你的任务是**仅仅批改第 ${questionId} 题**。
不要检查或批改试卷上的其他任何题目，只专注评估第 ${questionId} 题学生答案是否正确并给出对应分数和理由。

## 批改规则
1. **对照评分标准**：按照给定的 ${questionId} 题的评分标准检查学生答案。如果学生没有作答，给 0 分。
2. **非标准解法**：如果学生使用了与标准答案不同但数学上正确且逻辑严密的解法，给满分。
3. **部分给分**：如果学生的推导中某一步出错，但之前的步骤在错误结论基础上逻辑正确，应给予适当的部分分数。
4. **输出要求**：必须严格按照指定的 JSON 字段输出。`;

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

  userPrompt += `\n## 任务\n\n请仔细阅读附加的学生答卷 PDF，在整份答卷中找到第 ${questionId} 题的解答（通常包含在对应大题下，请根据公式和文字线索自行检索）。对照评分标准进行精准评分，并输出结构化 JSON。`;

  const result = await gradePdfWithSchema(pdfPath, systemPrompt, userPrompt, jsonSchema, model, { onRetry });

  // Normalize single question output
  if (!result.question_id) {
    result.question_id = questionId;
  }
  if (result.is_correct === undefined) {
    result.is_correct = result.awarded_score === result.max_score;
  }
  if (result.needs_review === undefined) {
    result.needs_review = false;
  }
  if (result.error_description === undefined) {
    result.error_description = result.is_correct ? '' : (result.reasoning || '');
  }

  return result;
}

// ── Build chat system prompt ──

export function buildChatSystemPrompt(gradeJson) {
  let context = `你是一位严谨的大学数学课助教。助教正在和你讨论一份学生的期中考试答卷。

## 当前评分情况

`;
  if (gradeJson) {
    const grade = typeof gradeJson === 'string' ? JSON.parse(gradeJson) : gradeJson;
    context += `学生：${grade.student_name}（${grade.student_id}）\n`;
    context += `总分：${grade.total_score}/120\n\n`;
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
