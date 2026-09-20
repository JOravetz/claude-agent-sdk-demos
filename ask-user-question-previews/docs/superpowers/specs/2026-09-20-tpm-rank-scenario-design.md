# tpm-rank scenario: persistent picks, amend-forward editing, two-phase design

Date: 2026-09-20
Status: approved, not yet implemented
Project: `ask-user-question-previews`

## Problem

The demo runs one hard-coded branding conversation. Picks exist only inside the
agent's context: there is no record of what was chosen, no way to change an
earlier answer, and no way to speak to the agent except by answering the
question currently on screen. When the questions run out, the run ends.

Three gaps follow from that:

1. Picks are not stored, so they cannot be displayed, edited, or recovered.
2. `query()` is called with a `prompt: string`, which is forward-only. There is
   no channel for a correction or a free-text aside.
3. There is one phase. Gathering preferences and producing a designed artifact
   are the same undifferentiated run.

## Goals

- Persist picks per session; survive a page reload and a `tsx watch` restart.
- Let the user change any earlier pick and have the agent adapt without a rerun.
- Let the user interject free text at any point.
- Split the run into an explicit gather phase and a design phase, with the user
  controlling the transition.
- Ship a second scenario — `bb-tpm-rank` parameter selection — as the worked
  example, with previews grounded in measured data.

## Non-goals

- Multi-user support, auth, or sharing. Still a local demo.
- Replacing the branding scenario. It stays, unchanged in behaviour.
- Running `bb-tpm-rank` itself. The demo produces an invocation and a view
  design; it never executes the binary or touches a broker account.
- Rewind semantics. Changing pick 2 does not discard picks 3+.

## Architecture

### Module split

`server.ts` currently holds transport, auth, agent configuration, and pick
handling in one scope (~200 lines). Adding sessions and phases to it makes it
the wrong shape. Split:

| File | Responsibility |
|---|---|
| `server.ts` | HTTP + WebSocket, message routing. No agent knowledge. |
| `session.ts` | `Session`: lifecycle, phase, message queue, owns one `query()`. |
| `picks.ts` | `PickStore`: record, amend, supersede, snapshot to disk. |
| `scenarios/index.ts` | Registry and `Scenario` type. |
| `scenarios/branding.ts` | Existing system prompt, behaviour unchanged. |
| `scenarios/tpm-rank.ts` | System prompt, param catalog, preview rules. |
| `scenarios/tpm-rank/evidence.ts` | Measured tables as typed constants. |
| `client/PicksPanel.tsx` | Current picks, edit affordance, history. |
| `client/DesignPane.tsx` | Phase-2 sandboxed document render. |

```ts
type Scenario = {
  id: string;
  label: string;
  systemPrompt: string;
  previewStyle: "hybrid" | "plain";
  catalog?: ParamCatalog;   // tpm-rank only
};
```

The client picks a scenario from a dropdown before the first prompt. Scenario is
fixed for the life of a session.

### Session and the message queue

A `Session` owns exactly one `query()` for its lifetime. The `prompt` option
becomes an async generator draining an internal queue rather than a string:

```ts
async function* messages(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    const next = await queue.take();   // resolves when push() is called
    if (next === END) return;
    yield { type: "user", message: { role: "user", content: next } };
  }
}
```

Every path that speaks to the agent is a `push`: answering a question, amending
a pick, sending free text, crossing the phase gate. Nothing restarts the query.

`queue.take()` must handle a push that lands before a consumer attaches, so the
queue buffers rather than relying on a waiting resolver being present.

**Teardown.** On socket close the generator must `return()` and the query must
be aborted. Without this the spawned Claude CLI outlives the browser tab. The
existing `pending`-rejection logic on `ws.on("close")` extends to cover both.

### Persistence

In-memory `Map<sessionId, Session>` is the live store. On every pick change the
session's picks and phase are snapshotted to `.sessions/<sessionId>.json`,
written atomically (temp file + rename) and only when the serialized content
differs from what is already on disk.

The client generates nothing: the server issues `sessionId` on connect, the
client keeps it in `localStorage` and presents it on reconnect.

**Stated limit.** A rehydrate restores *picks*, not the agent's context. The
spawned CLI is gone and its reasoning with it. On the first message after a
rehydrate the picks are re-seeded to the new query as a preamble, and the UI
says "picks restored, conversation restarted". It does not present this as
continuity.

`.sessions/` is gitignored.

### Amend-forward editing

Each `Pick` retains the full question payload that produced it, so the edit
affordance re-renders the original options without asking the agent for them
again.

```ts
type Pick = {
  id: string;
  header: string;        // "Ignition sigma"
  question: string;
  label: string;         // chosen option
  description: string;
  askedAt: number;
  supersededBy?: string; // id of the replacement Pick
};
```

`PickStore.amend(pickId, newLabel)` marks the old entry superseded, appends a
new one, and pushes:

> Correction: for "*question*" I previously chose "*old*". Use "*new*" instead.
> Keep the other decisions unless they conflict — if they do, say which ones
> change.

**Concurrency.** An amendment that arrives while the agent is mid-turn is
queued, not interleaved. The pick renders in a "queued" state until the agent is
between turns. Two amendments to the same pick before the agent responds
collapse to the latest value.

The panel shows current values; superseded picks collapse into a history
disclosure.

### The phase gate

The gate is a UI affordance, not an agent judgement. Making the agent signal "I
have enough" requires a sentinel in its output, which fails silently when the
wording drifts.

The panel always offers three controls, in both phases:

- **Ask me more** — pushes a request for further questions.
- **Continue to Design** — pushes the phase-2 instruction, sets `phase = "design"`.
- **Free-text box** — pushes the text verbatim.

`phase` is `"gather" | "design"`. It is advisory: it selects which instruction
text the gate pushes and which pane the client shows. The agent is told in the
system prompt that the user may interject or correct at any time.

### Rendering and isolation

Option previews keep the current treatment: DOMPurify-sanitized fragments
rendered inline.

The phase-2 dashboard is a complete HTML document with its own styles, so it
renders in an `<iframe srcdoc sandbox>` with scripts disabled. Inlining it would
let its CSS bleed into the app shell.

## The tpm-rank scenario

### Asked parameters

Eight flags, asked one or two at a time:

| Flag | Default | Measured evidence in `--help`? |
|---|---:|---|
| `--ign-sigma` | 2.25 | Partial — operator rationale, no scored table |
| `--ign-min-tpm` | 1,000 | Yes — 4-row table, 11,596 fires |
| `--ign-min-vol-min` | 300,000 | Yes — 4-row table with symbol counts |
| `--ign-tiers` | 2000,4000,8000 | Yes — 4-band forward-return table |
| `--ign-on` | 2.0 | No — saturation reasoning only |
| `--ign-off` | 1.2 | No — one anecdote (AEMD, 37 fires) |
| `--pick-tpm` | 2,000 | No |
| `--pick-vol-min` | 1,000,000 | No |

### Pinned, never asked

| Flag | Pinned value | Reason |
|---|---:|---|
| `--ign-max-price` | 10 | Operator instruction, 2026-09-20. Fixed, not tunable. |
| `--ign-mu-mult` | 5 | Relative test paired with the absolute floors above. |

Low-priced names are in scope as of 2026-09-20; the price ceiling is a fixed
risk bound, not a selection filter, and is not offered as a choice.

### Evidence discipline

**Previews may only use numbers present in `evidence.ts`.** Those tables are
transcribed verbatim from `--help`:

```ts
export const IGN_MIN_VOL_MIN = {
  flag: "--ign-min-vol-min",
  heldAt: "tpm >= 1,000",
  scored: "2026-09-10, 11,596 fires",
  rows: [
    { value: null,      fires: 1148, symbols: 229, reach1: 44, reach2: 30 },
    { value: 300_000,   fires:  475, symbols:  61, reach1: 55, reach2: 38 },
    { value: 500_000,   fires:  280, symbols:  30, reach1: 57, reach2: 39 },
    { value: 1_000_000, fires:  122, symbols:  11, reach1: 68, reach2: 55 },
  ],
} as const;
```

A model asked to produce plausible market statistics will produce them fluently
and wrongly, and a preview is exactly the surface where a fabricated number
reads as authoritative. Flags with no measured backing get the plain preview and
state "no measured data" on screen.

### Preview treatment

Hybrid, per the approved mockup: a four-cell KPI strip for the option's value
(fires/day, symbols surviving, reach +1%, median high), then one bar per
candidate value so alternatives stay visible, with the current option's bar
highlighted.

All numeric cells right-justified.

Where the evidence shows a metric improving while the sample collapses — the
`--ign-min-vol-min` case, where 1M shares/min scores 68% across eleven names —
the preview shows the symbol count alongside the hit rate rather than the hit
rate alone.

### Deliverables

**Phase 1.** The invocation plus a per-flag rationale citing the evidence:

```
bb-tpm-rank --ign-sigma 2.25 --ign-min-tpm 1000 --ign-min-vol-min 300000 \
            --ign-tiers 2000,4000,8000 --ign-on 2.0 --ign-off 1.2 \
            --pick-tpm 2000 --pick-vol-min 1000000
```

**Phase 2.** A dashboard view of that output. The picks determine which of the
27 columns earn space: a run with a high `--ign-min-vol-min` should surface
`VOL/MIN` prominently; one tuned on tiers should surface `TIER`. Rendered in the
sandboxed pane, iterable via follow-up prompts.

## Error handling

| Case | Behaviour |
|---|---|
| CLI exits non-zero | Existing `stderr` capture attaches the last lines to the browser error. |
| Socket closes mid-turn | Generator returns, query aborts, pending waits reject, picks snapshotted. |
| Amend during agent turn | Queued; pick shows "queued" until the turn ends. |
| Rehydrate after restart | Picks restored, conversation restarted, said plainly in the UI. |
| Snapshot write fails | Logged to stderr; session continues in memory. A failed snapshot must not kill a live conversation. |
| Agent references a superseded pick | Left to the agent; the correction message tells it which value is current. |

## Testing

The demo has no test script today. Add one, with two pure units and a smoke run:

- `picks.test.ts` — amend marks superseded and appends; snapshot round-trips;
  repeated amends collapse; serialization is stable for `write_if_changed`.
- `queue.test.ts` — push before a consumer attaches is buffered; `END` drains;
  double-close is safe; teardown releases a waiting consumer.
- `scripts/smoke.mjs` — the WebSocket driver used to verify the auth fix,
  promoted to a checked-in end-to-end run: connect, answer every question with
  the first option, cross the phase gate, assert a phase-2 document arrives.

Neither unit touches the SDK or the network. The smoke run needs a live server
and a working CLI login, so it is not part of the default test command.

## Implementation notes

- `frontend-design` and `dataviz` skills to be invoked when building the preview
  components and the phase-2 dashboard.
- `tsc --noEmit` must stay clean; no warnings are acceptable.
- The auth handling, extended thinking, and `stderr` surfacing added on
  2026-09-20 stay as-is.
