import 'dotenv/config';
import express from 'express';
import { join, dirname, resolve, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, existsSync, renameSync, mkdirSync, copyFileSync, unlinkSync, readFileSync } from 'fs';
import multer from 'multer';
import XLSX from 'xlsx';
import * as db from './lib/db.js';
import { initDb } from './lib/db.js';
import { gradeSubmission, buildChatSystemPrompt, loadRubric } from './lib/grading-engine.js';
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

// ── Student Identity Reconciliation ──
// After AI reads student_id and name from PDF, match against roster
// and rename the PDF file to standard format
function reconcileStudentIdentity(submissionId, aiResult) {
  const sub = db.getSubmission(submissionId);
  if (!sub) return;

  // Skip reconciliation if student already has a confirmed identity
  // (i.e. not a scan placeholder) — prevents re-grade from overwriting correct info
  if (sub.student_id && !sub.student_id.startsWith('_scan_')) return;

  const aiStudentId = aiResult.student_id;
  const aiStudentName = aiResult.student_name;

  if (!aiStudentId || aiStudentId === 'unknown') return;

  // Check if this student_id exists in roster
  let rosterStudent = db.getStudentById(aiStudentId);

  if (!rosterStudent && aiStudentName && aiStudentName !== 'unknown') {
    // Try to find by name (fuzzy: exact match for now)
    rosterStudent = db.findStudentByName(aiStudentName);
  }

  // Determine the canonical student_id
  const canonicalId = rosterStudent ? rosterStudent.id : aiStudentId;
  const canonicalName = rosterStudent ? rosterStudent.name : (aiStudentName || 'unknown');

  // Upsert student if not in roster
  if (!rosterStudent) {
    db.upsertStudent(canonicalId, canonicalName);
  }

  // Rename PDF to standard format: 学号_姓名.pdf
  const oldPdfPath = resolve(join(__dirname, 'submissions', sub.pdf_path));
  const dir = dirname(oldPdfPath);
  const newFilename = `${canonicalId}_${canonicalName}.pdf`;
  const newPdfPath = join(dir, newFilename);
  const newRelPath = join(dirname(sub.pdf_path), newFilename);

  // Only rename if different and new path doesn't exist
  if (oldPdfPath !== newPdfPath && !existsSync(newPdfPath)) {
    try {
      renameSync(oldPdfPath, newPdfPath);
      console.log(`📝 Renamed: ${basename(oldPdfPath)} → ${newFilename}`);
      db.updateSubmissionStudent(submissionId, canonicalId, newRelPath);
    } catch (err) {
      console.error(`⚠️ Failed to rename ${basename(oldPdfPath)}:`, err.message);
      db.updateSubmissionStudent(submissionId, canonicalId);
    }
  } else {
    // Just update student_id link
    db.updateSubmissionStudent(submissionId, canonicalId);
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
    reconcileStudentIdentity(sub.id, result);

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
  const dir = join(__dirname, 'submissions', assignment);
  if (!existsSync(dir)) return res.status(404).json({ error: 'Directory not found' });

  const files = readdirSync(dir).filter(f => extname(f).toLowerCase() === '.pdf');
  let imported = 0;

  for (const file of files) {
    const name = basename(file, '.pdf');
    // Try to parse student_id and name from filename: "学号_姓名.pdf"
    const parts = name.split('_');
    let studentId, studentName;

    if (parts.length >= 2) {
      studentId = parts[0];
      studentName = parts.slice(1).join('_');
    } else {
      // Unknown student — use filename as temp ID
      studentId = `_scan_${name}`;
      studentName = name;
    }

    db.upsertStudent(studentId, studentName);
    const subId = db.createSubmission(studentId, assignment, join(assignment, file));
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
    const parts = name.split('_');
    let studentId, studentName;

    if (parts.length >= 2) {
      studentId = parts[0];
      studentName = parts.slice(1).join('_');
    } else {
      studentId = `_scan_${name}`;
      studentName = name;
    }

    db.upsertStudent(studentId, studentName);
    db.createSubmission(studentId, assignment, join(assignment, safeName));
    imported++;
    results.push({ name: safeName, status: 'imported' });
  }

  console.log(`📤 Uploaded ${imported} PDFs`);
  res.json({ imported, total: req.files?.length || 0, results });
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

async function main() {
  await initDb();
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
