# Vision Eye (glm-vision)

> Give "eyes" to LLMs without vision: let plain-text models "see" images and PDFs.

Uses Zhipu GLM's free vision models to turn local images / PDFs into structured text descriptions that any text-only LLM can understand. Cross-platform (Windows / macOS / Linux). The only requirements are the bun runtime (main script) and uv (PDF rendering).

The skill targets the open Agent Skills standard (agentskills.io), so it plugs into any host that implements it, regardless of product form. The core script also works as a plain CLI from any shell, with or without an agent.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## What it can do

- **Image understanding** — photos, screenshots, flowcharts, architecture diagrams, charts → detailed text descriptions
- **OCR** — verbatim text extraction while preserving layout structure
- **Deep analysis** — chart data to Markdown tables, trend analysis, formula interpretation
- **Image2Prompt** — reverse-engineer AI painting prompts from images, output in Chinese and English
- **PDF reading** — page-by-page rendering and recognition (up to 20 pages per PDF, 3 PDFs per run)
- **Resumable runs** — per-page cache: reruns skip pages already recognized and only fill in the failures
- **Reasoning toggle** — `--think` / `--no-think`, with sensible per-mode defaults
- **Rate-limit handling** — automatic backoff retries (2×), 120-second timeouts, per-image isolation so one failure never stalls the rest

## Host compatibility

The skill follows the open Agent Skills standard. Hosts that implement it come in different product forms — grouped below by kind. Any other host implementing the same standard works the same way: drop the folder into that host's skills directory.

### Agent tools (CLI / IDE)

Task-running agents, distributed by the model vendors themselves:

| Host | Skills directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| OpenAI Codex | `~/.agents/skills/` (all projects) or `<repo>/.agents/skills/` (one project) |

### Desktop clients (GUI)

Third-party chat clients with built-in agent and skill support:

| Host | Skills directory |
|---|---|
| Cherry Studio | `C:\Users\<you>\AppData\Roaming\CherryStudio\Data\Skills\` |

### No host at all

The core script (`glm-vision.ts`) needs no host: it is a plain bun CLI that runs from any terminal — by hand, from scripts, from CI, or on behalf of any agent.

## Quick start

### 1. Get it and install

```bash
git clone https://github.com/STZ5353/glm-vision.git
```

Copy the whole `glm-vision` folder into your host's skills directory (see the tables above).

### 2. Prerequisites

| Dependency | Notes |
|---|---|
| bun runtime | Runs the main script — install once per machine |
| uv runtime | Required for PDF rendering only (first run downloads a Python environment, ~21 MB, one-time) |
| Zhipu AI Open Platform API key | Free signup: https://open.bigmodel.cn → Console → API Keys. The default model is fully free — no top-up needed |

### 3. Configure the API key (pick one)

> ⚠️ **Never put the key inside SKILL.md or any script**: this repository is public, and a committed key equals a leaked key.

- **Option 1 (recommended)**: environment variable `ZHIPU_API_KEY` (or `GLM_API_KEY`)
- **Option 2**: create `.glm-vision.json` next to the skill folder with `{"apiKey": "your-key"}` (ignored by `.gitignore`)
- **Option 3**: `--api-key KEY` on the command line (temporary; stays in shell history)

### 4. Use it

**From a chat**: just say "look at this image D:\photos\landscape.png" and the agent host invokes the skill automatically.

**From any shell**: no agent required; the core script is a plain CLI:

```bash
bun glm-vision.ts image.png                        # detailed description (default)
bun glm-vision.ts ocr screenshot.png               # OCR text extraction
bun glm-vision.ts analyze chart.png                # charts to Markdown tables, trend analysis
bun glm-vision.ts prompt artwork.jpg               # reverse AI painting prompts
bun glm-vision.ts pdf paper.pdf                    # PDF page-by-page recognition
bun glm-vision.ts detail image.png --question "How many cars are in this image?"
```

Common flags: `--question` custom prompt / `--think` `--no-think` reasoning toggle / `--force` ignore PDF cache and rerun everything / `--api-key KEY` / `--help`.

Limits: images png/jpg/jpeg/webp/gif/bmp up to 5 MB each, 5 images per run; PDFs up to 3 per run, 20 pages each, 100 MB per file.

## Versions & history

- **The default branch (main) is always the latest stable version**; installers just take the latest code.
- Historical versions live in **git tags**: `git checkout <tag>` returns to any release; the full change history is in [CHANGELOG.md](CHANGELOG.md).

## Repository layout

| Path | Purpose |
|---|---|
| `SKILL.md` | Main skill file: trigger rules, workflow, pitfalls guide, challenge-and-response summary |
| `glm-vision.ts` | Main script (bun runtime, zero npm dependencies) |
| `pdf2png.py` | PDF page rendering (uv + PyMuPDF) |
| `evals.json` | Verification records (rerunnable) |
| `README.zh-CN.md` | Chinese version of this file |

## Privacy (please read)

- All images and PDFs **are uploaded to Zhipu's servers** for recognition
- For sensitive files (ID cards, contracts, internal materials), make sure third-party processing is acceptable before use
- PDF resumable-run cache files (`.glm-vision.json`) sit next to the PDF and contain text results only; delete them after handling sensitive files

## License

- Project code: MIT License
