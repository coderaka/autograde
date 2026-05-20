import 'dotenv/config';
import express from 'express';
import { join, dirname, resolve, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, existsSync, renameSync, mkdirSync, copyFileSync, unlinkSync, readFileSync } from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import * as db from './lib/db.js';
import { initDb } from './lib/db.js';
import { gradeSubmission, buildChatSystemPrompt, loadRubric, gradeSingleQuestion } from './lib/grading-engine.js';
import { chatAboutSubmission, MODELS, getCurrentModel, setCurrentModel } from './lib/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
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

app.get('/api/submissions/:id', (req, res) => {
  const sub = db.getSubmission(Number(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  // Parse JSON fields and normalize
  if (sub.ai_grade_json) sub.ai_grade = normalizeGrade(JSON.parse(sub.ai_grade_json));
  if (sub.final_grade_json) sub.final_grade = normalizeGrade(JSON.parse(sub.final_grade_json));
  res.json(sub);
});

// Normalize grade field names for frontend compatibility
// Rubric max scores lookup
const _maxScoreMap = buildMaxScoreMap();
function buildMaxScoreMap() {
  try {
    const rubricPath = join(__dirname, 'rubrics', 'midterm', 'rubric.json');
    if (!existsSync(rubricPath)) return {};
    const rubric = JSON.parse(readFileSync(rubricPath, 'utf-8'));
    const map = {};
    for (const q of rubric.questions || []) {
      for (const sq of q.sub_questions || []) {
        map[sq.id] = sq.max_score;
      }
    }
    return map;
  } catch { return {}; }
}

function normalizeGrade(grade) {
  if (!grade || !grade.questions) return grade;
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
      q.max_score = _maxScoreMap[q.question_id] || 0;
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
      // (e.g. 524030910186 vs 524030910196).
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
    db.updateSubmissionStatus(sub.id, 'grading');
    broadcast({ type: 'grading_start', id: sub.id, label, model: modelName, time: new Date().toLocaleTimeString('zh-CN') });

    const onRetry = (attempt, max, reason) => {
      broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, time: new Date().toLocaleTimeString('zh-CN') });
    };
    const result = await gradeSubmission(pdfPath, sub.assignment, model, { onRetry });
    db.updateAiGrade(sub.id, result);

    // Reconcile student identity from AI output
    reconcileStudentIdentity(sub.id, result, true);

    const updatedSub = db.getSubmission(sub.id);
    const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
    broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, model: modelName, time: new Date().toLocaleTimeString('zh-CN') });

    res.json({ success: true, grade: result, model: modelName });
  } catch (err) {
    db.updateSubmissionStatus(sub.id, 'error');
    broadcast({ type: 'grading_error', id: sub.id, label, error: err.message, time: new Date().toLocaleTimeString('zh-CN') });
    console.error('AI grading error:', err);
    res.status(500).json({ error: err.message });
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
    grade = normalizeGrade(grade);

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
    const result = await gradeSingleQuestion(pdfPath, questionId, sub.assignment, modelName, { onRetry });

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

// Batch AI grading
app.post('/api/submissions/batch-grade', async (req, res) => {
  const subs = db.getSubmissions(req.body.assignment || 'midterm')
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
      db.updateSubmissionStatus(sub.id, 'grading');
      broadcast({ type: 'grading_start', id: sub.id, label, progress: `${i + 1}/${subs.length}`, model, time: new Date().toLocaleTimeString('zh-CN') });

      const onRetry = (attempt, max, reason) => {
        broadcast({ type: 'retry', id: sub.id, label, attempt, max, reason, progress: `${i + 1}/${subs.length}`, time: new Date().toLocaleTimeString('zh-CN') });
      };
      const result = await gradeSubmission(pdfPath, sub.assignment, null, { onRetry });
      db.updateAiGrade(sub.id, result);

      // Reconcile student identity
      reconcileStudentIdentity(sub.id, result);

      const updatedSub = db.getSubmission(sub.id);
      const finalLabel = updatedSub.student_name || updatedSub.student_id || label;
      broadcast({ type: 'grading_done', id: sub.id, label: finalLabel, score: result.total_score, progress: `${i + 1}/${subs.length}`, time: new Date().toLocaleTimeString('zh-CN') });
      console.log(`✅ Graded: ${finalLabel} — ${result.total_score}/120`);
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
  res.json(db.getStats(req.query.assignment || 'midterm'));
});

// ── Scan submissions directory ──
app.post('/api/scan-submissions', (req, res) => {
  const assignment = req.body.assignment || 'midterm';
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
  const assignment = req.body.assignment || 'midterm';
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

// ── Sync roster with unmatched submissions ──
app.post('/api/sync-roster', (req, res) => {
  try {
    const assignment = req.body.assignment || 'midterm';
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
  const subs = db.getSubmissions(req.query.assignment || 'midterm');
  const rubric = loadRubric(req.query.assignment || 'midterm');

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
function syncSubmissionsWithFilesystem(assignment = 'midterm') {
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

async function main() {
  await initDb();
  syncSubmissionsWithFilesystem('midterm');
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
