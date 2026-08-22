# Changelog

All notable changes to this project are documented in this file.

## v2.1 - 2026-08-22

- `--fast` PDF text-layer extraction (zero API cost for text-only pages)
- Per-page smart routing: raster/vector/scan pages go to vision, text pages are extracted directly

## v2.0 - 2026-08-22

- Bundled mupdf-wasm replaces the uv/Python PDF pipeline (zero-install, cross-platform)
- Pure-TS Word parser; Word documents go through a three-tier fallback chain
- New `compare` mode (multi-image comparison in one request) and SVG source analysis
- Image URL direct pass-through
- Free-model fallback chain with per-model capability table
- Pixel precheck (≤6000×6000) and `GLM_VISION_BASE_URL` endpoint override
- Centralized `.cache/` directory; cache invalidates on content change
- Removed all strategic limits (only API-level physical limits remain)

## v1.2 - 2026-08-19

- PDF resumable runs: per-page cache; reruns skip cached pages and only fill failures

## v1.1 - 2026-08-19

- PDF page-by-page recognition (uv + PyMuPDF rendering)
- `--think` / `--no-think` reasoning toggle
- Corrected official size limits

## v1.0 - 2026-08-19

- Initial release: image recognition with 4 modes (detail/ocr/analyze/prompt), error prechecks, external API key handling
