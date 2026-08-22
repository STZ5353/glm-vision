# 视觉之眼（glm-vision）

> 给没有视觉能力的大模型"加眼睛"：让纯文本模型能"看懂"图片、PDF 和 Word。

调用智谱 GLM 免费视觉模型，把本地图片 / PDF / Word / 图片 URL 转成结构化文字描述，供任何纯文本大模型理解。跨平台（Windows / macOS / Linux），零 npm——唯一要求是 bun 运行时。

本技能面向开放的 Agent Skills 标准（agentskills.io），任何实现了该标准的宿主都能安装，无论其产品形态如何。核心脚本同时是独立命令行工具，不依赖任何宿主，任何终端都能直接运行。

> English version: [README.md](README.md)。

## 能干什么

- **看图**：照片、截图、流程图、架构图、图表 → 详细文字描述
- **OCR**：逐字提取图中文字，保持排版结构
- **深度分析**：图表数据转 Markdown 表格、趋势分析、公式解读
- **反推提示词**：图片 → AI 绘画提示词（中英文输出）
- **多图对比**：多张图同一请求原生对比（图片 URL 可混用）
- **读 PDF**：内置 mupdf-wasm 逐页渲染识别、页数无上限、断点续跑
- **读 Word**：纯文本直接提取（零 API 成本、无需 Key）；含图文档三级降级链
- **SVG 源码分析与图片 URL**：直接读 SVG 源码（零图片上传），或传入 http(s) URL 由服务器下载
- **免费模型降级链**：遇限流自动退避重试并沿免费模型链切换
- **上传前预检**：存在性、格式白名单、0 字节、大小与像素（≤6000×6000）逐项检查

## 宿主兼容性

本技能遵循开放的 Agent Skills 标准。实现该标准的宿主产品形态各不相同，下面按类型分组。其他实现同一标准的宿主同样适用——把文件夹放进该宿主约定的技能目录即可。

### Agent 型工具（CLI / IDE）

模型厂商自家发布的任务执行型 Agent：

| 宿主 | 技能目录 |
|---|---|
| Claude Code | `~/.claude/skills/` |
| OpenAI Codex | `~/.agents/skills/`（全局）或 `<项目>/.agents/skills/`（单项目） |

### 桌面客户端（GUI）

内置 Agent 与技能支持的第三方聊天客户端：

| 宿主 | 技能目录 |
|---|---|
| Cherry Studio | `C:\Users\<你的用户名>\AppData\Roaming\CherryStudio\Data\Skills\` |

### 无宿主场景

核心脚本（`glm-vision.ts`）完全不依赖宿主：它是独立 bun CLI，任何终端都能运行，手动执行、脚本调用、CI 里跑，或让任何 Agent 代为执行。

## 快速开始

### 1. 获取并安装

```bash
git clone https://github.com/STZ5353/glm-vision.git
```

把整个 `glm-vision` 文件夹复制到你所用宿主的技能目录（见上方表格）。

### 2. 使用前提

| 依赖 | 说明 |
|---|---|
| bun 运行时 | 唯一运行时依赖，每台机器装一次。无需 uv、Python、npm、联网安装 |
| 智谱开放平台 API Key | 免费注册：https://open.bigmodel.cn → 控制台 → API Keys。默认模型完全免费，无需充值 |

### 3. 配置 API Key（三选一）

> ⚠️ **任何情况下都不要把 Key 写进 SKILL.md 或脚本文件里**：本仓库是公开的，Key 写进去等于泄露。

- **方式一（推荐）**：环境变量 `ZHIPU_API_KEY`（或 `GLM_API_KEY`）
- **方式二**：在技能文件夹旁新建 `.glm-vision.json`，内容 `{"apiKey": "你的Key"}`（`.gitignore` 已忽略此文件）
- **方式三**：命令行参数 `--api-key KEY`（临时用，会留在命令历史里）

### 4. 使用

**对话触发**：直接说"看下这张图 D:\照片\风景.png"，Agent 宿主会自动调用本技能。

**任意终端直接运行**：不需要任何 Agent，核心脚本就是独立命令行工具：

```bash
bun glm-vision.ts 图片.png                          # 详细描述（默认）
bun glm-vision.ts ocr 截图.png                      # OCR 文字提取
bun glm-vision.ts analyze 图表.png                  # 图表转表格、趋势分析
bun glm-vision.ts prompt 插画.jpg                   # 反推绘画提示词
bun glm-vision.ts compare 图1.png 图2.jpg           # 多图对比
bun glm-vision.ts pdf 文档.pdf                      # PDF 逐页识别
bun glm-vision.ts docx 报告.docx                    # Word 提取（纯文本零成本）
bun glm-vision.ts svg 示意图.svg                    # SVG 源码分析
bun glm-vision.ts detail "https://example.com/a.jpg"   # 图片 URL
bun glm-vision.ts detail 图片.png --question "图里有几辆车？"
```

常用参数：`--question` 自定义提问 / `--think` `--no-think` 思考开关 / `--temperature T` / `--force` 忽略缓存 / `--parallel N` PDF 并发 / `--save` 结果落盘 / `--api-key KEY` / `--help`。

限制：图片单张 ≤5MB、像素 ≤6000×6000（API 物理限制）；PDF 无页数上限、支持断点续跑。

## 版本与历史

- **默认分支（main）始终是最新稳定版**，安装只需取最新代码。
- 历史版本以 **git 标签（tag）** 留存，`git checkout <标签名>` 可随时回到任意版本；完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 技能主文件：触发规则、执行工作流、避坑指南、质疑与回应摘要 |
| `glm-vision.ts` | 主脚本（bun 单运行时，零 npm 依赖） |
| `docx-parse.ts` | Word 纯文本解析与嵌入图片抽取 |
| `render-pdf.js` | PDF 逐页渲染（内置 mupdf-wasm） |
| `docx2pdf.ps1` | Word COM 转换（Windows 可选路径） |
| `node_modules/mupdf/` | MuPDF.js 官方构建产物（AGPL-3.0，未修改，LICENSE 随包附带） |
| `evals.json` | 验证记录（含环境受限项标注） |
| `README.md` | 本文件的英文版 |

## 隐私提醒（务必阅读）

- 图片、PDF 及含图 Word 文档**会被上传到智谱服务器**进行识别（纯文本 Word 不上传）
- 证件、合同、内部资料等敏感文件，使用前请确认可接受第三方处理
- 缓存文件（`.cache/`）只含文字结果，不含图片本身

## 许可

- 本项目代码：MIT License
- 内置 mupdf.js（MuPDF.js v1.28.0）：AGPL-3.0，为官方**未修改**构建产物，其 LICENSE 随包附带于 `node_modules/mupdf/`
