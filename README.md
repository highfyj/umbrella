# Umbrella

A full-stack visual novel engine and script editing system built entirely on the web. Create, compile, and play fully-voiced visual novels — all in your browser.

> **"Script first, assets later."** Write and debug your entire story with zero assets. Placeholder rendering keeps you moving. Add art, music, and voice when you're ready.

[中文文档](README.zh-cn.md)

---

## What is Umbrella?

Umbrella is two things in one:

- **A game runtime** — a deterministic VM + web-based player for visual novels with full voice support, branching choices, save/load, and multiple endings.
- **A script editing system** — the core product. A YAML-based DSL with a full compiler toolchain (JSON Schema validation, semantic linter, IR output) and an integrated web editor with real-time preview, asset management, and AI-assisted production.

### Why Umbrella?

Most visual novel engines require you to learn a proprietary scripting language and force you to have assets ready before you can see anything. Umbrella flips that:

- **Write in YAML** — familiar, readable, with IDE-grade autocompletion and inline diagnostics powered by JSON Schema.
- **Compile-time safety** — dangling jumps, undeclared variables, and typos are caught at compile time with exact line/column numbers. No more runtime surprises.
- **Zero-asset development** — missing sprites, backgrounds, and voice files never block you. The player renders placeholders so you can test the full flow immediately.
- **AI-assisted production** — built-in TTS voice generation (CosyVoice) and AI sprite generation with background removal, all from within the editor.

---

## Features

### Script DSL & Compiler
- YAML-based scenario format with a clean syntax designed for writers
- JSON Schema validation with autocompletion (Monaco Editor)
- Semantic linter: reference checking, variable validation, reachability analysis, voice three-way reconciliation
- Compiles to a JSON IR consumed by the runtime — no YAML parsing at runtime

### Runtime VM
- Deterministic, headless VM — run full branching tests in Node.js
- Serializable PRNG state (mulberry32) — save files are fully reproducible
- `rand()` / `randint()` in expressions, weighted `random` branches

### Web Player
- Full-screen player with typing animation and voice playback
- Three independent audio channels: voice / BGM / SE with auto-ducking
- Save/load, quick restart, ending cards
- Placeholder rendering for missing assets with an on-screen HUD

### Integrated Editor
- Monaco editor with JSON Schema-driven autocompletion
- Real-time semantic diagnostics on unsaved buffers (400ms debounced overlay compilation)
- Embedded player preview (reuses the same `Game` class)
- Read-only story flowchart visualization
- Asset management panel: drag-and-drop registration, cursor-hover preview, one-click write-back to YAML

### AI Production Pipeline
- **TTS**: CosyVoice integration — configure, probe, right-click a line to generate, audition, and commit voice files
- **Sprite generation**: codex exec agent workflow + rembg background removal — three flows for sprites, backgrounds, and reference images with gacha-style candidate galleries

---

## Quick Start

```bash
git clone https://github.com/highfyj/umbrella.git
cd umbrella
npm install              # Node >= 20, npm workspaces
npm test                 # 45 tests passing
npm run editor           # Editor at http://localhost:5174
npm run dev              # Player at http://localhost:5173
```

Optional dependencies:
- **ffmpeg** (on PATH): auto-convert TTS output to Ogg; falls back to WAV
- **CosyVoice** (local FastAPI deployment): configure in the editor toolbar under "TTS Settings"

---

## Commands

```
npm run editor                    Start the editor (http://localhost:5174)
npm run dev                       Start the player (http://localhost:5173, hot reload on YAML changes)
npm test                          Run all tests
npm run typecheck                 TypeScript type checking
npm run vn -- check               Compile check (missing assets are warnings only)
npm run vn -- check --strict      Pre-release QA: warnings become errors
npm run vn -- compile             Output build/story.ir.json
npm run vn -- voice-script        Export voice recording script as CSV
npm run vn -- sprite-checklist    Export sprite generation checklist as CSV
npm run vn -- assign-ids --write  Auto-assign voice IDs and write back to YAML
```

---

## Project Structure

```
umbrella/
├── docs/
│   ├── dsl-design.md              DSL design document (authoritative data model reference)
│   └── progress.md                Development journal & design decisions
├── story/                         Scenario source files (YAML)
│   ├── story.yaml                 Entry point, variables, ending registry
│   ├── characters.yaml            Character & sprite variant registry
│   ├── assets.yaml                Background / BGM / SE word lists
│   └── scenes/                    One YAML file per scene
├── sprite/ bg/ bgm/ se/           Runtime assets (optional; placeholders if missing)
├── voice/                         Voice files (voice/<scene>/<id>.ogg)
├── production/                    Editorial materials (not shipped with game)
│   ├── refs/                      AI generation reference images
│   └── tts/                       Voice sample files
├── packages/
│   ├── core/                      IR types, expression evaluator, serializable PRNG
│   ├── compiler/                  YAML → validation/linter → IR; CLI; JSON Schema ×4
│   ├── runtime/                   Headless deterministic VM (next/choose/save/load)
│   ├── player/                    Web player (exports Game class, reused by editor preview)
│   ├── editor/                    Monaco editor + real-time diagnostics + preview + flowchart + assets
│   └── devtools/                  Shared Vite plugin: live compilation, file API, asset serving, TTS/image proxies
└── build/                         Compiled IR output
```

---

## Sample Scenario

The repository includes a complete sample scenario titled *Umbrella* (雨伞), covering the full DSL feature set:

- 2 characters (one voiced with sprites, one unvoiced)
- 3 scenes across 2 endings (good / normal)
- Branching choices with conditional visibility
- Weighted random branches
- Variable system with expression evaluation
- Sprite variants with 3-dimensional addressing (outfit / state / face)
- Voice line assignment with IDs

---

## Key Design Decisions

1. **Compiler middle layer** — Runtime only sees IR, never touches YAML. Semantic errors caught at compile time with precise source locations.
2. **Errors vs. warnings** — Typos and broken references are errors. Missing assets are always warnings with placeholder fallback. `--strict` mode for release QA only.
3. **Sprites as whole-image variants** — `(outfit, state, face)` → one complete AI-generated image. No runtime layer compositing.
4. **Voice IDs** — Format `<scene>_<4-digit-seq>`, step 10, never reused. Text hashes in `voice.lock` for rewrite detection.
5. **Deterministic randomness** — PRNG state is part of the VM and save file. Rewinding never re-rolls.
6. **Production materials** — Reference images and voice samples attached to character definitions, never shipped in builds.

---

## Tech Stack

| Category | Technology |
|----------|------------|
| Language | TypeScript 5.5 (full-stack) |
| Module System | ESM (`"type": "module"`) |
| Package Management | npm workspaces (monorepo, 6 packages) |
| Build Tool | Vite (dev server + HMR) |
| Testing | Vitest (45 tests) |
| Editor | Monaco Editor + monaco-yaml |
| Data Format | YAML 1.2 |
| JSON Schema | ajv 8.17 |
| Audio | Web Audio API (3-channel: voice/BGM/SE) |
| AI Integration | CosyVoice (TTS), codex agent (image gen), rembg (background removal) |

---

## Roadmap

See [docs/progress.md](docs/progress.md#7-后续路线建议优先级) for the full roadmap. Highlights:

- **v0.2**: `call/return` subroutines, parallel performances, inline steps in choices
- **Build pipeline**: `vn build` for static site output, per-scene chunked loading + Service Worker
- **Multi-language hooks**, CG/gallery unlock, browser SpeechSynthesis fallback for TTS preview

---

## License

MIT
