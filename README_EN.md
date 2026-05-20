# AutoGrade Web App 📝🎋

<p align="left">
  <a href="README.md">简体中文</a> | <b>English</b>
</p>

**AutoGrade** is a universal, multi-assignment homework grading platform powered by Node.js, SQLite, and Google Gemini 3.5. Designed with a premium **竹墨 (Bamboo Ink)** modern minimalist aesthetic, it provides a seamless dual-pane side-by-side grading view, interactive multi-turn AI chat interfaces, focused single-question regrading, and lossless JSON database restorations. It is engineered to make the grading process fluid, enjoyable, and highly efficient for TAs and instructors alike.

---

## ✨ Core Features

- 📁 **Multi-Assignment Architecture & Dynamic Discovery**: Support multiple independent assignments/exams (e.g., `midterm`, `hw1`, `quiz2`) simultaneously. Easily hot-swap between datasets via a premium dropdown selector with absolute database and storage isolation.
- 🤖 **Gemini-Powered AI Rubric Generator**: TAs simply paste or upload plain text markdown solutions and point distributions (`answers.md`). The system automatically invokes `gemini-3.5-flash` using strict Zod Schema structure to generate a high-fidelity, nested `rubric.json` outline.
- 💬 **Premium Side-by-Side Grading Pane & Grab-to-Pan**:
  - **Collapsible Sidebar**: Collapse the chat panel to `0px` with smooth CSS transitions, instantly reclaiming `340px` of screen real estate for the PDF document viewer.
  - **Grab-to-Pan Tool**: Zoom in and pan around handwritten PDF exam sheets naturally using standard click-and-drag mouse states (`cursor: grab` / `cursor: grabbing`).
  - **Live Score & Reason Editing**: Directly edit and save custom score overrides and TA comments/justifications on the fly.
- 🔄 **Isolated Sub-Question AI Regrading**: Re-evaluate *only* a specific targeted question (e.g., `1b`) using Gemini JSON mode. Click `🔄` next to the question to regrade instantly and recalculate total scores, keeping other manual grading overrides intact.
- 🛡️ **Roster Isolation & Filename Sync**:
  - Scans and uploads never pollute the official class roster database. Unidentified files are stored with `student_id = NULL` to ensure database hygiene.
  - Reconcile unlinked files against the database roster by matching IDs and resolving handwriting typos using AI. Click **“🔄 同步花名册”** to automatically update records and standardly rename matching PDF files.
- 📤 **Lossless Backup & Perfect Restoration**: Export all student grades, locking states, comments, and the full multi-turn TA-student chat logs into a single lightweight `.json` file.
  - **10MB Large Payload Capacity**: Upgraded Express body parsing limits to `10mb` (`app.use(express.json({ limit: '10mb' }));`) to support large class sizes (200+ students and transcripts) without throwing `413 Payload Too Large` errors.

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure your local machine has [Node.js](https://nodejs.org/) installed (v18+ recommended).

### 2. Clone Repository & Install Dependencies
```bash
git clone https://github.com/zchihao/autograde.git
cd autograde
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the project root directory and add your Google Gemini API Key:
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
PORT=3000
```

### 4. Start Development Server
```bash
npm run dev
```
Open your browser and navigate to: [http://localhost:3000](http://localhost:3000)

---

## 🔧 New Assignment Guide

The system supports two convenient workflows for creating new assignments:

### Approach A: Front-End UI Mode (Recommended)
1. Navigate to the dashboard homepage and click the **“➕ 新建作业”** (New Assignment) button next to the active assignment dropdown in the top toolbar.
2. Fill out the glassmorphic modal dialog:
   - **作业 Key (Assignment Key)**: A unique alphanumeric folder name (e.g., `hw1`, `quiz2`) with no spaces. This determines the physical storage directory.
   - **作业名称 (Assignment Title)**: A descriptive display title (e.g., `第一次概率论作业`).
   - **标准答案 (Answers.md)**: Paste your markdown solutions here, and click **“🤖 AI 生成标准”** (AI Generate Rubric). Gemini will automatically parse the markdown and construct the matching `rubric.json` structure. Alternatively, paste your custom JSON directly.
3. Click **“确认创建”** (Confirm). The server will dynamically create directory trees, save the files, and refresh to set your new assignment active.
4. Copy the student answer PDF files into the newly created folder:
   📂 `submissions/{assignment_key}/` (e.g. [submissions/hw1/](file:///Users/chihao/Projects/autograde/submissions/))
5. Click refresh or scan physical files on the homepage to start grading!

### Approach B: Manual Disk Layout Mode
1. In the project root, create a new subfolder in `rubrics/` with your assignment key:
   📂 `/Users/chihao/Projects/autograde/rubrics/hw2/`
2. Add your structured `rubric.json` (see [rubrics/midterm/rubric.json](file:///Users/chihao/Projects/autograde/rubrics/midterm/rubric.json) for reference) and an optional `answers.md` standard answer.
3. Create the corresponding PDF submission folder:
   📂 `/Users/chihao/Projects/autograde/submissions/hw2/`
   and copy all student PDF scans inside.
4. Refresh the browser page. The dropdown menu will automatically discover and display `hw2`.

---

## 📁 Directory Structure

```text
autograde/
├── server.js              # Express routing & 10MB JSON body-parser capacity
├── lib/
│   ├── db.js              # SQLite Database connector (Roster & Grades)
│   ├── gemini.js          # Gemini Unified SDK Interface (@google/genai)
│   └── grading-engine.js  # Dedicated grading engine (Single-question & Full-paper)
├── rubrics/               # Assignment rubric configurations
│   └── {assignment_key}/  # Subfolders representing independent assignments
│       ├── rubric.json    # Nested grading criteria JSON
│       └── answers.md     # Optional markdown solutions
├── submissions/           # Student PDF scans isolated by assignment
│   └── {assignment_key}/  # Original student answer papers
├── db/                    # Local SQLite database files
├── public/                # Premium minimalist front-end assets
│   ├── index.html         # Homepage statistics and student list dashboard
│   ├── grade.html         # Side-by-side student grading & AI chat room
│   ├── css/               # Bamboo Ink design tokens and animations
│   └── js/                # Interactivity, SSE logging, and regrade logic
├── README.md              # Chinese Documentation (Main)
└── README_EN.md           # English Documentation
```

---

## 📤 Backup & Restore

- **Export Backup**: Click **“📤 备份数据”** in the top toolbar to download a complete, lossless `.json` database snapshot containing all grades, overall TA feedback, locking states, and the full multi-turn chat transcript history.
- **Import Restore**: Click **“📥 导入备份”** and select your exported `.json` file. Even if the backup has hundreds of student records and extensive transcripts, the backend's expanded limit will seamlessly ingest, reconcile, update database records, auto-sync student details, and restore all conversation logs.
  > [!IMPORTANT]
  > Backup restoration recovers database logs and score records. It assumes that the corresponding original student PDF files are already placed inside `submissions/{assignment_key}/` on disk.

---

## ⚙️ Model Config & Development Standards

AutoGrade fully complies with the latest **Unified @google/genai SDK** guidelines. It defaults to `gemini-3.5-flash` for blazing fast responses, and permits toggling to `gemini-3.1-pro` for deep logical derivations. All structural outputs are strictly constrained under Zod schemas to ensure reliability.

---

## License

MIT License. Maintainer: Forge 🔨 (The Bamboo Grove Agent System).

---
*竹林集 🎋 · Maintained by Forge.* 🔨
