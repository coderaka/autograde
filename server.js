import 'dotenv/config';
import express from 'express';
import { join, dirname, resolve, basename, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, existsSync, renameSync, mkdirSync, copyFileSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import * as db from './lib/db.js';
import { initDb } from './lib/db.js';
import { gradeSubmission, buildChatSystemPrompt, loadRubric, gradeSingleQuestion } from './lib/grading-engine.js';
import { gradeSubmissionWithCli, gradeSingleQuestionWithCli, isCliGradingModel } from './lib/cli-grading-engine.js';
import { gradeSubmissionWithPanel, PANEL_WORKFLOW } from './lib/panel-grading-engine.js';
import { chatAboutSubmission, MODELS, getCurrentModel, setCurrentModel, generateRubricFromAnswers } from './lib/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

function resolveSubmissionPdfPath(relPath) {
  const submissionsRoot = resolve(join(__dirname, 'submissions'));
  const fullPath = resolve(join(submissionsRoot, relPath));
  if (fullPath !== submissionsRoot && !fullPath.startsWith(submissionsRoot + sep)) {
    throw new Error('Invalid submission path');
  }
  return fullPath;
}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Model Config ──
app.get('/api/model', (req, res) => {
  res.json({ current: getCurrentModel(), models: MODELS });
});

app.put('/api/model', (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'Missing model name' });
  if (setCurrentModel(model)) {
    console.log(`🔄 Model switched to: ${model}`);
    res.json({ success: true, current: getCurrentModel() });
  } else {
    res.status(400).json({ error: `Unknown model: ${model}. Available: ${Object.keys(MODELS).join(', ')}` });
  }
});

async function gradeSubmissionByModel(pdfPath, assignment, modelName, options) {
  if (!MODELS[modelName]) {
    throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODELS).join(', ')}`);
  }
  if (isCliGradingModel(modelName)) {
    return gradeSubmissionWithCli(pdfPath, assignment, modelName, options);
  }
  return gradeSubmission(pdfPath, assignment, modelName, options);
}

async function gradeSingleQuestionByModel(pdfPath, questionId, assignment, modelName, options) {
  if (!MODELS[modelName]) {
    throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODELS).join(', ')}`);
  }
  if (isCliGradingModel(modelName)) {
    return gradeSingleQuestionWithCli(pdfPath, questionId, assignment, modelName, options);
  }
  return gradeSingleQuestion(pdfPath, questionId, assignment, modelName, options);
}

function getExpectedStudentForPanel(sub) {
  if (!sub?.student_id) return {};
  const isStandardId = /^\d{5,15}$/.test(sub.student_id);
  const rosterStudent = isStandardId ? db.getStudentById(sub.student_id) : null;
  if (!rosterStudent) return {};
  return { student_id: rosterStudent.id, student_name: rosterStudent.name || sub.student_name || '' };
}

function panelModelLabel() {
  return 'Panel: Gemini 3.5 Flash + AGY Gemini 3.1 Pro High -> Codex GPT-5.5 xhigh';
}

function panelStageMessage(stage) {
  const seconds = stage.elapsed_ms ? (stage.elapsed_ms / 1000).toFixed(1) + 's' : '';
  switch (stage.phase) {
    case 'panel_start': return '启动三模型仲裁流程';
    case 'initial_start': return '初评开始：' + stage.model_label;
    case 'initial_done': return '初评完成：' + stage.model_label + '，' + stage.score + '分' + (seconds ? '，' + seconds : '');
    case 'initial_error': return '初评失败：' + stage.model_label + ' — ' + stage.error;
    case 'arbitration_start': return 'Codex 仲裁开始';
    case 'arbitration_done': return 'Codex 仲裁完成，' + stage.score + '分' + (seconds ? '，' + seconds : '');
    case 'panel_done': return '三模型仲裁完成，' + stage.score + '分' + (seconds ? '，总耗时 ' + seconds : '');
    default: return stage.phase || 'panel stage';
  }
}

// ── PDF serving ──
app.get('/api/submissions/:id/pdf', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const pdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  if (!existsSync(pdfPath)) return res.status(404).json({ error: 'PDF file not found' });
  res.sendFile(pdfPath);
});

// ── Submissions CRUD ──
app.get('/api/submissions', (req, res) => {
  const assignment = req.query.assignment || null;
  res.json(db.getSubmissions(assignment));
});

app.get('/api/submissions/export-backup', (req, res) => {
  const { assignment } = req.query;
  if (!assignment) {
    return res.status(400).json({ error: 'Assignment key is required' });
  }

  try {
    // 1. Fetch assignment rubric info
    let rubric = null;
    let answers = null;
    try {
      rubric = loadRubric(assignment);
      const answersPath = join(__dirname, 'rubrics', assignment, 'answers.md');
      if (existsSync(answersPath)) {
        answers = readFileSync(answersPath, 'utf-8');
      }
    } catch (e) {
      console.warn(`Could not load rubric for export: ${assignment}`);
    }

    // 2. Fetch all submissions from database
    const submissions = db.getSubmissions(assignment);
    const backupData = [];

    for (const sub of submissions) {
      // Fetch associated chat messages
      const chatMessages = db.getChatMessages(sub.id);
      backupData.push({
        student_id: sub.student_id,
        student_name: sub.student_name,
        pdf_path: sub.pdf_path,
        status: sub.status,
        ai_grade_json: sub.ai_grade_json,
        final_grade_json: sub.final_grade_json,
        total_score: sub.total_score,
        graded_by: sub.graded_by,
        notes: sub.notes,
        chat_messages: chatMessages.map(msg => ({
          role: msg.role,
          content: msg.content,
          created_at: msg.created_at,
        })),
      });
    }

    const payload = {
      assignment,
      exported_at: new Date().toISOString(),
      rubric,
      answers,
      submissions: backupData,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${assignment}_backup_${new Date().toISOString().slice(0,10)}.json`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Export backup failed:', err);
    res.status(500).json({ error: 'Failed to export backup: ' + err.message });
  }
});

app.post('/api/submissions/import-backup', (req, res) => {
  const { backupData } = req.body;
  if (!backupData || !backupData.submissions) {
    return res.status(400).json({ error: 'Invalid backup file structure' });
  }

  const { assignment, rubric, answers, submissions } = backupData;
  if (!assignment) {
    return res.status(400).json({ error: 'Missing assignment key in backup file' });
  }

  try {
    // 1. (Optional) Restore/write rubric files if they do not exist
    const rubricDir = join(__dirname, 'rubrics', assignment);
    const submissionsDir = join(__dirname, 'submissions', assignment);
    if (!existsSync(rubricDir)) {
      mkdirSync(rubricDir, { recursive: true });
    }
    if (!existsSync(submissionsDir)) {
      mkdirSync(submissionsDir, { recursive: true });
    }

    if (rubric) {
      writeFileSync(join(rubricDir, 'rubric.json'), JSON.stringify(rubric, null, 2), 'utf-8');
    }
    if (answers) {
      writeFileSync(join(rubricDir, 'answers.md'), answers, 'utf-8');
    }

    delete _maxScoreMaps[assignment];

    let restoreCount = 0;
    let chatCount = 0;

    // 2. Loop through and restore each submission
    for (const record of submissions) {
      // Upsert student first to ensure database foreign key constraint is satisfied
      if (record.student_id && record.student_id !== 'unknown') {
        const studentName = record.student_name || 'unknown';
        db.upsertStudent(record.student_id, studentName);
      }

      // Restore submission record
      const subId = db.restoreSubmissionRecord({
        student_id: record.student_id,
        assignment: assignment,
        pdf_path: record.pdf_path,
        status: record.status,
        ai_grade_json: record.ai_grade_json,
        final_grade_json: record.final_grade_json,
        total_score: record.total_score,
        graded_by: record.graded_by,
        notes: record.notes,
      });

      restoreCount++;

      // Restore chat messages if any
      if (record.chat_messages && record.chat_messages.length > 0) {
        db.clearChatMessages(subId);
        for (const msg of record.chat_messages) {
          db.addChatMessage(subId, msg.role, msg.content);
          chatCount++;
        }
      }
    }

    // Trigger filesystem sync for the assignment to ensure any newly matched files on disk are mapped
    syncSubmissionsWithFilesystem(assignment);

    res.json({
      success: true,
      assignment,
      submissions_restored: restoreCount,
      chat_messages_restored: chatCount,
    });
  } catch (err) {
    console.error('Import backup failed:', err);
    res.status(500).json({ error: 'Failed to import backup: ' + err.message });
  }
});

app.get('/api/submissions/:id', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  // Parse JSON fields and normalize
  if (sub.ai_grade_json) sub.ai_grade = normalizeGrade(JSON.parse(sub.ai_grade_json), sub.assignment);
  if (sub.final_grade_json) sub.final_grade = normalizeGrade(JSON.parse(sub.final_grade_json), sub.assignment);
  res.json(sub);
});

// Normalize grade field names for frontend compatibility
// Rubric max scores cache by assignment key
const _maxScoreMaps = {};
function getRubricMaxScores(assignment) {
  const key = assignment || 'default';
  if (_maxScoreMaps[key]) return _maxScoreMaps[key];
  try {
    const rubricPath = join(__dirname, 'rubrics', key, 'rubric.json');
    if (!existsSync(rubricPath)) return {};
    const rubric = JSON.parse(readFileSync(rubricPath, 'utf-8'));
    const map = {};
    for (const q of rubric.questions || []) {
      for (const sq of q.sub_questions || []) {
        map[sq.id] = sq.max_score;
      }
    }
    _maxScoreMaps[key] = map;
    return map;
  } catch { return {}; }
}

function getAssignmentMaxScore(assignment) {
  try {
    const rubric = loadRubric(assignment || 'default');
    return rubric.total_score || (rubric.questions || []).reduce((sum, q) => sum + (q.max_score || 0), 0) || 100;
  } catch {
    return 100;
  }
}

function normalizeGrade(grade, assignment) {
  if (!grade || !grade.questions) return grade;
  const maxScoreMap = getRubricMaxScores(assignment);
  for (const q of grade.questions) {
    // Normalize question ID field: id | question_number | question_id → question_id
    if (!q.question_id) {
      q.question_id = q.question_number || q.id || 'unknown';
    }
    delete q.question_number;
    // Don't delete q.id — might be needed elsewhere

    // Normalize reasoning field: comments | comment | reasoning → reasoning
    if (!q.reasoning) {
      q.reasoning = q.comments || q.comment || '';
    }

    // Fill max_score from rubric if missing
    if (q.max_score === undefined || q.max_score === null) {
      q.max_score = maxScoreMap[q.question_id] || 0;
    }

    // Ensure other required fields
    if (q.error_description === undefined) {
      q.error_description = (q.awarded_score < q.max_score) ? (q.reasoning || '') : '';
    }
    // Always compute is_correct from scores (AI often gets this wrong)
    q.is_correct = q.awarded_score >= q.max_score;
    if (q.needs_review === undefined) {
      q.needs_review = false;
    }
  }
  return grade;
}

// Helper: parse student_id and name from filename
function parseFilename(name) {
  const parts = name.split('_');
  if (parts.length >= 2) {
    const possibleId = parts[0].trim();
    const possibleName = parts.slice(1).join('_').trim();
    // Validate if possibleId looks like a real standard numeric student ID (5-15 digits)
    if (/^\d{5,15}$/.test(possibleId)) {
      return { studentId: possibleId, studentName: possibleName };
    }
  }
  return { studentId: null, studentName: null };
}

// ── Student Identity Reconciliation ──
// After AI reads student_id and name from PDF, match against roster
// and rename the PDF file to standard format
function reconcileStudentIdentity(submissionId, aiResult, force = false) {
  const sub = db.getSubmission(submissionId);
  if (!sub) return;

  // Skip reconciliation if student already has a confirmed identity
  // (i.e. a standard numeric ID that matches a roster student).
  if (!force && sub.student_id) {
    const isRosterStudent = db.getStudentById(sub.student_id);
    const isStandardFormat = /^\d{5,15}$/.test(sub.student_id);
    if (isRosterStudent && isStandardFormat) {
      return;
    }
  }

  const aiStudentId = aiResult.student_id;
  const aiStudentName = aiResult.student_name;

  if (!aiStudentId || aiStudentId === 'unknown') return;

  // Check roster for ID and Name separately to resolve any conflict/typo
  let rosterStudent = null;
  const studentById = db.getStudentById(aiStudentId);
  const studentByName = aiStudentName && aiStudentName !== 'unknown' ? db.findStudentByName(aiStudentName) : null;

  if (studentById && studentByName) {
    if (studentById.id === studentByName.id) {
      rosterStudent = studentById;
    } else {
      // Conflict: AI-extracted ID matches one student, but AI-extracted Name matches another.
      // Trust the name match because digit OCR typos are extremely common in AI parsing
      // Handwritten digit OCR typos are common, so use the roster match as the authority.
      console.log(`⚠️ Identity conflict for submission ${submissionId}: AI ID matches ${studentById.name} (${studentById.id}) but AI Name matches ${studentByName.name} (${studentByName.id}). Trusting name match.`);
      rosterStudent = studentByName;
    }
  } else if (studentByName) {
    // Only Name matches a roster student (ID did not match anything)
    rosterStudent = studentByName;
  } else if (studentById) {
    // Only ID matches a roster student (Name did not match anything)
    rosterStudent = studentById;
  }

  // Only reconcile if we actually found a matching student in the roster.
  // We do NOT add new/unidentified students to the roster automatically.
  if (rosterStudent) {
    const canonicalId = rosterStudent.id;
    const canonicalName = rosterStudent.name;

    // Rename PDF to standard format: 学号_姓名.pdf (or 学号_姓名_vN.pdf if duplicates exist)
    const oldPdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
    const dir = dirname(oldPdfPath);
    
    let newFilename = `${canonicalId}_${canonicalName}.pdf`;
    let newPdfPath = join(dir, newFilename);
    let newRelPath = join(dirname(sub.pdf_path), newFilename);

    // If the file is not already correctly named and the target standard path already exists, find a unique version suffix
    if (oldPdfPath !== newPdfPath && existsSync(newPdfPath)) {
      let counter = 2;
      while (existsSync(join(dir, `${canonicalId}_${canonicalName}_v${counter}.pdf`))) {
        counter++;
      }
      newFilename = `${canonicalId}_${canonicalName}_v${counter}.pdf`;
      newPdfPath = join(dir, newFilename);
      newRelPath = join(dirname(sub.pdf_path), newFilename);
    }

    let renamed = false;
    if (oldPdfPath !== newPdfPath && !existsSync(newPdfPath)) {
      try {
        renameSync(oldPdfPath, newPdfPath);
        console.log(`📝 Renamed: ${basename(oldPdfPath)} → ${newFilename}`);
        renamed = true;
      } catch (err) {
        console.error(`⚠️ Failed to rename ${basename(oldPdfPath)}:`, err.message);
      }
    }

    // If successfully renamed or the target file already exists, update both student_id and pdf_path
    if (renamed || existsSync(newPdfPath)) {
      db.updateSubmissionStudent(submissionId, canonicalId, newRelPath);
    } else {
      db.updateSubmissionStudent(submissionId, canonicalId);
    }
  } else {
    console.log(`⚠️ No roster match found for AI extracted student ID: ${aiStudentId}, Name: ${aiStudentName}`);
  }
}

// ── SSE Event Stream ──
const sseClients = new Set();
const eventHistory = [];       // ring buffer of recent events
const MAX_HISTORY = 200;

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Replay history on connect
  for (const evt of eventHistory) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event) {
  // Save to history (ring buffer)
  eventHistory.push(event);
  if (eventHistory.length > MAX_HISTORY) eventHistory.shift();

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

// ── Manual Student Identity Update ──
app.put('/api/submissions/:id/identity', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const { student_id, student_name } = req.body;
  if (!student_id || !student_name) {
    return res.status(400).json({ error: '学号和姓名不能为空' });
  }

  // Upsert student record
  db.upsertStudent(student_id, student_name);

  // Rename PDF to standard format
  const oldPdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  const dir = dirname(oldPdfPath);
  const newFilename = `${student_id}_${student_name}.pdf`;
  const newPdfPath = join(dir, newFilename);
  const newRelPath = join(dirname(sub.pdf_path), newFilename);

  if (oldPdfPath !== newPdfPath && existsSync(oldPdfPath) && !existsSync(newPdfPath)) {
    try {
      renameSync(oldPdfPath, newPdfPath);
      console.log(`📝 Manual rename: ${basename(oldPdfPath)} → ${newFilename}`);
    } catch (err) {
      console.error(`⚠️ Failed to rename:`, err.message);
    }
  }

  // Update DB
  db.updateSubmissionStudent(sub.id, student_id, existsSync(newPdfPath) ? newRelPath : undefined);

  res.json({ success: true, student_id, student_name });
});

// ── AI Grading ──
app.post('/api/submissions/:id/ai-grade', async (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const pdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  if (!existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });

  const model = req.body.model || null; // Optional per-request model override
  const modelName = model || getCurrentModel();
  const label = sub.student_name || sub.student_id || basename(sub.pdf_path);

  try {
    db.beginAiGrading(sub.id);
    broadcast({ type: 'grading_start', id: sub.id, label, model: modelName, time: new Date().toLocaleTimeString('zh-CN') });

    const onRetry = (attempt, max, reason) => {
      broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, time: new Date().toLocaleTimeString('zh-CN') });
    };
    const result = await gradeSubmissionByModel(pdfPath, sub.assignment, modelName, { onRetry });
    db.updateAiGrade(sub.id, result);

    // Reconcile student identity from AI output
    reconcileStudentIdentity(sub.id, result, true);

    const updatedSub = db.getSubmission(sub.id);
    const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
    broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, max_score: getAssignmentMaxScore(sub.assignment), model: modelName, time: new Date().toLocaleTimeString('zh-CN') });

    res.json({ success: true, grade: result, model: modelName });
  } catch (err) {
    db.updateSubmissionStatus(sub.id, 'error');
    broadcast({ type: 'grading_error', id: sub.id, label, error: err.message, time: new Date().toLocaleTimeString('zh-CN') });
    console.error('AI grading error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── Panel Grading: parallel initial graders + Codex arbitration ──
app.post('/api/submissions/:id/panel-grade', async (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const pdfPath = resolveSubmissionPdfPath(sub.pdf_path);
  if (!existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });

  const label = sub.student_name || sub.student_id || basename(sub.pdf_path);
  const model = panelModelLabel();

  try {
    db.beginAiGrading(sub.id);
    broadcast({ type: 'grading_start', id: sub.id, label, model, time: new Date().toLocaleTimeString('zh-CN') });

    const onRetry = (attempt, max, reason) => {
      broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, time: new Date().toLocaleTimeString('zh-CN') });
    };
    const onStage = (stage) => {
      broadcast({
        type: 'panel_stage',
        id: sub.id,
        label,
        phase: stage.phase,
        message: panelStageMessage(stage),
        model: stage.model_label || model,
        score: stage.score,
        elapsed_ms: stage.elapsed_ms,
        time: new Date().toLocaleTimeString('zh-CN')
      });
    };

    const result = await gradeSubmissionWithPanel(pdfPath, sub.assignment, {
      expectedStudent: getExpectedStudentForPanel(sub),
      onRetry,
      onStage,
    });
    db.updateAiGrade(sub.id, result);
    reconcileStudentIdentity(sub.id, result, false);

    const updatedSub = db.getSubmission(sub.id);
    const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
    broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, max_score: getAssignmentMaxScore(sub.assignment), model, time: new Date().toLocaleTimeString('zh-CN') });

    res.json({ success: true, grade: result, model, workflow: PANEL_WORKFLOW });
  } catch (err) {
    db.updateSubmissionStatus(sub.id, 'error');
    broadcast({ type: 'grading_error', id: sub.id, label, error: err.message, time: new Date().toLocaleTimeString('zh-CN') });
    console.error('Panel grading error:', err);
    res.status(500).json({ error: err.message, panel_results: err.panel_results || null });
  }
});

// ── AI Single Question Grading ──
app.post('/api/submissions/:id/ai-grade-question', async (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const pdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  if (!existsSync(pdfPath)) return res.status(404).json({ error: 'PDF not found' });

  const { questionId, model } = req.body;
  if (!questionId) return res.status(400).json({ error: 'Missing questionId' });

  const modelName = model || getCurrentModel();
  const label = sub.student_name || sub.student_id || basename(sub.pdf_path);

  try {
    // Determine the active grade JSON structure
    let grade = null;
    if (sub.final_grade_json) {
      grade = JSON.parse(sub.final_grade_json);
    } else if (sub.ai_grade_json) {
      grade = JSON.parse(sub.ai_grade_json);
    }

    // Fall back to rubric-based empty skeleton if no grading exists
    if (!grade) {
      const rubric = loadRubric(sub.assignment);
      const questions = [];
      for (const q of rubric.questions || []) {
        for (const sq of q.sub_questions || []) {
          questions.push({
            question_id: sq.id,
            max_score: sq.max_score,
            awarded_score: 0,
            is_correct: false,
            error_description: '',
            reasoning: '尚未评分',
            needs_review: false
          });
        }
      }
      grade = {
        student_id: sub.student_id || 'unknown',
        student_name: sub.student_name || 'unknown',
        questions,
        total_score: 0,
        overall_comment: '初始评分'
      };
    }

    // Normalize grade questions just to be extra safe
    grade = normalizeGrade(grade, sub.assignment);

    // Broadcast SSE start
    broadcast({
      type: 'grading_start',
      id: sub.id,
      label: `${label} (第 ${questionId} 题)`,
      model: modelName,
      time: new Date().toLocaleTimeString('zh-CN')
    });

    const onRetry = (attempt, max, reason) => {
      broadcast({
        type: 'retry',
        id: sub.id,
        label: `${label} (第 ${questionId} 题)`,
        attempt,
        max,
        reason,
        time: new Date().toLocaleTimeString('zh-CN')
      });
    };

    // Call grading engine for the single question
    const result = await gradeSingleQuestionByModel(pdfPath, questionId, sub.assignment, modelName, { onRetry });

    // Locate and merge the new single-question result
    const qIdx = grade.questions.findIndex(q => q.question_id === questionId);
    if (qIdx !== -1) {
      grade.questions[qIdx] = {
        ...grade.questions[qIdx],
        ...result
      };
    } else {
      grade.questions.push(result);
    }

    // Recalculate total_score
    const calculatedTotal = grade.questions.reduce((sum, q) => sum + q.awarded_score, 0);
    grade.total_score = calculatedTotal;

    // Persist changes back to database based on status
    if (sub.final_grade_json) {
      db.updateFinalGrade(sub.id, grade, sub.graded_by || 'TA');
    } else {
      db.updateAiGrade(sub.id, grade);
    }

    const updatedSub = db.getSubmission(sub.id);
    const finalLabel = updatedSub.student_name || updatedSub.student_id || label;

    // Broadcast SSE done
    broadcast({
      type: 'grading_done',
      id: sub.id,
      label: `${finalLabel} (第 ${questionId} 题)`,
      score: grade.total_score,
      max_score: getAssignmentMaxScore(sub.assignment),
      model: modelName,
      time: new Date().toLocaleTimeString('zh-CN')
    });

    res.json({ success: true, grade, model: modelName });
  } catch (err) {
    broadcast({
      type: 'grading_error',
      id: sub.id,
      label: `${label} (第 ${questionId} 题)`,
      error: err.message,
      time: new Date().toLocaleTimeString('zh-CN')
    });
    console.error(`AI single-question grading error:`, err);
    res.status(500).json({ error: err.message });
  }
});


// Batch panel grading
app.post('/api/submissions/batch-panel-grade', async (req, res) => {
  const subs = db.getSubmissions(req.body.assignment || 'default')
    .filter(s => s.status === 'pending' || s.status === 'error');

  const model = panelModelLabel();
  broadcast({ type: 'batch_start', count: subs.length, model, time: new Date().toLocaleTimeString('zh-CN') });
  res.json({ message: 'Starting panel grading of ' + subs.length + ' submissions', count: subs.length, model, workflow: PANEL_WORKFLOW });

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const progress = String(i + 1) + '/' + String(subs.length);
    let pdfPath;
    try {
      pdfPath = resolveSubmissionPdfPath(sub.pdf_path);
    } catch (err) {
      broadcast({ type: 'grading_error', id: sub.id, label: sub.student_name || sub.student_id || sub.pdf_path, error: err.message, progress, time: new Date().toLocaleTimeString('zh-CN') });
      continue;
    }
    if (!existsSync(pdfPath)) continue;

    const label = sub.student_name || sub.student_id || basename(sub.pdf_path);
    try {
      db.beginAiGrading(sub.id);
      broadcast({ type: 'grading_start', id: sub.id, label, progress, model, time: new Date().toLocaleTimeString('zh-CN') });

      const onRetry = (attempt, max, reason) => {
        broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, progress, time: new Date().toLocaleTimeString('zh-CN') });
      };
      const onStage = (stage) => {
        broadcast({
          type: 'panel_stage',
          id: sub.id,
          label,
          progress,
          phase: stage.phase,
          message: panelStageMessage(stage),
          model: stage.model_label || model,
          score: stage.score,
          elapsed_ms: stage.elapsed_ms,
          time: new Date().toLocaleTimeString('zh-CN')
        });
      };

      const result = await gradeSubmissionWithPanel(pdfPath, sub.assignment, {
        expectedStudent: getExpectedStudentForPanel(sub),
        onRetry,
        onStage,
      });
      db.updateAiGrade(sub.id, result);
      reconcileStudentIdentity(sub.id, result, false);

      const updatedSub = db.getSubmission(sub.id);
      const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
      broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, max_score: getAssignmentMaxScore(sub.assignment), progress, model, time: new Date().toLocaleTimeString('zh-CN') });
      console.log('✅ Panel graded: ' + finalLabel + ' — ' + result.total_score + '/' + getAssignmentMaxScore(sub.assignment));
    } catch (err) {
      db.updateSubmissionStatus(sub.id, 'error');
      broadcast({ type: 'grading_error', id: sub.id, label, error: err.message, progress, time: new Date().toLocaleTimeString('zh-CN') });
      console.error('❌ Panel grading error ' + sub.pdf_path + ':', err.message);
    }
  }
  broadcast({ type: 'batch_done', count: subs.length, time: new Date().toLocaleTimeString('zh-CN') });
  console.log('Batch panel grading complete.');
});

// Batch AI grading
app.post('/api/submissions/batch-grade', async (req, res) => {
  const subs = db.getSubmissions(req.body.assignment || 'default')
    .filter(s => s.status === 'pending' || s.status === 'error');

  const model = getCurrentModel();
  broadcast({ type: 'batch_start', count: subs.length, model, time: new Date().toLocaleTimeString('zh-CN') });
  res.json({ message: `Starting batch grading of ${subs.length} submissions with ${model}`, count: subs.length });

  // Process sequentially to avoid rate limits
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const pdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
    if (!existsSync(pdfPath)) continue;

    const label = sub.student_name || sub.student_id || basename(sub.pdf_path);
    try {
      db.beginAiGrading(sub.id);
      broadcast({ type: 'grading_start', id: sub.id, label, progress: `${i + 1}/${subs.length}`, model, time: new Date().toLocaleTimeString('zh-CN') });

      const onRetry = (attempt, max, reason) => {
        broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, progress: `${i + 1}/${subs.length}`, time: new Date().toLocaleTimeString('zh-CN') });
      };
      const result = await gradeSubmissionByModel(pdfPath, sub.assignment, model, { onRetry });
      db.updateAiGrade(sub.id, result);

      // Reconcile student identity
      reconcileStudentIdentity(sub.id, result);

      const updatedSub = db.getSubmission(sub.id);
      const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
      broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, max_score: getAssignmentMaxScore(sub.assignment), progress: `${i + 1}/${subs.length}`, model, time: new Date().toLocaleTimeString('zh-CN') });
      console.log(`✅ Graded: ${finalLabel} — ${result.total_score}/${getAssignmentMaxScore(sub.assignment)}`);
    } catch (err) {
      db.updateSubmissionStatus(sub.id, 'error');
      broadcast({ type: 'grading_error', id: sub.id, label, error: err.message, progress: `${i + 1}/${subs.length}`, time: new Date().toLocaleTimeString('zh-CN') });
      console.error(`❌ Error grading ${sub.pdf_path}:`, err.message);
    }
  }
  broadcast({ type: 'batch_done', count: subs.length, time: new Date().toLocaleTimeString('zh-CN') });
  console.log('Batch grading complete.');
});

// ── TA Grade Update ──
app.put('/api/submissions/:id/grade', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const { grade, graded_by } = req.body;
  if (!grade) return res.status(400).json({ error: 'Missing grade data' });

  db.updateFinalGrade(sub.id, grade, graded_by || 'TA');
  res.json({ success: true });
});

app.put('/api/submissions/:id/finalize', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  db.finalizeSubmission(sub.id);
  res.json({ success: true });
});

// ── Chat ──
app.get('/api/submissions/:id/chat', (req, res) => {
  res.json(db.getChatMessages(Number(req.params.id)));
});

app.post('/api/submissions/:id/chat', async (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  // Save user message
  db.addChatMessage(sub.id, 'user', message);

  const pdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  const gradeJson = sub.final_grade_json || sub.ai_grade_json;
  const systemPrompt = buildChatSystemPrompt(gradeJson);
  const history = db.getChatMessages(sub.id);

  try {
    const reply = await chatAboutSubmission(pdfPath, systemPrompt, history.slice(0, -1), message);
    db.addChatMessage(sub.id, 'assistant', reply);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ──
app.get('/api/stats', (req, res) => {
  res.json(db.getStats(req.query.assignment || 'default'));
});

// ── Scan submissions directory ──
app.post('/api/scan-submissions', (req, res) => {
  const assignment = req.body.assignment || 'default';
  syncSubmissionsWithFilesystem(assignment);
  const dir = join(__dirname, 'submissions', assignment);
  if (!existsSync(dir)) return res.status(404).json({ error: 'Directory not found' });

  const files = readdirSync(dir).filter(f => extname(f).toLowerCase() === '.pdf');
  let imported = 0;

  for (const file of files) {
    const name = basename(file, '.pdf');
    const { studentId } = parseFilename(name);

    // Only link if the student actually exists in our imported roster
    const rosterStudent = studentId ? db.getStudentById(studentId) : null;
    const targetId = rosterStudent ? rosterStudent.id : null;

    const subId = db.createSubmission(targetId, assignment, join(assignment, file));
    if (subId) imported++;
  }

  res.json({ imported, total: files.length });
});

// ── Upload PDFs from client ──

const pdfUpload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB per file
app.post('/api/upload-pdfs', pdfUpload.array('pdfs', 200), (req, res) => {
  const assignment = req.body.assignment || 'default';
  const dir = join(__dirname, 'submissions', assignment);
  mkdirSync(dir, { recursive: true });

  let imported = 0;
  const results = [];

  for (const file of (req.files || [])) {
    // Use original filename, sanitize lightly
    const origName = file.originalname || `upload_${Date.now()}.pdf`;
    const safeName = origName.replace(/[\/\\]/g, '_');
    const destPath = join(dir, safeName);

    // Skip if already exists
    if (existsSync(destPath)) {
      results.push({ name: safeName, status: 'skipped', reason: '文件已存在' });
      unlinkSync(file.path); // clean temp
      continue;
    }

    // Move from temp to submissions dir
    copyFileSync(file.path, destPath);
    unlinkSync(file.path);

    // Register in DB
    const name = basename(safeName, '.pdf');
    const { studentId } = parseFilename(name);

    // Only link if the student actually exists in our imported roster
    const rosterStudent = studentId ? db.getStudentById(studentId) : null;
    const targetId = rosterStudent ? rosterStudent.id : null;

    db.createSubmission(targetId, assignment, join(assignment, safeName));
    imported++;
    results.push({ name: safeName, status: 'imported' });
  }

  console.log(`📤 Uploaded ${imported} PDFs`);
  res.json({ imported, total: req.files?.length || 0, results });
});

app.delete('/api/submissions/:id', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  try {
    const deleteFile = req.query.deleteFile !== 'false';
    let fileDeleted = false;
    let fileMissing = false;

    if (deleteFile && sub.pdf_path) {
      const pdfPath = resolveSubmissionPdfPath(sub.pdf_path);
      if (existsSync(pdfPath)) {
        unlinkSync(pdfPath);
        fileDeleted = true;
      } else {
        fileMissing = true;
      }
    }

    db.clearChatMessages(sub.id);
    db.deleteSubmission(sub.id);

    res.json({ success: true, id: sub.id, file_deleted: fileDeleted, file_missing: fileMissing });
  } catch (err) {
    console.error('Delete submission failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submissions/:id/replace-pdf', pdfUpload.single('pdf'), (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) {
    if (req.file) unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Submission not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  try {
    const assignmentDir = join(__dirname, 'submissions', sub.assignment);
    mkdirSync(assignmentDir, { recursive: true });

    const oldPdfPath = resolveSubmissionPdfPath(sub.pdf_path);
    const oldName = basename(sub.pdf_path || '');
    const uploadedName = (req.file.originalname || `replacement_${Date.now()}.pdf`).replace(/[\/\\]/g, '_');
    const targetName = oldName && extname(oldName).toLowerCase() === '.pdf' ? oldName : uploadedName;
    const targetPath = resolve(join(assignmentDir, targetName));
    const assignmentRoot = resolve(assignmentDir);
    if (targetPath !== assignmentRoot && !targetPath.startsWith(assignmentRoot + sep)) {
      throw new Error('Invalid replacement path');
    }

    copyFileSync(req.file.path, targetPath);
    unlinkSync(req.file.path);

    if (oldPdfPath !== targetPath && existsSync(oldPdfPath)) {
      unlinkSync(oldPdfPath);
    }

    const newRelPath = join(sub.assignment, targetName);
    db.clearChatMessages(sub.id);
    db.resetSubmissionForReplacement(sub.id, newRelPath);

    res.json({ success: true, id: sub.id, pdf_path: newRelPath, status: 'pending' });
  } catch (err) {
    if (req.file && existsSync(req.file.path)) unlinkSync(req.file.path);
    console.error('Replace PDF failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync roster with unmatched submissions ──
app.post('/api/sync-roster', (req, res) => {
  try {
    const assignment = req.body.assignment || 'default';
    syncSubmissionsWithFilesystem(assignment);
    const subs = db.getSubmissions(assignment);
    let updated = 0;

    for (const sub of subs) {
      // Check if this submission is already correctly linked to a confirmed roster student
      const isStandardFormat = /^\d{5,15}$/.test(sub.student_id);
      const isRosterStudent = sub.student_id ? db.getStudentById(sub.student_id) : null;
      const isConfirmed = isStandardFormat && isRosterStudent;

      if (!isConfirmed) {
        // Attempt 1: Check if the filename contains a standard ID that exists in the roster
        const filename = basename(sub.pdf_path, '.pdf');
        const { studentId } = parseFilename(filename);

        if (studentId) {
          const rosterStudent = db.getStudentById(studentId);
          if (rosterStudent) {
            const oldPdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
            const dir = dirname(oldPdfPath);
            let newFilename = `${rosterStudent.id}_${rosterStudent.name}.pdf`;
            let newPdfPath = join(dir, newFilename);
            let newRelPath = join(dirname(sub.pdf_path), newFilename);

            // If the file is not already correctly named and the target standard path already exists, find a unique version suffix
            if (oldPdfPath !== newPdfPath && existsSync(newPdfPath)) {
              let counter = 2;
              while (existsSync(join(dir, `${rosterStudent.id}_${rosterStudent.name}_v${counter}.pdf`))) {
                counter++;
              }
              newFilename = `${rosterStudent.id}_${rosterStudent.name}_v${counter}.pdf`;
              newPdfPath = join(dir, newFilename);
              newRelPath = join(dirname(sub.pdf_path), newFilename);
            }

            let renamed = false;
            if (oldPdfPath !== newPdfPath && !existsSync(newPdfPath)) {
              try {
                renameSync(oldPdfPath, newPdfPath);
                console.log(`📝 Synced & Renamed: ${basename(oldPdfPath)} → ${newFilename}`);
                renamed = true;
              } catch (err) {
                console.error(`⚠️ Failed to rename:`, err.message);
              }
            }

            if (renamed || existsSync(newPdfPath)) {
              db.updateSubmissionStudent(sub.id, rosterStudent.id, newRelPath);
            } else {
              db.updateSubmissionStudent(sub.id, rosterStudent.id);
            }
            updated++;
            continue;
          }
        }

        // Attempt 2: Check if AI grading results exist and try matching them against the roster
        const gradeJsonStr = sub.final_grade_json || sub.ai_grade_json;
        if (gradeJsonStr) {
          try {
            const grade = JSON.parse(gradeJsonStr);
            const prevStudentId = sub.student_id;

            reconcileStudentIdentity(sub.id, grade, true); // force reconciliation

            const updatedSub = db.getSubmission(sub.id);
            if (updatedSub.student_id && updatedSub.student_id !== prevStudentId) {
              updated++;
            }
          } catch (err) {
            console.error(`Error parsing grade JSON for sync of sub ${sub.id}:`, err.message);
          }
        }
      }
    }

    res.json({ success: true, updated });
  } catch (err) {
    console.error('Roster sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Import roster ──
const upload = multer({ dest: 'uploads/' });
app.post('/api/import-roster', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;
    for (const row of rows) {
      // Try common column names
      const id = row['学号'] || row['Student ID'] || row['id'];
      const name = row['姓名'] || row['Name'] || row['name'];
      const email = row['邮箱'] || row['Email'] || row['email'] || null;
      if (id && name) {
        db.upsertStudent(String(id), String(name), email ? String(email) : null);
        imported++;
      }
    }
    res.json({ imported, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Roster info ──
app.get('/api/students', (req, res) => {
  res.json(db.getStudents());
});

// ── Export ──
app.get('/api/export', (req, res) => {
  const subs = db.getSubmissions(req.query.assignment || 'default');
  const rubric = loadRubric(req.query.assignment || 'default');

  // Build export data
  const rows = subs.map(sub => {
    const grade = sub.final_grade_json
      ? JSON.parse(sub.final_grade_json)
      : (sub.ai_grade_json ? JSON.parse(sub.ai_grade_json) : null);

    const row = {
      '学号': sub.student_id,
      '姓名': sub.student_name || '',
      '状态': sub.status,
      '总分': sub.total_score || '',
    };

    // Add per-question scores
    if (grade) {
      for (const q of grade.questions) {
        row[q.question_id] = q.awarded_score;
      }
    }
    row['批改人'] = sub.graded_by || '';
    return row;
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=grades.xlsx');
  res.send(buf);
});

// ── SPA fallback ──
app.get('/grade/:id', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'grade.html'));
});

// ── Start ──
import { networkInterfaces } from 'os';

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Sync database submissions with physical files ──
function syncSubmissionsWithFilesystem(assignment = 'default') {
  console.log(`🧹 Syncing database submissions with filesystem for ${assignment}...`);
  try {
    const subs = db.getSubmissions(assignment);
    
    // 1. Delete records where the PDF file no longer exists
    for (const sub of subs) {
      const fullPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
      if (!existsSync(fullPath)) {
        console.log(`🗑️ PDF not found on disk, deleting DB record: ${sub.pdf_path} (ID: ${sub.id})`);
        db.deleteSubmission(sub.id);
      }
    }

    // Reload subs after deletion
    const activeSubs = db.getSubmissions(assignment);

    // 2. Resolve duplicates (same student_id, same assignment)
    // If we have multiple entries for the same student on the same assignment:
    // - Keep the graded one ('reviewed' or 'ai_graded')
    // - If both are the same status, keep the one with the larger ID
    const studentMap = {}; // student_id -> list of subs
    for (const sub of activeSubs) {
      if (sub.student_id) {
        if (!studentMap[sub.student_id]) {
          studentMap[sub.student_id] = [];
        }
        studentMap[sub.student_id].push(sub);
      }
    }

    for (const studentId in studentMap) {
      const list = studentMap[studentId];
      if (list.length > 1) {
        list.sort((a, b) => {
          const scoreA = a.status === 'reviewed' ? 3 : (a.status === 'ai_graded' ? 2 : 1);
          const scoreB = b.status === 'reviewed' ? 3 : (b.status === 'ai_graded' ? 2 : 1);
          if (scoreA !== scoreB) return scoreB - scoreA;
          return b.id - a.id;
        });

        // Keep index 0, delete the rest
        const toDelete = list.slice(1);
        for (const del of toDelete) {
          console.log(`🗑️ Duplicate student submission, deleting DB record: ${del.pdf_path} (ID: ${del.id})`);
          db.deleteSubmission(del.id);
        }
      }
    }
  } catch (err) {
    console.error('Error during database-filesystem sync:', err);
  }
}

// ── Multi-Assignment & Backup APIs ──

app.get('/api/assignments', (req, res) => {
  try {
    const rubricsDir = join(__dirname, 'rubrics');
    if (!existsSync(rubricsDir)) {
      return res.json([]);
    }

    const items = readdirSync(rubricsDir, { withFileTypes: true });
    const assignments = [];

    for (const item of items) {
      if (item.isDirectory()) {
        const key = item.name;
        const rubricPath = join(rubricsDir, key, 'rubric.json');
        if (existsSync(rubricPath)) {
          try {
            const rubric = JSON.parse(readFileSync(rubricPath, 'utf-8'));
            const subQuestionsCount = (rubric.questions || []).reduce(
              (sum, q) => sum + (q.sub_questions || []).length, 0
            );
            assignments.push({
              key,
              title: rubric.assignment || key,
              total_score: rubric.total_score || 0,
              questions_count: subQuestionsCount,
              has_answers: existsSync(join(rubricsDir, key, 'answers.md')),
            });
          } catch (e) {
            console.error(`Error reading rubric for assignment ${key}:`, e);
          }
        }
      }
    }

    // Sort assignments alphabetically
    assignments.sort((a, b) => a.key.localeCompare(b.key));

    res.json(assignments);
  } catch (err) {
    console.error('Error fetching assignments:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

app.post('/api/assignments', (req, res) => {
  const { key, title, rubric, answers } = req.body;
  if (!key || !title || !rubric) {
    return res.status(400).json({ error: 'Missing required fields: key, title, and rubric are mandatory.' });
  }

  // Format validation for key (alphanumeric, dash, underscore only)
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return res.status(400).json({ error: 'Invalid assignment key. Only alphanumeric characters, dashes, and underscores are allowed.' });
  }

  try {
    const rubricDir = join(__dirname, 'rubrics', key);
    const submissionsDir = join(__dirname, 'submissions', key);

    // Create directories if they don't exist
    if (!existsSync(rubricDir)) {
      mkdirSync(rubricDir, { recursive: true });
    }
    if (!existsSync(submissionsDir)) {
      mkdirSync(submissionsDir, { recursive: true });
    }

    // Save rubric.json
    // Ensure assignment title is synchronized in rubric.json
    const rubricObj = typeof rubric === 'string' ? JSON.parse(rubric) : rubric;
    rubricObj.assignment = title;
    writeFileSync(join(rubricDir, 'rubric.json'), JSON.stringify(rubricObj, null, 2), 'utf-8');

    // Save answers.md if provided
    if (answers !== undefined) {
      writeFileSync(join(rubricDir, 'answers.md'), answers || '', 'utf-8');
    }

    // Clear maxScoreMaps cache for this assignment key to force reload
    delete _maxScoreMaps[key];

    // Trigger dynamic sync right away
    syncSubmissionsWithFilesystem(key);

    res.json({ success: true, key });
  } catch (err) {
    console.error('Error creating assignment:', err);
    res.status(500).json({ error: 'Failed to create assignment: ' + err.message });
  }
});

app.post('/api/assignments/generate-rubric', async (req, res) => {
  const { answers, title } = req.body;
  if (!answers) {
    return res.status(400).json({ error: 'Standard answers text (markdown) is required.' });
  }

  try {
    const rubric = await generateRubricFromAnswers(answers, title || '新作业');
    res.json(rubric);
  } catch (err) {
    console.error('AI rubric generation failed:', err);
    res.status(500).json({ error: 'AI Rubric Generation failed: ' + err.message });
  }
});

async function main() {
  await initDb();
  
  // Sync database with filesystem for all discovered assignments
  const rubricsDir = join(__dirname, 'rubrics');
  if (existsSync(rubricsDir)) {
    try {
      const items = readdirSync(rubricsDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory() && existsSync(join(rubricsDir, item.name, 'rubric.json'))) {
          syncSubmissionsWithFilesystem(item.name);
        }
      }
    } catch (err) {
      console.error('Error syncing assignments on startup:', err);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎓 AutoGrade v2 running at http://localhost:${PORT}`);
    console.log(`   LAN access: http://${getLocalIP()}:${PORT}`);
    console.log(`   Model: ${getCurrentModel()}\n`);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
