import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'fs';

let ai;

// Available models for grading
export const MODELS = {
  'gemini-3.1-pro-preview': { label: 'Gemini 3.1 Pro (Preview)', tier: 'pro' },
  'gemini-3-flash-preview': { label: 'Gemini 3 Flash (Preview)', tier: 'fast' },
};

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

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
          responseFormat: {
            text: {
              mimeType: 'application/json',
              schema: jsonSchema,
            },
          },
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
