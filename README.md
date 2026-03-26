# AutoGrade 📝

**A Gemini CLI-powered homework grading agent.** TAs open the terminal, start the agent, and grade — just like chatting with a knowledgeable colleague.

> Built on [Gemini CLI](https://geminicli.com/). No backend code, no API keys to manage, no complex setup.

## ✨ Features

- **Multimodal grading** — reads handwritten PDF scans, photos (JPG/PNG), and Markdown submissions natively
- **Interactive review** — chat with the agent about specific grading decisions, just like talking to a human TA
- **Structured rubrics** — define scoring criteria in Markdown; the agent grades against them point by point
- **Batch processing** — grade all submissions in batches, with pause points for human review
- **Grade summaries** — auto-generate score tables with statistics (mean, median, std dev, distribution)

## 🚀 Quick Start

### Prerequisites

Install [Gemini CLI](https://geminicli.com/docs/get-started/installation):

```bash
npm install -g @google/gemini-cli
```

First-time users: run `gemini` once to authenticate with your Google account (free).

### Setup

```bash
git clone https://github.com/zchihao/autograde.git
cd autograde
```

### Prepare Your Assignment

1. **Write rubric** — create `rubrics/hw1/rubric.md` with scoring criteria (see the included example)
2. **Add submissions** — put student files into `submissions/hw1/`:
   ```bash
   cp ~/Downloads/hw1_submissions/* submissions/hw1/
   ```

### Start Grading

```bash
gemini
```

Then use these commands:

| Command | Description |
|---------|-------------|
| `/grade submissions/hw1/student.pdf` | Grade a single submission |
| `/grade-all` | Batch grade all ungraded submissions |
| `/summary` | Generate a grade summary with statistics |

### Have a Conversation

After grading, talk to the agent naturally:

```
> This student used Jensen's inequality instead of Cauchy-Schwarz in Q2.2. Re-evaluate.
> The bonus question — they attempted it but skipped a step. Should I give partial credit?
> I think Q1 was graded too harshly, give full marks.
```

The agent remembers context and can revise its grading on the fly.

## 📁 Project Structure

```
autograde/
├── GEMINI.md                  # Agent personality & grading guidelines
├── .gemini/
│   └── commands/
│       ├── grade.toml         # /grade command
│       ├── grade-all.toml     # /grade-all command
│       └── summary.toml       # /summary command
├── rubrics/                   # Grading rubrics (TA-editable)
│   └── hw1/
│       └── rubric.md          # Scoring criteria + model answers
├── submissions/               # Student submissions
│   └── hw1/
└── results/                   # Grading reports (auto-generated)
    └── hw1/
```

## 📝 Writing a Rubric

Create `rubrics/{assignment}/rubric.md`. The format is flexible, but we recommend:

```markdown
# Course HW1 — Grading Rubric

> Total: 100 points

## Q1: Problem Title (20 pts)

### Scoring Breakdown
| Item | Points | Criteria |
|------|--------|----------|
| Step 1 correct | 5 | Must include ... |
| Step 2 correct | 10 | Apply theorem X to ... |
| Final answer | 5 | Conclude that ... |

### Model Answer
[Full solution here — the agent uses this as reference]

### Common Mistakes
- [Describe typical errors and how to handle them]

## Q2: ...
```

**Key tips**:
- Be explicit about partial credit policies
- Include common mistakes so the agent handles them consistently
- The standard answer helps the agent evaluate non-standard approaches

## 📂 Supported Submission Formats

| Format | Extension | How It's Read |
|--------|-----------|---------------|
| Scanned handwriting | `.pdf` | Gemini's multimodal vision |
| LaTeX-compiled PDF | `.pdf` | Direct text + formula extraction |
| Photo of handwriting | `.jpg`, `.png` | Gemini's multimodal vision |
| Markdown with LaTeX | `.md` | Native text parsing |

All formats are read by Gemini CLI's built-in `view_file` tool — no preprocessing needed.

## 🔧 Adding a New Assignment

```bash
# 1. Create rubric
mkdir rubrics/hw2
# Write your rubric
vim rubrics/hw2/rubric.md

# 2. Create directories
mkdir -p submissions/hw2 results/hw2

# 3. Add submissions
cp ~/Downloads/hw2/*.pdf submissions/hw2/

# 4. Start grading
gemini
> /grade-all
```

## 🗺️ Roadmap

Planned enhancements for future versions:

| Feature | Description | Status |
|---------|-------------|--------|
| **Assignment argument** | `/grade --hw hw2 student.pdf` — pass assignment as argument | Planned |
| **Rubric templates** | Pre-built rubrics for common math courses (calculus, linear algebra, probability) | Planned |
| **Multi-language** | Support English and Chinese feedback switching via config | Planned |
| **Plagiarism flags** | Auto-detect suspiciously similar submissions and flag for review | Planned |
| **Grade export** | Direct export to Canvas/Blackboard CSV format | Planned |
| **Web UI** | Optional browser-based review interface for non-CLI users | Exploring |
| **Custom personas** | Let TAs define their own grading personality (strict, lenient, encouraging) | Exploring |

## 🤝 Contributing

Contributions welcome! Areas where help is particularly appreciated:

- **Rubric templates** for different courses and subjects
- **Prompt engineering** improvements to GEMINI.md and command definitions
- **Documentation** and tutorials for TAs unfamiliar with CLI tools

## ⚙️ How It Works

AutoGrade is a **zero-code** system. It leverages [Gemini CLI](https://geminicli.com/)'s native capabilities:

1. **`GEMINI.md`** — loaded automatically as the agent's system prompt, defining personality and grading rules
2. **Custom Commands** (`.gemini/commands/*.toml`) — one-click workflows that read rubrics, process submissions, and write reports
3. **`view_file` tool** — Gemini CLI's built-in tool for reading PDFs, images, and text files with full multimodal understanding
4. **Interactive conversation** — the CLI's chat interface lets TAs discuss, adjust, and override any grading decision

No API keys, no Python dependencies, no Docker containers. Just `npm install -g @google/gemini-cli` and start grading.

## License

MIT
