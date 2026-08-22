# Vision Eye (glm-vision)

> Give "eyes" to LLMs without vision: let plain-text models "see" images, PDFs, and Word documents.

Uses Zhipu GLM's free vision models to turn local images / PDFs / Word documents / image URLs into structured text descriptions that any text-only LLM can understand. Cross-platform (Windows / macOS / Linux), zero npm — the only requirement is the bun runtime.

The skill targets the open Agent Skills standard (agentskills.io), so it plugs into any host that implements it, regardless of product form. The core script also works as a plain CLI from any shell, with or without an agent.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## What it can do

- **Image understanding** — photos, screenshots, flowcharts, architecture diagrams, charts → detailed text descriptions
- **OCR** — verbatim text extraction while preserving layout structure
- **Deep analysis** — chart data to Markdown tables, trend analysis, formula interpretation
- **Image2Prompt** — reverse-engineer AI painting prompts from images, output in Chinese and English
- **Multi-image compare** — native comparison of several images in one request (image URLs can be mixed in)
- **PDF reading** — page-by-page rendering with bundled mupdf-wasm, no page cap, resumable runs
- **Word reading** — plain-text extraction with zero API cost and no key required; documents with images go through a three-tier fallback chain
- **SVG source analysis and image URLs** — read SVG source directly (no image upload), or pass an http(s) URL for the server to download
- **Free-model fallback chain** — automatic backoff retries on rate limits, then switches along a chain of free models
- **Preflight checks** — existence, format whitelist, zero-byte, size and pixel checks (≤6000×6000) before upload

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
| bun runtime | The only runtime dependency — install once per machine. No uv, no Python, no npm, no network installs |
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
bun glm-vision.ts compare a.png b.jpg              # multi-image comparison
bun glm-vision.ts pdf paper.pdf                    # PDF page-by-page recognition
bun glm-vision.ts docx report.docx                 # Word (zero cost for plain text)
bun glm-vision.ts svg diagram.svg                  # SVG source analysis
bun glm-vision.ts detail "https://example.com/a.jpg"   # image URL
bun glm-vision.ts detail image.png --question "How many cars are in this image?"
```

Common flags: `--question` custom prompt / `--think` `--no-think` reasoning toggle / `--temperature T` / `--force` ignore cache / `--parallel N` PDF concurrency / `--save` write results to file / `--api-key KEY` / `--help`.

Limits: images up to 5 MB each and 6000×6000 pixels (API physical limits); PDFs have no page cap and support resumable runs.

## Versions & history

- **The default branch (main) is always the latest stable version**; installers just take the latest code.
- Historical versions live in **git tags**: `git checkout <tag>` returns to any release; the full change history is in [CHANGELOG.md](CHANGELOG.md).

## Repository layout

| Path | Purpose |
|---|---|
| `SKILL.md` | Main skill file: trigger rules, workflow, pitfalls guide, challenge-and-response summary |
| `glm-vision.ts` | Main script (bun single runtime, zero npm dependencies) |
| `docx-parse.ts` | Word plain-text parsing and embedded-image extraction |
| `render-pdf.js` | PDF page rendering (bundled mupdf-wasm) |
| `docx2pdf.ps1` | Word COM conversion (optional Windows path) |
| `node_modules/mupdf/` | Official MuPDF.js build (AGPL-3.0, unmodified, LICENSE included) |
| `evals.json` | Verification records (environment-limited items annotated) |
| `README.zh-CN.md` | Chinese version of this file |

## Privacy (please read)

- Images, PDFs, and Word documents containing images **are uploaded to Zhipu's servers** for recognition (plain-text Word documents are not uploaded)
- For sensitive files (ID cards, contracts, internal materials), make sure third-party processing is acceptable before use
- Cache files (`.cache/`) contain text results only, never the images themselves

## License

- Project code: MIT License
- Bundled mupdf.js (MuPDF.js v1.28.0): AGPL-3.0, an official **unmodified** build; its LICENSE ships in `node_modules/mupdf/`
