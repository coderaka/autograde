# SP-AutoGrader 📝

> 基于 Gemini CLI 的数学作业自动批改系统。助教打开终端，启动 Agent，开始改作业。

## 快速开始

### 1. 安装 Gemini CLI

```bash
npm install -g @google/gemini-cli
```

首次运行需要登录 Google 账号（免费）。

### 2. Clone 项目

```bash
git clone https://github.com/xxx/sp-autograde.git
cd sp-autograde
```

### 3. 准备作业

把学生提交的 PDF 文件放入 `submissions/hw1/` 目录：

```bash
cp ~/Downloads/hw1_submissions/*.pdf submissions/hw1/
```

### 4. (可选) 编辑评分标准

评分标准在 `rubrics/hw1/rubric.md`，你可以根据需要调整分值、增减评分点。

### 5. 启动批改

```bash
gemini
```

进入交互模式后，使用以下命令：

| 命令 | 说明 |
|------|------|
| `/grade submissions/hw1/张三.pdf` | 批改单份作业 |
| `/grade-all` | 批量批改所有未批改的作业 |
| `/summary` | 生成成绩汇总表 |

### 6. 交互式调整

批改完成后，你可以直接和 Agent 对话：

```
> 这个学生 Q2.2 用了 Jensen 不等式而不是 Cauchy-Schwarz，重新评估一下
> Q3 的 bonus 他做了但推导有一步跳得太多，帮我看看扣几分合理
> 我觉得这个得分太严了，Q1 给满分吧
```

Agent 会根据你的指令修改批改结果。

## 目录结构

```
sp-autograde/
├── GEMINI.md                  # Agent 人格 & 批改指南
├── .gemini/commands/          # 工作流命令
│   ├── grade.toml             # /grade — 批改单份
│   ├── grade-all.toml         # /grade-all — 批量批改
│   └── summary.toml           # /summary — 成绩汇总
├── rubrics/                   # 评分标准 (助教编辑)
│   └── hw1/rubric.md
├── submissions/               # 学生提交 (PDF)
│   └── hw1/
└── results/                   # 批改结果 (自动生成)
    └── hw1/
```

## 添加新作业

1. 创建新的 rubric：`rubrics/hw2/rubric.md`
2. 创建提交目录：`submissions/hw2/`
3. 创建结果目录：`results/hw2/`
4. 修改 `.gemini/commands/` 中的命令（将 `hw1` 改为 `hw2`），或直接在对话中告诉 Agent 要改哪次作业

> 💡 **提示**: 未来会支持通过命令参数指定作业编号，目前建议直接在对话中说明。

## 支持的提交格式

- ✅ 手写扫描 PDF
- ✅ LaTeX 编译的 PDF
- ✅ 打印/截图混合 PDF

Agent 使用 Gemini 的多模态能力直接阅读 PDF，无需预处理。

## License

MIT
