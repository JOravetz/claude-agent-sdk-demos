# Resume Generator

Generate professional resumes using the Claude Agent SDK. A lead agent
orchestrates an optional `researcher` subagent (web search) and an optional
terminal `AskUserQuestion` round-trip, then writes a `.docx` via the `docx`
library.

## Usage

```bash
npm install
npm start "Person Name" [--context PATH] [--pages N]
```

### Flags

| Flag | Alias | Default | Description |
|---|---|---|---|
| `--context` | `-c` | — | Path to a single CV file (**inline mode**) or a directory (**manifest mode**). Recognized text extensions: `.md`, `.markdown`, `.txt`, `.text`, `.json`, `.yaml`, `.yml`. Dotfiles are skipped. When supplied, the context is treated as authoritative and the researcher subagent only runs to fill identified gaps. |
| `--pages` | `-p` | `1` | Target page count, integer 1–5. Drives role count, summary length, and bullet-length budget. |

#### Context modes

- **Inline mode** (file path) — file contents are stuffed into the initial prompt. Hard cap: **200,000 chars**; oversized files error out with a clear pointer to manifest mode.
- **Manifest mode** (directory path) — the directory is walked recursively, but only a manifest (paths + sizes) is sent to the lead. When the directory contains ≥5 files, the lead **fans out K `scout` subagents** (K = ⌈N/8⌉, clamped to [2, 6]) in parallel; each scout reads one size-balanced cluster in its own context window and returns structured markdown findings the lead aggregates. Below that threshold, the lead just `Read`s the files itself. Scales to large corpora that would never fit in a single prompt.

### Examples

```bash
npm start "Jane Doe"
npm start "Jane Doe" --context my-cv.md
npm start "Jane Doe" --context ./resume-context/ --pages 2
```

## How it works

1. **Scout fan-out** (manifest mode, ≥5 files) — K `scout` subagents run in parallel; each ingests one size-balanced cluster and returns markdown findings (roles & dates, discoveries, skills, education, notable phrasing, gaps) which the lead aggregates.
2. **Direct triage** (manifest mode, <5 files) — the lead `Read`s the files itself.
3. **Clarify** (optional) — if intent is ambiguous, the lead asks 1–3 questions via `AskUserQuestion` (terminal prompt; auto-picks the `(Recommended)` option when stdin is not a TTY).
4. **Research** (optional) — spawns the `researcher` subagent. Mandatory when no `--context` is provided; otherwise only invoked to fill gaps.
5. **Draft + generate** — the lead synthesizes a resume, writes `agent/custom_scripts/generate_resume.js`, and runs it via `Bash` to produce the `.docx`.

## Output

`agent/custom_scripts/resume.docx` (wiped before each run).
