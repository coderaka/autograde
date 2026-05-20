import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

let ai;

// Available models for grading
export const MODELS = {
  'gemini-3.5-flash': { label: 'Gemini 3.5 Flash', tier: 'fast' },
  'gemini-3.1-pro-preview': { label: 'Gemini 3.1 Pro (Preview)', tier: 'pro' },
  'gemini-3-flash-preview': { label: 'Gemini 3 Flash (Preview)', tier: 'fast' },
};

export const DEFAULT_MODEL = 'gemini-3.5-flash';

// Server-wide model setting (mutable via API)
let currentModel = DEFAULT_MODEL;

export function getCurrentModel() { return currentModel; }
export function setCurrentModel(model) {
  if (MODELS[model]) {
    currentModel = model;
    return true;
  }
  return false;
}

export function getAI() {
  if (!ai) {
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return ai;
}

/**
 * Grade a PDF submission using Gemini multimodal + structured output.
 * @param {string} pdfPath - Absolute path to student PDF
 * @param {string} systemPrompt - System instruction for grading
 * @param {string} userPrompt - User prompt with rubric details
 * @param {object} jsonSchema - JSON schema for structured output
 * @param {string} [model] - Override model name
 * @returns {object} Parsed JSON grading result
 */
export async function gradePdfWithSchema(pdfPath, systemPrompt, userPrompt, jsonSchema, model, { onRetry } = {}) {
  const ai = getAI();
  const modelName = model || currentModel;
  const pdfBuffer = readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');

  const MAX_RETRIES = 3;
  let lastError;

  if (jsonSchema && typeof jsonSchema === 'object') {
    delete jsonSchema.$schema;
    delete jsonSchema.default;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
              { text: userPrompt },
            ],
          },
        ],
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: jsonSchema,
        },
      });

      // Some preview models wrap JSON in ```json ... ``` despite responseFormat
      const raw = response.text;
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      return JSON.parse(cleaned);
    } catch (err) {
      lastError = err;
      const shortMsg = (err.message || String(err)).substring(0, 80);
      const isRetryable = err.message?.includes('fetch failed')
        || err.code === 'UND_ERR_SOCKET'
        || err.message?.includes('socket')
        || err.message?.includes('ECONNRESET')
        || err.message?.includes('429')
        || err.message?.includes('503');

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`⚠️ Attempt ${attempt}/${MAX_RETRIES} failed (${shortMsg}), retrying in ${delay / 1000}s...`);
        if (onRetry) onRetry(attempt, MAX_RETRIES, shortMsg);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`AI 请求失败 (${attempt}/${MAX_RETRIES} 次尝试): ${shortMsg}`);
    }
  }
  throw lastError;
}

/**
 * Chat with Gemini about a specific submission (multi-turn with PDF context).
 * @param {string} pdfPath - Absolute path to student PDF
 * @param {string} systemPrompt - System instruction
 * @param {Array} chatHistory - Array of {role, content} messages
 * @param {string} userMessage - New user message
 * @param {string} [model] - Override model name
 * @returns {string} AI response text
 */
export async function chatAboutSubmission(pdfPath, systemPrompt, chatHistory, userMessage, model) {
  const ai = getAI();
  const modelName = model || currentModel;
  const pdfBuffer = readFileSync(pdfPath);
  const pdfBase64 = pdfBuffer.toString('base64');

  // Build multi-turn contents
  const contents = [];

  // First message includes PDF
  contents.push({
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
      { text: '这是学生的答卷 PDF。请根据上下文回答助教关于这份卷子的问题。' },
    ],
  });
  contents.push({
    role: 'model',
    parts: [{ text: '我已经看到了这份学生答卷。请问你想讨论哪道题？' }],
  });

  // Add chat history
  for (const msg of chatHistory) {
    contents.push({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }],
    });
  }

  // Add new message
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }],
  });

  const response = await ai.models.generateContent({
    model: modelName,
    contents,
    config: {
      systemInstruction: systemPrompt,
    },
  });

  return response.text;
}

// ── Zod Schema for structured Rubric generation ──

const RubricSubQuestionSchema = z.object({
  id: z.string().describe('小题 ID，例如 "1a", "1b", "2a" 等'),
  max_score: z.number().describe('该小题对应的分数'),
  description: z.string().describe('本题的解答要求或步骤描述'),
  key_points: z.array(z.string()).describe('评分时的核心得分点（必须非常具体）'),
  common_mistakes: z.array(z.string()).describe('以往考试或推导中可能出现的常见扣分点/错误，没有则为空数组 []'),
});

const RubricQuestionSchema = z.object({
  id: z.string().describe('大题 ID，例如 "1", "2", "3"'),
  title: z.string().describe('大题标题（简明描述题目主题，如“投球入箱”或“混合时间”）'),
  max_score: z.number().describe('该大题的满分（必须是它所有 sub_questions 满分的和）'),
  sub_questions: z.array(RubricSubQuestionSchema).describe('该大题包含的所有具体小题'),
});

const RubricSchema = z.object({
  assignment: z.string().describe('作业或考试的完整标题'),
  total_score: z.number().describe('整份作业或考试的总分（必须是所有 questions 满分的和）'),
  questions: z.array(RubricQuestionSchema).describe('包含的所有大题列表'),
});

/**
 * Automatically draft a structured rubric JSON from standard answers markdown text
 * @param {string} answersText - The text of the standard answers
 * @param {string} assignmentTitle - Expected assignment title (can be fallback if not detailed in answersText)
 * @returns {object} Drafted rubric JSON structure
 */
export async function generateRubricFromAnswers(answersText, assignmentTitle = '新作业') {
  const ai = getAI();
  const systemPrompt = `你是一位经验丰富的大学课程主讲教授和严谨的课程协调人。
你的任务是将一份手写的或标准的“参考答案与评分标准草案（Markdown格式）”转化为一个高度结构化的 \`rubric.json\`。

## 转化原则
1. **结构清晰**：将大题 (questions) 与具体小题 (sub_questions) 进行完美切割。每一道需要独立打分、独立登记成绩的题目必须被定义为一个 sub_question。
2. **分数精确**：为每个 sub_question 拆解出合理的分数。并且确保：
   - 每一个大题的 max_score 必须等于它包含的所有小题的 max_score 的总和。
   - 整个 rubric 的 total_score 必须等于所有大题的 max_score 的总和。
3. **得分点与扣分点细化**：
   - 关键得分点 (key_points)：必须是具体的数学公式、逻辑推导步骤或概念。例如 "计算出 P(E_i) = (1-1/n)^m", "应用 Markov 不等式并完成放缩"。
   - 常见错误 (common_mistakes)：根据参考答案中特别提醒的误区、或者通常学生容易疏漏的地方来总结。例如 "忘记讨论边界条件", "特征根求解计算失误"。如果参考答案没提，可以结合你的教学经验进行合理联想，或者留空数组。
4. **必须使用中文**：所有标题、描述、得分点、常见错误描述必须使用专业、学术、准确的中文。`;

  const userPrompt = `这里是标准答案与评分说明文本：
---
${answersText}
---

请参考上面的文本，并结合我们预期的标题 "${assignmentTitle}"，利用提供的 JSON Schema 架构，自动生成完整的评分标准 (Rubric JSON)。`;

  const jsonSchema = zodToJsonSchema(RubricSchema);
  if (jsonSchema && typeof jsonSchema === 'object') {
    delete jsonSchema.$schema;
    delete jsonSchema.default;
  }

  // Use gemini-3.5-flash as it is extremely fast and capable of structured translation tasks
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
      responseSchema: jsonSchema,
    },
  });

  const raw = response.text;
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const result = JSON.parse(cleaned);

  // Post-processing: Recalculate max_scores to guarantee mathematical consistency
  let calculatedTotal = 0;
  if (result.questions) {
    for (const q of result.questions) {
      let qTotal = 0;
      if (q.sub_questions) {
        for (const sq of q.sub_questions) {
          qTotal += sq.max_score || 0;
        }
      }
      q.max_score = qTotal;
      calculatedTotal += qTotal;
    }
    result.total_score = calculatedTotal;
  }

  return result;
}
