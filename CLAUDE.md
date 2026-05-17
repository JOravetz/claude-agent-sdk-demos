# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo of independent demo applications for the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk). No root-level manifest, build, lint, or test — `cd` into a demo before running anything.

| Demo | Runtime | Install | Run |
|---|---|---|---|
| `hello-world/` | Node | `npm install` | `npx tsx hello-world.ts` |
| `hello-world-v2/` | Node | `npm install` | `npx tsx v2-examples.ts <basic\|multi-turn\|one-shot\|resume>` |
| `simple-chatapp/` | Node | `npm install` | `npm run dev` (server :3001, Vite :5173) |
| `ask-user-question-previews/` | Node | `npm install` | `npm run dev` (server + Vite :5173) |
| `resume-generator/` | Node | `npm install` | `npm start "Person Name"` |
| `email-agent/` | **Bun** | `bun install` | `bun run dev` — tests: `npm test` (jest+ts-jest) |
| `excel-demo/` | Electron + Python | `npm install` | `npm start` — `agent/` is a separate Python subproject (`agent/requirements.txt`) |
| `research-agent/` | Python / **uv** | `uv sync` | `uv run python research_agent/agent.py` |

Gotchas not obvious from the table:
- `email-agent/` must use Bun (per its own `CLAUDE.md`); subagent prompts live in `agent/.claude/agents`.
- `hello-world/` requires `mkdir -p agent/custom_scripts` before first run — the SDK's `cwd` must exist, and the demo's `PreToolUse` hook restricts writes to that directory.

## SDK patterns to know

Two SDK paradigms — match the one the demo already uses:
- **V1 `query()`** (most demos): single-shot async generator yielding `system` / `assistant` / `result` messages.
- **V2 Session API** (`hello-world-v2/`, `resume-generator/`): `unstable_v2_createSession` / `unstable_v2_resumeSession` / `unstable_v2_prompt`, with separate `send()` + `stream()` and `await using` for auto-close. Supports multi-turn and resume.

Web demos (`simple-chatapp`, `ask-user-question-previews`, `email-agent`) share a pattern: the SDK runs **server-side** (it spawns the Claude CLI as a subprocess) and the browser talks to it over **WebSocket**. Tool round-trips that need user input (e.g. `AskUserQuestion`) park a promise resolver in a `Map` keyed by request id, forward to the browser, and resolve when the answer comes back — `ask-user-question-previews/server.ts` is the canonical version.

Hooks are used two ways in this repo: **restriction** (`hello-world/` blocks writes outside `custom_scripts/`) and **observability** (`research-agent/` uses `parent_tool_use_id` to attribute every tool call to the subagent that made it, logging to `logs/session_*/`).

## Conventions

Demos are **local-development only** — plaintext credentials in `.env`, no auth, not production-hardened. Don't add production-style hardening unless asked.
