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

export { GradingResultSchema };

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
