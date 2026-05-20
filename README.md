# AutoGrade Web App 📝🎋

**AutoGrade** 是一个基于 Node.js, SQLite 与 Google Gemini 3.5 的通用化多作业智能批改系统。它拥有极佳的**竹墨 (Bamboo Ink)** 现代极简设计，提供双栏并排的 PDF 阅卷视窗、多轮 AI 交互对话框、单题重评、无损 JSON 恢复等高级批改功能，致力于让助教和教师的阅卷体验流畅、愉悦而高效。

---

## ✨ 核心特性

- 📁 **多作业架构与动态发现 (Multi-Assignment Architecture)**：支持多个独立作业/考试（如 `midterm`, `hw1`, `quiz2`）并存，通过顶部下拉栏无缝热切换，实现完全的数据和物理文件隔离。
- 🤖 **Gemini 驱动 AI 评分规约生成器 (AI Rubric Generator)**：助教只需粘贴/上传 Markdown 格式的标准答案和分值说明（`answers.md`），系统便能自动调用 `gemini-3.5-flash` 通过 strict Zod Schema 生成结构严密的 `rubric.json` 指标树。
- 💬 **双栏交互批改与拖拽平移 (Side-by-side Grading Pane & Grab-to-Pan)**：
  - **折叠式侧边栏**：支持一键隐藏聊天栏，释放 340px 的宝贵桌面空间给 PDF 试卷。
  - **鼠标拖拽抓手**：开启 Grab-to-Pan（抓手平移）功能，可随意拖拽放大后的手写试卷，体验极其顺滑。
  - **修改评分与理由**：助教不仅能直接改分，还可以实时编辑和保存手写的修改理由与评语。
- 🔄 **单题 AI 隔离重评 (Isolated Sub-Question Regrading)**：无需重新批改整份卷子，点击某道具体小题（如 `1b`）旁的 `🔄` 按钮，即可瞬间单独评阅并更新总分。
- 🛡️ **花名册隔离保护与自动同步 (Roster Isolation & Sync)**：
  - 手写姓名不匹配的试卷导入时自动关联 `student_id = NULL`，确保主花名册不受脏数据污染。
  - 支持文件名匹配与智能 AI TYPO 容错纠错匹配，点击 **“🔄 同步花名册”** 自动完成数据库关联与物理文件重命名。
- 📤 **无损打包备份与完美还原 (Lossless Backup & Restore)**：支持一键将特定作业的全部成绩、评语、锁定状态及完整的 TA 对话记录导出为单个 `.json` 文件。针对班级量大时的接口超载，后端已打通 **`10mb` 极限容量限额**，支持 200 人以上的大体量对话完美恢复。

---

## 🚀 快速启动

### 1. 环境准备
确保你的本地环境已安装 [Node.js](https://nodejs.org/) (建议版本 v18+)。

### 2. 获取代码与安装依赖
```bash
git clone https://github.com/zchihao/autograde.git
cd autograde
npm install
```

### 3. 配置环境变量
在项目根目录下新建 `.env` 文件，并填入你的 Google Gemini API Key：
```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
PORT=3000
```

### 4. 启动开发服务器
```bash
npm run dev
```
启动后，在浏览器访问：[http://localhost:3000](http://localhost:3000)

---

## 🔧 新建作业指南 (How to New Assignment)

为了提供极高的自由度，系统同时支持 **界面快速创建** 和 **物理磁盘管理** 两种方案：

### 方案 A：在前端 UI 快速创建 (推荐)
1. 访问首页，点击顶部栏“当前作业”下拉菜单右侧的 **“➕ 新建作业”** 按钮。
2. 在磨砂玻璃对话框中填写：
   - **作业 Key**：拼音或英文唯一名称（如 `hw1`），不可有中文或空格，它将对应物理文件夹。
   - **作业名称**：中文显示标题（如 `第一次概率论作业`）。
   - **标准答案 (Answers.md)**：将你的标准答案与得分规则 Markdown 直接粘贴在此，然后点击 **“🤖 AI 生成标准”**。Gemini 会自动生成对应的 `rubric.json` 分值树。当然，你也可以直接粘贴 JSON。
3. 点击 **“确认创建”**，系统会自动在后台建立文件夹并热加载。
4. 将学生作业的 PDF 文件，拷贝放入项目中的：
   📂 `submissions/{作业Key}/` (例如：[submissions/hw1/](file:///Users/chihao/Projects/autograde/submissions/))
5. 回到浏览器刷新或点击“扫描物理文件”即可开始评卷！

### 方案 B：在本地磁盘直接放置
1. 在项目根目录的 `rubrics/` 文件夹下新建作业名称目录（如 `hw2`）：
   📂 `/Users/chihao/Projects/autograde/rubrics/hw2/`
2. 放入 `rubric.json`（可参考 [rubrics/midterm/rubric.json](file:///Users/chihao/Projects/autograde/rubrics/midterm/rubric.json) 格式）和可选的 `answers.md`。
3. 建立物理 PDF 文件夹：
   📂 `/Users/chihao/Projects/autograde/submissions/hw2/`
   并放入学生的答卷。
4. 刷新网页，下拉菜单中将自动出现 `hw2` 选项。

---

## 📁 目录结构

```text
autograde/
├── server.js              # Express 核心路由与 10MB JSON 大体量解析层
├── lib/
│   ├── db.js              # SQLite 数据库接口 (学生花名册与成绩关联)
│   ├── gemini.js          # Gemini 统一 SDK 交互接口 (@google/genai)
│   └── grading-engine.js  # 批改逻辑引擎 (支持单题与全卷批改)
├── rubrics/               # 作业评分标准目录
│   └── {assignment_key}/  # 每一个子文件夹代表一个独立的作业
│       ├── rubric.json    # AI 自动生成或手工编写的得分规约
│       └── answers.md     # 作业的标准答案
├── submissions/           # 学生物理 PDF 存储库 (由 assignment_key 隔离)
│   └── {assignment_key}/  # 学生答卷原件
├── db/                    # 本地 SQLite 数据库文件
├── public/                # 极简竹墨 (Bamboo Ink) 双主题前端
│   ├── index.html         # 成绩汇总看板与统计中心
│   ├── grade.html         # 双栏评卷及多轮 AI 对话操作间
│   ├── css/               # 精心调制的配色及平移折叠动画库
│   └── js/                # 批改、Regrade 与前端交互控制逻辑
└── README.md              # 说明文档
```

---

## 📤 备份与还原 (Backup & Perfect Restore)

- **备份**：点击首页顶部栏 **“📤 备份数据”**，系统会将当前所选作业的**所有成绩、修改理由、锁定状态以及所有的多轮 TA 聊天对话树**，无损打包导出为一个 `.json` 文件并下载。
- **还原**：点击 **“📥 导入备份”**，选择之前导出的 JSON 文件。即便该备份中包含上百人且有海量文本记录，系统也会通过后台的高容额解析管道瞬间更新数据库、自动补齐缺失的学生主信息，并完美还原所有评分与会话历史。
  > [!IMPORTANT]
  > 还原操作仅覆盖逻辑数据库中的打分和对话，它假设物理 PDF 文件已经预先存放在对应作业的 `submissions/{key}/` 文件夹中。

---

## ⚙️ 模型配置与开发标准

本系统完全遵守最新的 **Unified @google/genai SDK** 开发规范，默认采用 `gemini-3.5-flash` 提供闪电般迅捷的响应，同时支持无缝切换至更擅长精细逻辑推导的 `gemini-3.1-pro` 族系模型。所有的结构化指标分析都基于 Zod Schema 完成约束，具备极高的鲁棒性。

---

## 开源协议

MIT License. Maintainer: Forge 🔨 (The Bamboo Grove Agent System).

---
*竹林集 🎋 · Maintained by Forge.* 🔨
