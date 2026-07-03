# AutoGrade

AutoGrade is a local web app for AI-assisted exam and homework grading. It combines roster-aware PDF management, rubric-based structured grading, side-by-side manual review, and optional multi-model arbitration.

The app is designed to keep student submissions, rosters, grades, databases, and course-specific answer keys local by default.

## Features

- Multi-assignment dashboard with isolated rubric, submission, and grade data per assignment.
- Roster import from Excel and roster-based identity matching.
- PDF upload, filesystem scan, submission deletion, and PDF replacement.
- Side-by-side grading view with PDF navigation, editable scores, comments, and finalization.
- Structured rubric grading with Gemini API models.
- Optional CLI graders through Codex CLI and AGY CLI.
- Panel grading workflow: Gemini 3.5 Flash and AGY Gemini 3.1 Pro High run initial grading in parallel, then Codex GPT-5.5 xhigh arbitrates.
- Single-question regrading for targeted review.
- JSON backup and restore for assignment state.
- Export to spreadsheet-friendly rows with per-question scores.

## Privacy

Do not commit private course or student data. The repository is configured to ignore:

- `.env`
- `db/*.db` and database backups
- `submissions/`
- course-specific `rubrics/<assignment>/` folders
- `uploads/`
- generated `results/`

Only generic system code and templates should be committed. Keep real rosters, student PDFs, grading databases, answer keys, assignment rubrics, and alias maps local.

## Requirements

- Node.js 18+
- A Gemini API key for API-based grading
- Optional: Codex CLI for Codex arbitration
- Optional: AGY CLI for AGY-backed grading
- Optional: Poppler `pdftoppm` available on PATH for CLI image rendering

## Setup

```bash
git clone https://github.com/coderaka/autograde.git
cd autograde
npm install
```

Create `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
PORT=3000

# Optional CLI paths if they are not on PATH
CODEX_CLI_PATH=/path/to/codex
AGY_CLI_PATH=/path/to/agy
PDFTOPPM_PATH=/path/to/pdftoppm

# Optional CLI tuning
CLI_GRADING_RENDER_DPI=160
CLI_GRADING_MAX_PAGES=32
CLI_GRADING_TIMEOUT_MS=1200000
AGY_PRINT_TIMEOUT=20m
```

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For production-like local use:

```bash
npm start
```

## Basic Workflow

1. Import the student roster from Excel. Supported column names include `学号`, `Student ID`, `id`, `姓名`, `Name`, and `name`.
2. Create or select an assignment.
3. Add a rubric under `rubrics/<assignment>/rubric.json`. An optional `answers.md` can be used locally for grading context.
4. Upload PDFs through the UI or place them in `submissions/<assignment>/` and scan.
5. Run panel grading or single-model grading.
6. Review the AI result, edit scores/comments, and finalize when ready.
7. Export grades or create a backup JSON.

## Assignment Files

A rubric has this shape:

```json
{
  "assignment": "Example Exam",
  "total_score": 100,
  "questions": [
    {
      "id": "section_id",
      "title": "Section title",
      "max_score": 25,
      "sub_questions": [
        {
          "id": "question_id",
          "max_score": 10,
          "description": "What to grade",
          "key_points": ["Expected point 1", "Expected point 2"],
          "common_mistakes": ["Common mistake"]
        }
      ]
    }
  ]
}
```

Use `rubrics/rubric_template.json` as a starting point.

### Question Alias Maps

If an exam has multiple versions with the same questions in different orders, keep a local alias file at:

```text
rubrics/<assignment>/aliases.json
```

Example:

```json
{
  "default_variant": "A",
  "variant_markers": {
    "A": ["2d"],
    "B": ["3d"]
  },
  "variants": {
    "A": {
      "1a": "canonical_question_id"
    },
    "B": {
      "2a": "canonical_question_id"
    }
  }
}
```

Alias files are intentionally ignored by git because they are course-specific.

## Grading Modes

### Panel Grading

Panel grading is the recommended workflow for high-stakes exams:

1. Gemini 3.5 Flash performs an initial grade through the Gemini API.
2. AGY Gemini 3.1 Pro High performs an independent initial grade through the local AGY CLI.
3. Codex GPT-5.5 xhigh reads the PDF, rubric, reference context, and both initial grades, then produces the final arbitration result.

Within one submission, the two initial graders run in parallel. Batch grading processes submissions sequentially by design, which is slower but safer for local CLI resources and API limits.

### Single-Question Regrading

In the grading view, each question can be regraded independently. This is useful after a manual review finds one suspicious sub-question.

## Roster and Identity Matching

AutoGrade can identify submissions through three mechanisms:

- Filename parsing, typically `student_id_name.pdf`.
- AI-extracted name and student ID from the first page of the PDF.
- Manual identity edits in the UI.

The roster is authoritative. If AI output conflicts with the roster, the system prefers roster matches and avoids creating new student records from noisy OCR.

## Backups and Exports

- Backup exports preserve grading JSON, final scores, notes, status, and chat messages for the selected assignment.
- Restore imports those records back into the local database.
- Grade export produces rows with student identity, status, total score, and per-question scores.

Backups may contain private student data and should not be committed.

## Development Checks

```bash
node --check server.js
node --check lib/gemini.js
node --check lib/grading-engine.js
node --check lib/cli-grading-engine.js
node --check lib/panel-grading-engine.js
```

## License

MIT
