# AskUserQuestion HTML previews

Demonstrates HTML previews with the [`AskUserQuestion` tool](https://platform.claude.com/docs/en/agent-sdk/user-input#option-previews-type-script).

Normally when Claude asks a clarifying question, the user chooses from text labels. With previews, each option includes a rendered HTML fragment so the user can see the choice before making it.

The demo runs a branding assistant. Ask it to help brand a new product and Claude walks you through decisions (color palette, typography, vibe) one at a time, rendering each option as a live HTML mockup: sample UI, color swatches, type specimens. Click a card to pick, or type your own answer if none fit.

![Branding assistant showing four HTML preview cards for brand vibe options](screenshot.png)

The conversation is a live streaming session, not a one-shot run: your picks are stored as you make them, you can change any earlier pick without restarting, and you decide when to move from gathering answers to producing the final artifact. Claude includes an HTML preview on options where it helps (color palettes, layout choices) and omits it where it wouldn't (yes/no questions, plain text picks). The client renders both cases: cards with a preview box or just label + description.

**Stack:** The server is a Node.js HTTP server using the `ws` library for WebSocket communication and `tsx` for TypeScript execution. The client is a React 18 app built with Vite, using DOMPurify to sanitize preview HTML and react-markdown for rendering Claude's text output.

## Scenarios

Pick one from the dropdown before running:

- **Brand a SaaS product** — the original demo: vibe, palette, typography, shape
  and spacing, ending in a markdown brand guide.
- **Tune bb-tpm-rank ignition parameters** — chooses eight ignition flags for
  `bb-tpm-rank`, a live trades/min ranking tool. Previews are built only from
  the measured tables in that tool's own `--help`; flags with no measurement
  behind them say so rather than inventing a statistic. `--ign-max-price` is
  pinned and never offered as a choice.

Picks appear in the left panel and can be edited at any time. Editing sends the
agent a correction rather than restarting the run, so earlier answers survive.
**Continue to Design** moves to phase 2, which returns a dashboard document
rendered in a sandboxed iframe. A free-text box lets you interject at any point.

Picks are snapshotted to `.sessions/<id>.json`. A server restart restores the
picks but *not* the agent's context, and the UI says so rather than pretending
the conversation continued.

The demo never runs `bb-tpm-rank` and never reads live market data. Phase 2
renders against a deterministic simulated tape with synthetic `SIM*` symbols,
so it works with the market closed — and so invented rows can never be mistaken
for a recorded session.

## Prerequisites

- **Node.js 18+**
- **Authentication** via one of:
  - An Anthropic API key ([get one here](https://console.anthropic.com/settings/keys)), or
  - An existing `claude login` session (the SDK runs the Claude CLI, so its stored OAuth credentials work here too)

## Setup

First, install the dependencies:

```bash
npm install
```

Next, set up authentication. **If you've already run `claude login`, skip this step** since the CLI's stored credentials will be picked up automatically.

Otherwise, create a `.env` file from the template.

```bash
cp .env.example .env
```

Then open `.env` and replace the placeholder value with your key.

> **Leave `ANTHROPIC_API_KEY` unset if you use `claude login`.** A leftover
> placeholder such as the literal `sk-ant-...` is still a value, and it takes
> precedence over the CLI's stored credentials, so every request fails with
> `401 API key is invalid`. The server drops an inherited key by default for
> this reason; set `ANTHROPIC_AUTH=api-key` to opt into key-based billing.

Finally, start the dev server:

```bash
npm run dev
```

## Try the demo application

Open http://localhost:5173. The prompt field is prefilled with a branding assistant scenario. Click **Run** to start.

Claude will ask a series of clarifying questions, each with a set of preview cards showing rendered HTML mockups (color swatches, type specimens, sample UI). Click a card to pick that option, or type a free-text answer in the input below the cards.

Generating the previews can take a moment since each one is a full HTML fragment; the status line shows progress.

## Files

- [**`server.ts`**](server.ts): HTTP + WebSocket transport and message routing. No agent knowledge.
- [**`session.ts`**](session.ts): Owns one `query()` per connection, the phase, the picks, and teardown. This is where `canUseTool` forwards `AskUserQuestion` to the browser.
- [**`queue.ts`**](queue.ts): Single-consumer async queue feeding the streaming prompt generator.
- [**`picks.ts`**](picks.ts): `PickStore` — record, amend, supersede, serialize.
- [**`snapshot.ts`**](snapshot.ts): Atomic write-if-changed for the session snapshot.
- [**`scenarios/`**](scenarios): One file per scenario, plus the measured evidence tables for tpm-rank.
- [**`fixtures/tape.ts`**](fixtures/tape.ts): Deterministic simulated tpm-rank rows.
- [**`client/App.tsx`**](client/App.tsx): React UI. See `QuestionView` for preview rendering.
- [**`client/PicksPanel.tsx`**](client/PicksPanel.tsx): Stored picks, edit affordance, phase controls.
- [**`client/DesignPane.tsx`**](client/DesignPane.tsx): Sandboxed iframe for the phase-2 document.
- [**`client/useAgentSocket.ts`**](client/useAgentSocket.ts): WebSocket connection, auto-reconnect, and message dispatch.

## How it works

Most of the code handles WebSocket transport, status indicators, markdown rendering, and layout. The parts specific to the preview feature are small and localized:

| Where | What |
|-------|------|
| [`session.ts`](session.ts) options block | `toolConfig.askUserQuestion.previewFormat: "html"` enables previews; `tools: ["AskUserQuestion"]` leaves Claude no other way to act |
| [`session.ts`](session.ts) `canUseTool` | Intercepts `AskUserQuestion`, forwards it to the browser, awaits the pick, records it in the `PickStore`, returns `{ behavior: "allow", updatedInput: { questions, answers } }` |
| [`client/App.tsx`](client/App.tsx) `QuestionView` | Renders `opt.preview` with `dangerouslySetInnerHTML` + DOMPurify |

### SDK configuration

Each scenario supplies a custom `systemPrompt` that replaces the default Claude Code instructions entirely. (Use `systemPrompt` with `append` instead if you want to keep the defaults and add to them.) The options that shape tool behaviour:

```ts
permissionMode: "default",                                // NOT "plan" - see below
tools: ["AskUserQuestion"],                               // only this tool is available
toolConfig: { askUserQuestion: { previewFormat: "html" } } // adds opt.preview to each option
thinking: { type: "enabled", budgetTokens: 4000 }         // streamed to the UI as it works
```

**Why not `permissionMode: "plan"`.** Plan mode makes Claude more likely to ask
clarifying questions, which sounds ideal here. But Claude wraps up planning by
calling `ExitPlanMode`, and that call ends the turn — `query()` returns before
the final deliverable is ever written, leaving the UI on "the final deliverable
will be...". Approving the tool through `canUseTool` does not help, and neither
does switching the mode from inside the callback; both were tried and measured.
The system prompt already forces `AskUserQuestion`, so the default mode asks the
same questions and actually finishes.

`previewFormat: "html"` is the feature being demoed. Without it, options only have `label` and `description`. With it, Claude generates a styled `<div>` fragment for each option's `preview` field (the SDK strips `<script>` and `<style>` tags before your callback sees it).

The other two options make Claude actually reach for the tool. `permissionMode: "plan"` puts Claude in a requirements-gathering frame where it naturally asks clarifying questions. `tools: ["AskUserQuestion"]` restricts the toolset to just that one tool, so Claude has no choice but to ask questions rather than take actions like writing files or running commands.

### Server-to-browser round trip

The SDK spawns the Claude CLI as a subprocess, so `query()` and its `canUseTool` callback run on the server. This demo connects them to the browser over WebSocket:

1. Browser sends a prompt over WebSocket
2. Server routes it to a [`Session`](session.ts), which calls `query()` with an async generator as its prompt and starts streaming
3. When Claude calls `AskUserQuestion`, [`canUseTool`](session.ts) fires with the questions (including each `opt.preview` HTML)
4. Server forwards the question to the browser and stores a promise resolver in a `Map`
5. Browser [renders previews as cards](client/App.tsx) via `dangerouslySetInnerHTML` (sanitized with DOMPurify)
6. User clicks a card (or types a free-text answer); browser sends the label back
7. Server resolves the promise, records the choice in the `PickStore`, and `canUseTool` returns the answer in `updatedInput.answers`; the SDK continues

```
browser ──prompt──▶ server ──query()──▶ SDK
                              │
                    canUseTool fires with
                    questions[].options[].preview  ◀── HTML fragment
                              │
browser ◀─question── server (awaits...)
   │
  user clicks a card
   │
browser ──answer──▶ server ──resolves canUseTool──▶ SDK continues
```

Because the prompt is a generator rather than a string, the session stays open
after step 7. Editing a pick, typing an aside, or pressing **Continue to
Design** pushes another message into the same conversation instead of starting
a new one.

If the spawned CLI fails to start, its stderr is captured and attached to the
error shown in the browser — without that, an auth or environment failure
surfaces only as `Claude Code process exited with code 1`.

## Extend the demo

This demo covers one prompt-to-plan flow. Here are a few ways to build on it using other SDK features.

**Follow-up chat.** Already here: the demo uses [streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), so `prompt` is an async generator draining a queue rather than a string. Every correction, aside, and phase change is a message pushed into that queue, which is what lets you edit a pick without restarting the run. See `session.ts`.

**Richer answer types.** `AskUserQuestion` tops out at 4 options per question and labels are short strings. For sliders, color pickers, or multi-field forms, define a [custom tool](https://platform.claude.com/docs/en/agent-sdk/custom-tools) whose input schema matches what your UI collects. The round-trip pattern (server waits on a promise, browser resolves it) is identical.

**Notify when Claude is waiting.** Add a [`PermissionRequest` hook](https://platform.claude.com/docs/en/agent-sdk/hooks#available-hooks) that fires a Slack message, push notification, or email whenever `canUseTool` is about to block. Useful if the branding flow runs async and the user isn't watching the tab.

**Multi-select.** `AskUserQuestion` supports `multiSelect: true` per question. This demo only sends back one label per pick; to support it, change `pick()` to accumulate labels and add a "Done" button, then join them with `", "` in the answer value.

## See also

- [AskUserQuestion docs](https://platform.claude.com/docs/en/agent-sdk/user-input#option-previews-type-script)
- [Streaming vs single mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
