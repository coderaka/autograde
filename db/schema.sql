CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT REFERENCES students(id),
  assignment TEXT NOT NULL DEFAULT 'default',
  pdf_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ai_grade_json TEXT,
  final_grade_json TEXT,
  total_score REAL,
  graded_by TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignment);
CREATE INDEX IF NOT EXISTS idx_chat_submission ON chat_messages(submission_id);
