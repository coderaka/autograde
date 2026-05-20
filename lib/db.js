import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'db', 'autograde.db');
const SCHEMA_PATH = join(__dirname, '..', 'db', 'schema.sql');

let db;

export async function initDb() {
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.run(schema);
  saveDb();
  return db;
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// Helper: run a query and return all rows as objects
function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: run a query and return the first row
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// Helper: execute a statement
function run(sql, params = []) {
  getDb().run(sql, params);
  saveDb();
}

// ── Students ──

export function upsertStudent(id, name, email = null) {
  run(`INSERT INTO students (id, name, email) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email`,
    [id, name, email]);
}

export function getStudents() {
  return all('SELECT * FROM students ORDER BY id');
}

// ── Submissions ──

export function createSubmission(studentId, assignment, pdfPath) {
  const existing = get(
    'SELECT id FROM submissions WHERE student_id = ? AND assignment = ?',
    [studentId, assignment]
  );
  if (existing) return existing.id;

  run('INSERT INTO submissions (student_id, assignment, pdf_path) VALUES (?, ?, ?)',
    [studentId, assignment, pdfPath]);

  const result = get('SELECT last_insert_rowid() as id');
  return result.id;
}

export function getSubmissions(assignment = null) {
  if (assignment) {
    return all(`
      SELECT s.*, st.name as student_name
      FROM submissions s LEFT JOIN students st ON s.student_id = st.id
      WHERE s.assignment = ? ORDER BY st.name, s.id`, [assignment]);
  }
  return all(`
    SELECT s.*, st.name as student_name
    FROM submissions s LEFT JOIN students st ON s.student_id = st.id
    ORDER BY st.name, s.id`);
}

export function getSubmission(id) {
  return get(`
    SELECT s.*, st.name as student_name
    FROM submissions s LEFT JOIN students st ON s.student_id = st.id
    WHERE s.id = ?`, [id]);
}

export function updateAiGrade(id, gradeJson) {
  const total = gradeJson.total_score;
  run(`UPDATE submissions
       SET ai_grade_json = ?, total_score = ?, status = 'ai_graded', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    [JSON.stringify(gradeJson), total, id]);
}

export function updateFinalGrade(id, gradeJson, gradedBy) {
  const total = gradeJson.total_score;
  run(`UPDATE submissions
       SET final_grade_json = ?, total_score = ?, status = 'reviewed', graded_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    [JSON.stringify(gradeJson), total, gradedBy, id]);
}

export function finalizeSubmission(id) {
  run(`UPDATE submissions SET status = 'finalized', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
}

export function updateSubmissionStatus(id, status) {
  run(`UPDATE submissions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, id]);
}

export function updateSubmissionStudent(id, studentId, pdfPath = null) {
  if (pdfPath) {
    run(`UPDATE submissions SET student_id = ?, pdf_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [studentId, pdfPath, id]);
  } else {
    run(`UPDATE submissions SET student_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [studentId, id]);
  }
}

export function findStudentByName(name) {
  return get('SELECT * FROM students WHERE name = ?', [name]);
}

export function getStudentById(id) {
  return get('SELECT * FROM students WHERE id = ?', [id]);
}

// ── Chat ──

export function addChatMessage(submissionId, role, content) {
  run('INSERT INTO chat_messages (submission_id, role, content) VALUES (?, ?, ?)',
    [submissionId, role, content]);
  const result = get('SELECT last_insert_rowid() as id');
  return result.id;
}

export function getChatMessages(submissionId) {
  return all('SELECT * FROM chat_messages WHERE submission_id = ? ORDER BY created_at', [submissionId]);
}

// ── Stats ──

export function getStats(assignment = 'midterm') {
  const total = get(
    'SELECT COUNT(*) as count FROM submissions WHERE assignment = ?', [assignment]
  ).count;

  const byStatus = all(`
    SELECT status, COUNT(*) as count FROM submissions
    WHERE assignment = ? GROUP BY status`, [assignment]);

  const scores = all(`
    SELECT total_score FROM submissions
    WHERE assignment = ? AND total_score IS NOT NULL`, [assignment])
    .map(r => r.total_score);

  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

  return {
    total,
    byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
    avgScore: Math.round(avg * 10) / 10,
    medianScore: median,
    maxScore: scores.length > 0 ? Math.max(...scores) : 0,
    minScore: scores.length > 0 ? Math.min(...scores) : 0,
  };
}
