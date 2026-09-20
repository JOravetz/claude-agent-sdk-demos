# tpm-rank Scenario Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted, editable picks and a user-controlled gather→design phase gate to the AskUserQuestion demo, and ship a second scenario that selects `bb-tpm-rank` ignition parameters using previews grounded in measured data.

**Architecture:** One `query()` per session, fed by an async generator draining a message queue, so corrections and free text are pushed into a live conversation instead of restarting it. Picks live in a server-side store, snapshotted to disk. Scenarios are data (system prompt + preview style + optional param catalog); branding and tpm-rank are two entries.

**Tech Stack:** TypeScript, Node 24, `@anthropic-ai/claude-agent-sdk`, `ws`, React 18, Vite, `node:test` + `tsx` (no new test dependency).

**Spec:** `docs/superpowers/specs/2026-09-20-tpm-rank-scenario-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `queue.ts` | Async message queue: buffer, wake a waiting consumer, close cleanly. |
| `picks.ts` | `Pick` type and `PickStore`: record, amend, supersede, serialize. |
| `snapshot.ts` | Atomic `writeIfChanged(path, content)`. |
| `scenarios/index.ts` | `Scenario` type + registry. |
| `scenarios/branding.ts` | Existing branding prompt, moved verbatim. |
| `scenarios/tpm-rank.ts` | tpm-rank system prompt + catalog. |
| `scenarios/tpm-rank-evidence.ts` | Measured tables, transcribed from `--help`. |
| `session.ts` | `Session`: owns one `query()`, phase, picks, teardown. |
| `server.ts` | HTTP + WebSocket transport and message routing only. |
| `client/PicksPanel.tsx` | Current picks, edit affordance, history, phase controls. |
| `client/DesignPane.tsx` | Sandboxed iframe render of the phase-2 document. |
| `client/useAgentSocket.ts` | Transport: adds picks, phase, design, session id. |
| `scripts/smoke.mjs` | End-to-end WebSocket driver. |

Existing behaviour that must not regress: auth handling (`server.ts:7-29`), extended thinking, `stderr` capture, DOMPurify-sanitized option previews.

---

## Task 1: Test infrastructure

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "node --import tsx --test \"*.test.ts\"",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 2: Write a sanity test**

Create `sanity.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner is wired up", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: `pass 1`, `fail 0`.

- [ ] **Step 4: Delete the sanity test and commit**

```bash
rm sanity.test.ts
git add package.json
git commit -m "test: add node:test runner via tsx"
```

---

## Task 2: MessageQueue

An async queue with one consumer. The consumer (`for await` inside `query()`'s
prompt generator) may attach before or after a push, so pushes must buffer.

**Files:**
- Create: `queue.ts`
- Test: `queue.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `queue.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { END, MessageQueue } from "./queue.js";

test("take() resolves with an item pushed before the consumer attached", async () => {
  const q = new MessageQueue<string>();
  q.push("first");
  assert.equal(await q.take(), "first");
});

test("take() waiting first is woken by a later push", async () => {
  const q = new MessageQueue<string>();
  const pending = q.take();
  q.push("later");
  assert.equal(await pending, "later");
});

test("items are delivered in order", async () => {
  const q = new MessageQueue<string>();
  q.push("a");
  q.push("b");
  assert.equal(await q.take(), "a");
  assert.equal(await q.take(), "b");
});

test("close() resolves a waiting consumer with END", async () => {
  const q = new MessageQueue<string>();
  const pending = q.take();
  q.close();
  assert.equal(await pending, END);
});

test("buffered items are delivered before END", async () => {
  const q = new MessageQueue<string>();
  q.push("a");
  q.close();
  assert.equal(await q.take(), "a");
  assert.equal(await q.take(), END);
});

test("push after close is ignored", async () => {
  const q = new MessageQueue<string>();
  q.close();
  q.push("ignored");
  assert.equal(await q.take(), END);
});

test("double close is safe", async () => {
  const q = new MessageQueue<string>();
  q.close();
  q.close();
  assert.equal(await q.take(), END);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './queue.js'`.

- [ ] **Step 3: Implement**

Create `queue.ts`:

```ts
/**
 * Single-consumer async queue. The consumer is the generator feeding query();
 * producers are the WebSocket handlers. A push that lands before the consumer
 * attaches must not be lost, so items buffer.
 */
export const END = Symbol("end");

export class MessageQueue<T> {
  private items: T[] = [];
  private waiting: ((value: T | typeof END) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(END);
    }
  }

  take(): Promise<T | typeof END> {
    const next = this.items.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(END);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: `pass 7`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add queue.ts queue.test.ts
git commit -m "feat: add single-consumer async message queue"
```

---

## Task 3: Atomic snapshot writer

**Files:**
- Create: `snapshot.ts`
- Test: `snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `snapshot.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIfChanged } from "./snapshot.js";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "snap-"));
}

test("first write creates the file and reports written", async () => {
  const dir = await scratch();
  const file = join(dir, "a.json");
  assert.equal(await writeIfChanged(file, "hello"), true);
  assert.equal(await readFile(file, "utf8"), "hello");
  await rm(dir, { recursive: true, force: true });
});

test("identical content is not rewritten", async () => {
  const dir = await scratch();
  const file = join(dir, "a.json");
  await writeIfChanged(file, "hello");
  assert.equal(await writeIfChanged(file, "hello"), false);
  await rm(dir, { recursive: true, force: true });
});

test("changed content is rewritten", async () => {
  const dir = await scratch();
  const file = join(dir, "a.json");
  await writeIfChanged(file, "hello");
  assert.equal(await writeIfChanged(file, "goodbye"), true);
  assert.equal(await readFile(file, "utf8"), "goodbye");
  await rm(dir, { recursive: true, force: true });
});

test("missing parent directories are created", async () => {
  const dir = await scratch();
  const file = join(dir, "nested", "deep", "a.json");
  assert.equal(await writeIfChanged(file, "hello"), true);
  assert.equal(await readFile(file, "utf8"), "hello");
  await rm(dir, { recursive: true, force: true });
});

test("no temp files are left behind", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = await scratch();
  const file = join(dir, "a.json");
  await writeIfChanged(file, "hello");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["a.json"]);
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './snapshot.js'`.

- [ ] **Step 3: Implement**

Create `snapshot.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `content` to `path` only when it differs from what is already there,
 * via a temp file and a rename so a reader never sees a half-written file.
 * Returns true when a write happened.
 */
export async function writeIfChanged(
  path: string,
  content: string,
): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")) === content) return false;
  } catch {
    // Missing or unreadable: fall through and write.
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: `pass 12`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add snapshot.ts snapshot.test.ts
git commit -m "feat: add atomic write-if-changed snapshot helper"
```

---

## Task 4: PickStore

**Files:**
- Create: `picks.ts`
- Test: `picks.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `picks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PickStore } from "./picks.js";

function seeded(): PickStore {
  const store = new PickStore();
  store.record({
    header: "Ignition sigma",
    question: "How unusual must a bucket be?",
    label: "2.25",
    description: "Matches bb-breakout-detector.",
  });
  store.record({
    header: "Volume floor",
    question: "What shares/min floor?",
    label: "300,000",
    description: "61 symbols, 55% reach +1%.",
  });
  return store;
}

test("record() returns a pick with a stable id", () => {
  const store = new PickStore();
  const pick = store.record({
    header: "H",
    question: "Q",
    label: "L",
    description: "D",
  });
  assert.ok(pick.id);
  assert.equal(store.current().length, 1);
  assert.equal(store.current()[0].id, pick.id);
});

test("current() returns picks in the order they were recorded", () => {
  const store = seeded();
  assert.deepEqual(
    store.current().map((p) => p.header),
    ["Ignition sigma", "Volume floor"],
  );
});

test("amend() supersedes the old pick and keeps position", () => {
  const store = seeded();
  const original = store.current()[0];
  store.amend(original.id, "2.0", "Caught TNON.");

  const current = store.current();
  assert.equal(current.length, 2);
  assert.equal(current[0].header, "Ignition sigma");
  assert.equal(current[0].label, "2.0");
  assert.deepEqual(
    current.map((p) => p.header),
    ["Ignition sigma", "Volume floor"],
  );
});

test("amend() preserves the original question text", () => {
  const store = seeded();
  const original = store.current()[0];
  store.amend(original.id, "2.0", "Caught TNON.");
  assert.equal(store.current()[0].question, "How unusual must a bucket be?");
});

test("repeated amends collapse to one current pick", () => {
  const store = seeded();
  store.amend(store.current()[0].id, "2.0", "first change");
  store.amend(store.current()[0].id, "3.0", "second change");

  assert.equal(store.current().length, 2);
  assert.equal(store.current()[0].label, "3.0");
  assert.equal(store.history().length, 2);
});

test("amend() on an unknown id throws", () => {
  const store = seeded();
  assert.throws(() => store.amend("nope", "x", "y"), /unknown pick/i);
});

test("history() returns superseded picks only", () => {
  const store = seeded();
  const original = store.current()[0];
  store.amend(original.id, "2.0", "changed");

  const history = store.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].label, "2.25");
});

test("toJSON/fromJSON round-trips current and history", () => {
  const store = seeded();
  store.amend(store.current()[0].id, "2.0", "changed");

  const restored = PickStore.fromJSON(store.toJSON());
  assert.deepEqual(
    restored.current().map((p) => p.label),
    store.current().map((p) => p.label),
  );
  assert.equal(restored.history().length, 1);
});

test("toJSON is stable for identical content", () => {
  assert.equal(seeded().toJSON(), seeded().toJSON());
});
```

Note: `toJSON` being stable across two independently built stores requires ids
and timestamps to be derived from content and position, not from a clock or a
random source. The implementation below does that deliberately.

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './picks.js'`.

- [ ] **Step 3: Implement**

Create `picks.ts`:

```ts
export type Pick = {
  id: string;
  header: string;
  question: string;
  label: string;
  description: string;
  /** id of the pick that replaced this one, when amended. */
  supersededBy?: string;
};

export type PickInput = {
  header: string;
  question: string;
  label: string;
  description: string;
};

/**
 * Ordered record of what the user chose, with amendments kept as history
 * rather than overwritten. Ids are sequential so a serialized store is stable:
 * two stores built from the same choices produce byte-identical JSON, which is
 * what lets writeIfChanged skip redundant snapshots.
 */
export class PickStore {
  private picks: Pick[] = [];
  private nextId = 1;

  record(input: PickInput): Pick {
    const pick: Pick = { id: `p${this.nextId++}`, ...input };
    this.picks.push(pick);
    return pick;
  }

  amend(pickId: string, label: string, description: string): Pick {
    const original = this.picks.find((p) => p.id === pickId);
    if (!original) throw new Error(`unknown pick: ${pickId}`);

    const replacement: Pick = {
      id: `p${this.nextId++}`,
      header: original.header,
      question: original.question,
      label,
      description,
    };
    original.supersededBy = replacement.id;
    // Insert in the superseded pick's slot so display order is unchanged.
    this.picks.splice(this.picks.indexOf(original) + 1, 0, replacement);
    return replacement;
  }

  /** Picks that have not been replaced, in display order. */
  current(): Pick[] {
    return this.picks.filter((p) => !p.supersededBy);
  }

  /** Picks that have been replaced, oldest first. */
  history(): Pick[] {
    return this.picks.filter((p) => p.supersededBy);
  }

  toJSON(): string {
    return JSON.stringify({ nextId: this.nextId, picks: this.picks }, null, 2);
  }

  static fromJSON(json: string): PickStore {
    const parsed = JSON.parse(json) as { nextId: number; picks: Pick[] };
    const store = new PickStore();
    store.picks = parsed.picks;
    store.nextId = parsed.nextId;
    return store;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: `pass 21`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add picks.ts picks.test.ts
git commit -m "feat: add PickStore with amend-forward history"
```

---

## Task 5: Scenario registry and branding extraction

Pure move. Behaviour must not change.

**Files:**
- Create: `scenarios/index.ts`, `scenarios/branding.ts`
- Modify: `server.ts`

- [ ] **Step 1: Create the Scenario type and registry**

Create `scenarios/index.ts`:

```ts
export type PreviewStyle = "hybrid" | "plain";

export type Scenario = {
  id: string;
  label: string;
  /** Prompt text shown in the client's textarea when this scenario is picked. */
  defaultPrompt: string;
  systemPrompt: string;
  previewStyle: PreviewStyle;
};

import { branding } from "./branding.js";
import { tpmRank } from "./tpm-rank.js";

export const SCENARIOS: Record<string, Scenario> = {
  [branding.id]: branding,
  [tpmRank.id]: tpmRank,
};

export const DEFAULT_SCENARIO = branding.id;

export function getScenario(id: string | undefined): Scenario {
  return SCENARIOS[id ?? DEFAULT_SCENARIO] ?? SCENARIOS[DEFAULT_SCENARIO];
}
```

- [ ] **Step 2: Move the branding prompt**

Create `scenarios/branding.ts`, moving the existing `systemPrompt` string from
`server.ts` verbatim (it currently lives in the `query()` options):

```ts
import type { Scenario } from "./index.js";

export const branding: Scenario = {
  id: "branding",
  label: "Brand a SaaS product",
  defaultPrompt:
    "Help me brand a new SaaS product. Walk me through the key decisions " +
    "(colors, typography, vibe) and show me visual options for each.",
  previewStyle: "plain",
  systemPrompt:
    "You are a branding assistant. When the user asks for help branding a " +
    "site or product, gather their preferences first: ask about color " +
    "palette, typography/style, overall vibe, and anything else that shapes " +
    "the direction. Use AskUserQuestion for each decision point and include " +
    "an HTML preview on each option so they can see what they're choosing. " +
    "Always use the AskUserQuestion tool to ask questions. Never ask " +
    "questions in your text output; the user can only respond through the " +
    "tool's UI. Ask one or two questions at a time; don't overwhelm.\n\n" +
    "Every option must be self-contained. Never offer options like 'I have " +
    "my own idea' or 'I'll tell you later' that require follow-up input. " +
    "The user has a free-text box for that; your options should all be " +
    "concrete choices with previews.\n\n" +
    "When you have gathered enough, output the final " +
    "brand guide directly as markdown: color hex codes, font names, " +
    "spacing/radius values, and a usage summary. You have no write tools " +
    "available, so the markdown IS the deliverable.",
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails with `Cannot find module './tpm-rank.js'` — that file arrives in
Task 7. This is expected; do not commit yet. Proceed to Task 6.

---

## Task 6: tpm-rank evidence tables

These numbers come from `bb-tpm-rank --help` and are the only numbers a preview
may use. Transcribe them exactly; do not round, recompute, or extend them.

**Files:**
- Create: `scenarios/tpm-rank-evidence.ts`
- Test: `evidence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `evidence.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE, hasEvidence } from "./scenarios/tpm-rank-evidence.js";

test("every evidence row carries the flag it belongs to", () => {
  for (const [flag, table] of Object.entries(EVIDENCE)) {
    assert.equal(table.flag, flag, `${flag} table is mislabelled`);
    assert.ok(table.rows.length > 0, `${flag} has no rows`);
  }
});

test("the volume floor table matches --help exactly", () => {
  const rows = EVIDENCE["--ign-min-vol-min"].rows;
  assert.deepEqual(rows.map((r) => r.value), [null, 300000, 500000, 1000000]);
  assert.deepEqual(rows.map((r) => r.symbols), [229, 61, 30, 11]);
  assert.deepEqual(rows.map((r) => r.fires), [1148, 475, 280, 122]);
});

test("hasEvidence distinguishes measured flags from unmeasured ones", () => {
  assert.equal(hasEvidence("--ign-min-vol-min"), true);
  assert.equal(hasEvidence("--ign-on"), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `Cannot find module './scenarios/tpm-rank-evidence.js'`.

- [ ] **Step 3: Implement**

Create `scenarios/tpm-rank-evidence.ts`:

```ts
/**
 * Measured results transcribed verbatim from `bb-tpm-rank --help`.
 *
 * These are the ONLY numbers a preview may show. A model asked to produce
 * plausible market statistics will produce them fluently and wrongly, and a
 * preview is the surface where a fabricated number reads as authoritative.
 */
export type EvidenceRow = {
  /** null = no floor applied. */
  value: number | null;
  fires: number;
  symbols?: number;
  reach1: number;
  reach2: number;
  medianHigh?: string;
};

export type EvidenceTable = {
  flag: string;
  scored: string;
  heldAt?: string;
  rows: EvidenceRow[];
};

export const EVIDENCE: Record<string, EvidenceTable> = {
  "--ign-min-tpm": {
    flag: "--ign-min-tpm",
    scored: "2026-09-10, 11,596 fires, scored on the next five minutes",
    rows: [
      { value: null, fires: 11596, reach1: 29, reach2: 16, medianHigh: "+0.33%" },
      { value: 1000, fires: 1148, reach1: 44, reach2: 30, medianHigh: "+0.74%" },
      { value: 3000, fires: 394, reach1: 58, reach2: 42, medianHigh: "+1.44%" },
    ],
  },
  "--ign-min-vol-min": {
    flag: "--ign-min-vol-min",
    scored: "2026-09-10, 11,596 fires",
    heldAt: "tpm >= 1,000",
    rows: [
      { value: null, fires: 1148, symbols: 229, reach1: 44, reach2: 30 },
      { value: 300000, fires: 475, symbols: 61, reach1: 55, reach2: 38 },
      { value: 500000, fires: 280, symbols: 30, reach1: 57, reach2: 39 },
      { value: 1000000, fires: 122, symbols: 11, reach1: 68, reach2: 55 },
    ],
  },
};

/** Tier bands are shaped differently: forward return by band, not by floor. */
export const TIER_EVIDENCE = {
  flag: "--ign-tiers",
  scored: "2026-09-18, 912 fires across 80 symbols, forward 30 minutes",
  bands: [
    { band: "<2,000", fires: 558, median: "+3.75%", over5: 41.9, over20: 14.3 },
    { band: "2,000-4,000", fires: 256, median: "+5.01%", over5: 50.4, over20: 18.4 },
    { band: "4,000-8,000", fires: 86, median: "+9.79%", over5: 72.1, over20: 20.9 },
    { band: ">8,000", fires: 12, median: "+29.23%", over5: 83.3, over20: 50.0 },
  ],
} as const;

export function hasEvidence(flag: string): boolean {
  return flag in EVIDENCE || flag === TIER_EVIDENCE.flag;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: `pass 24`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scenarios/tpm-rank-evidence.ts evidence.test.ts
git commit -m "feat: add measured tpm-rank evidence tables"
```

---

## Task 7: tpm-rank scenario

**Files:**
- Create: `scenarios/tpm-rank.ts`

- [ ] **Step 1: Build the evidence block and the prompt**

Create `scenarios/tpm-rank.ts`:

```ts
import type { Scenario } from "./index.js";
import { EVIDENCE, TIER_EVIDENCE } from "./tpm-rank-evidence.js";

/** Serialize the tables into the prompt so the model cannot invent numbers. */
function evidenceBlock(): string {
  const tables = Object.values(EVIDENCE).map((table) => {
    const rows = table.rows
      .map((r) => {
        const value = r.value === null ? "none" : r.value.toLocaleString("en-US");
        const symbols = r.symbols === undefined ? "" : ` symbols=${r.symbols}`;
        const high = r.medianHigh ? ` medianHigh=${r.medianHigh}` : "";
        return `  ${value}: fires=${r.fires}${symbols} reach+1%=${r.reach1}% reach+2%=${r.reach2}%${high}`;
      })
      .join("\n");
    const held = table.heldAt ? ` (held at ${table.heldAt})` : "";
    return `${table.flag} — scored ${table.scored}${held}\n${rows}`;
  });

  const bands = TIER_EVIDENCE.bands
    .map(
      (b) =>
        `  ${b.band}: fires=${b.fires} median=${b.median} >=5%=${b.over5}% >=20%=${b.over20}%`,
    )
    .join("\n");
  tables.push(`${TIER_EVIDENCE.flag} — scored ${TIER_EVIDENCE.scored}\n${bands}`);

  return tables.join("\n\n");
}

export const tpmRank: Scenario = {
  id: "tpm-rank",
  label: "Tune bb-tpm-rank ignition parameters",
  defaultPrompt:
    "Help me choose ignition parameters for bb-tpm-rank. Walk me through the " +
    "decisions that change what the table shows, and show me what each choice " +
    "costs and buys.",
  previewStyle: "hybrid",
  systemPrompt: `You help an experienced trader choose ignition parameters for \`bb-tpm-rank\`, a live trades/min ranking tool. You never run it; you produce an invocation and, later, a view design.

ASK ABOUT EXACTLY THESE EIGHT FLAGS, one or two at a time, in this order:
  --ign-sigma       (default 2.25)  sigma over the previous session both tpm and volume must clear
  --ign-min-tpm     (default 1000)  absolute trades/min floor
  --ign-min-vol-min (default 300000) absolute shares/min floor - the exit-ability test
  --ign-tiers       (default 2000,4000,8000) trades/min band cuts for the TIER tag
  --ign-on          (default 2.0)   STA/LTA trigger: 2s rate over 15s rate
  --ign-off         (default 1.2)   de-trigger that makes one burst one fire
  --pick-tpm        (default 2000)  trades/min a lit row needs to earn PICK=Y
  --pick-vol-min    (default 1000000) shares/min a lit row needs to earn PICK=Y

NEVER ask about --ign-max-price. It is pinned at 10 by operator instruction and is not a tunable choice. Do not offer it, mention it as an option, or include alternatives for it. State it as fixed if the final command is questioned.

MEASURED EVIDENCE — the only quantitative claims you may make:

${evidenceBlock()}

Any number in a preview or a rationale MUST come from the block above. For a flag with no table there (--ign-sigma, --ign-on, --ign-off, --pick-tpm, --pick-vol-min) say "no measured data - reasoning only" in the preview and argue qualitatively. Inventing a plausible statistic is the worst thing you can do here.

PREVIEW FORMAT. Every option gets a self-contained HTML preview, dark-surface, system font, no external resources. For a flag WITH evidence use this shape:
  - a four-cell strip: fires/day, symbols surviving, reach +1%, median high
  - one horizontal bar per candidate value showing symbols surviving, the current option's bar highlighted
  - all numeric cells RIGHT-JUSTIFIED (text-align:right; font-variant-numeric:tabular-nums)
For a flag WITHOUT evidence use a plain compact table of the same eight columns tpm-rank prints, and a one-line note saying no measured data exists.

Where a metric improves while the sample collapses, show the symbol count next to the hit rate. An optimum found where the sample is collapsing is not an optimum: at 1,000,000 shares/min the 68% describes eleven names on one day.

Use AskUserQuestion for every question. Never ask a question in your text output. Every option must be a concrete value; never offer "I'll decide later" or "something else".

The user may correct an earlier choice at any time. When they do, acknowledge it, say which other decisions it affects, and carry on from there.

PHASE 1 DELIVERABLE, when the user says to continue: the full invocation as a fenced bash block, then a short rationale per flag citing the evidence where it exists.

PHASE 2, only when the user asks to continue to design: produce ONE self-contained HTML document in a fenced \`\`\`html block - a dashboard view of tpm-rank output at those settings. The 27 available columns are RANK SYM CC 8K JUDGE SRC FLOAT RS ROT PICK TPM dTPM PRICE dPX dPX% 1m% RANGE dRNG IGN TIER SURGE VOL/MIN RAW BIAS BAR DRIFT AGE. Choose which earn space based on what the user tuned. Lit rows are green, as the real tool renders them. Numeric columns right-justified. No external fonts, scripts, or images.`,
};
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (exit 0). Task 5's dangling import now resolves.

- [ ] **Step 3: Verify the prompt embeds real numbers**

Run:

```bash
node --import tsx -e "import('./scenarios/tpm-rank.ts').then(m => { const p = m.tpmRank.systemPrompt; console.log(p.includes('symbols=61'), p.includes('symbols=11'), p.includes('--ign-max-price')); })"
```

Expected: `true true true` — the first two confirm evidence is embedded, the
third confirms the never-ask instruction is present.

- [ ] **Step 4: Commit**

```bash
git add scenarios/
git commit -m "feat: add tpm-rank scenario with evidence-bound previews"
```

---

## Task 8: Session

**Files:**
- Create: `session.ts`

- [ ] **Step 1: Implement Session**

Create `session.ts`:

```ts
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { END, MessageQueue } from "./queue.js";
import { PickStore, type Pick } from "./picks.js";
import { writeIfChanged } from "./snapshot.js";
import { getScenario, type Scenario } from "./scenarios/index.js";

export type Phase = "gather" | "design";

export type Outbound =
  | { type: "session"; id: string; scenario: string }
  | { type: "status"; text: string }
  | { type: "question"; id: string; question: unknown }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "picks"; picks: Pick[]; history: Pick[] }
  | { type: "phase"; phase: Phase }
  | { type: "design"; html: string }
  | { type: "done" };

const SESSION_DIR = ".sessions";

/** Pull one fenced ```html block out of a markdown text block. */
export function extractHtmlBlock(text: string): string | null {
  const match = text.match(/```html\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export class Session {
  readonly id: string;
  readonly scenario: Scenario;
  phase: Phase = "gather";

  private picks = new PickStore();
  private queue = new MessageQueue<string>();
  private pendingQuestions = new Map<
    string,
    { resolve: (label: string) => void; reject: (err: Error) => void }
  >();
  private running = false;
  private stderrLines: string[] = [];

  constructor(
    scenarioId: string | undefined,
    private readonly send: (payload: Outbound) => void,
    id?: string,
  ) {
    this.id = id ?? randomUUID();
    this.scenario = getScenario(scenarioId);
  }

  /** Restore picks from a previous process. Agent context is NOT restored. */
  static async rehydrate(
    id: string,
    scenarioId: string | undefined,
    send: (payload: Outbound) => void,
  ): Promise<Session> {
    const session = new Session(scenarioId, send, id);
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(join(SESSION_DIR, `${id}.json`), "utf8");
      session.picks = PickStore.fromJSON(raw);
    } catch {
      // No snapshot: a fresh session under a known id.
    }
    return session;
  }

  private async snapshot(): Promise<void> {
    try {
      await writeIfChanged(join(SESSION_DIR, `${this.id}.json`), this.picks.toJSON());
    } catch (err) {
      // A failed snapshot must never kill a live conversation.
      console.error(`[session ${this.id}] snapshot failed:`, err);
    }
  }

  private emitPicks(): void {
    this.send({ type: "picks", picks: this.picks.current(), history: this.picks.history() });
    void this.snapshot();
  }

  /** Push a user message into the live conversation. */
  say(text: string): void {
    this.queue.push(text);
  }

  answer(questionId: string, label: string): void {
    const waiter = this.pendingQuestions.get(questionId);
    if (!waiter) return;
    this.pendingQuestions.delete(questionId);
    waiter.resolve(label);
  }

  amend(pickId: string, label: string, description: string): void {
    const replacement = this.picks.amend(pickId, label, description);
    this.emitPicks();
    this.say(
      `Correction: for "${replacement.question}" I previously chose a ` +
        `different option. Use "${label}" instead. Keep the other decisions ` +
        `unless they conflict - if they do, say which ones change.`,
    );
  }

  toDesign(): void {
    this.phase = "design";
    this.send({ type: "phase", phase: "design" });
    this.say(
      "Stop gathering. Continue to Design: first give me the final invocation " +
        "and the per-flag rationale, then the phase 2 HTML dashboard document.",
    );
  }

  askMore(): void {
    this.say("Keep going - ask me the next decision.");
  }

  close(): void {
    for (const [, waiter] of this.pendingQuestions) {
      waiter.reject(new Error("client disconnected"));
    }
    this.pendingQuestions.clear();
    this.queue.close();
    void this.snapshot();
  }

  /** Start the single query() for this session. Safe to call once. */
  async start(firstPrompt: string): Promise<void> {
    if (this.running) {
      this.say(firstPrompt);
      return;
    }
    this.running = true;

    const restored = this.picks.current();
    if (restored.length > 0) {
      this.say(
        "Picks restored from a previous run (the conversation itself did not " +
          "survive): " +
          restored.map((p) => `${p.header} = ${p.label}`).join("; ") +
          `. ${firstPrompt}`,
      );
    } else {
      this.say(firstPrompt);
    }
    this.send({ type: "session", id: this.id, scenario: this.scenario.id });
    this.emitPicks();

    const queue = this.queue;
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = await queue.take();
        if (next === END) return;
        yield {
          type: "user",
          message: { role: "user", content: next },
          parent_tool_use_id: null,
          session_id: "",
        } as SDKUserMessage;
      }
    }

    try {
      for await (const msg of query({
        prompt: prompts(),
        options: {
          model: "sonnet",
          thinking: { type: "enabled", budgetTokens: 4000 },
          systemPrompt: this.scenario.systemPrompt,
          permissionMode: "default",
          tools: ["AskUserQuestion"],
          toolConfig: { askUserQuestion: { previewFormat: "html" } },
          stderr: (data: string) => {
            process.stderr.write(`[cli] ${data}`);
            this.stderrLines.push(data);
            if (this.stderrLines.length > 20) this.stderrLines.shift();
          },
          canUseTool: async (toolName, input) => {
            if (toolName === "ToolSearch" || toolName === "ExitPlanMode") {
              return { behavior: "allow", updatedInput: input };
            }
            if (toolName !== "AskUserQuestion") {
              return {
                behavior: "deny",
                message: "Ask the user another question with AskUserQuestion instead.",
              };
            }
            const questions = (input as { questions: Array<Record<string, any>> }).questions;
            const answers: Record<string, string> = {};
            this.send({ type: "status", text: "waiting for your pick..." });

            for (const q of questions) {
              const questionId = randomUUID();
              const label = await new Promise<string>((resolve, reject) => {
                this.pendingQuestions.set(questionId, { resolve, reject });
                this.send({ type: "question", id: questionId, question: q });
              });
              answers[q.question as string] = label;

              const chosen = (q.options as Array<{ label: string; description: string }>)
                .find((o) => o.label === label);
              this.picks.record({
                header: (q.header as string) ?? "",
                question: q.question as string,
                label,
                description: chosen?.description ?? "",
              });
              this.emitPicks();
            }
            this.send({ type: "status", text: "applying your choices..." });
            return { behavior: "allow", updatedInput: { questions, answers } };
          },
        },
      })) {
        if (msg.type === "system" && msg.subtype === "init") {
          this.send({ type: "status", text: "thinking..." });
        }
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              const html = this.phase === "design" ? extractHtmlBlock(block.text) : null;
              if (html) this.send({ type: "design", html });
              this.send({ type: "text", text: block.text });
            }
            if (block.type === "thinking") {
              this.send({ type: "thinking", text: block.thinking });
            }
            if (block.type === "tool_use") {
              this.send({ type: "status", text: `calling ${block.name}...` });
            }
          }
        }
        if (msg.type === "user") this.send({ type: "status", text: "generating..." });
        if (msg.type === "result") {
          this.send({ type: "status", text: "" });
          this.send({ type: "done" });
        }
      }
    } catch (err) {
      console.error("query() failed:", err);
      const detail = this.stderrLines.join("").trim();
      this.send({ type: "status", text: "" });
      this.send({
        type: "text",
        text: detail ? `Error: ${err}\n\n\`\`\`\n${detail}\n\`\`\`` : `Error: ${err}`,
      });
      this.send({ type: "done" });
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 2: Write the extractHtmlBlock test**

Create `session.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHtmlBlock } from "./session.js";

test("extracts a fenced html block", () => {
  const text = "Here you go:\n\n```html\n<h1>Hi</h1>\n```\n\nEnjoy.";
  assert.equal(extractHtmlBlock(text), "<h1>Hi</h1>");
});

test("returns null when no html block is present", () => {
  assert.equal(extractHtmlBlock("just prose"), null);
  assert.equal(extractHtmlBlock("```bash\nls\n```"), null);
});

test("takes the first html block when several exist", () => {
  const text = "```html\n<p>one</p>\n```\n```html\n<p>two</p>\n```";
  assert.equal(extractHtmlBlock(text), "<p>one</p>");
});
```

- [ ] **Step 3: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: `pass 27`, `fail 0`, then typecheck exit 0.

- [ ] **Step 4: Ignore the session directory**

Append to `../.gitignore` (repo root):

```
.sessions/
```

- [ ] **Step 5: Commit**

```bash
git add session.ts session.test.ts ../.gitignore
git commit -m "feat: add Session owning one streaming query per connection"
```

---

## Task 9: Rewrite server.ts as transport

**Files:**
- Modify: `server.ts` (full rewrite below)

- [ ] **Step 1: Replace the file**

`server.ts` becomes:

```ts
import "dotenv/config";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { Session, type Outbound } from "./session.js";

// Auth: this demo runs on the Claude CLI's own login (an Anthropic Max
// subscription). An ANTHROPIC_API_KEY in the environment takes precedence over
// that login, so a stale or placeholder value makes every request fail with
// 401 "API key is invalid". Drop it so the subscription login always wins.
// Set ANTHROPIC_AUTH=api-key to opt back into key-based billing instead.
if (process.env.ANTHROPIC_AUTH === "api-key") {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_AUTH=api-key but ANTHROPIC_API_KEY is not set.");
  } else {
    console.log("Auth: ANTHROPIC_API_KEY (key-based billing).");
  }
} else {
  if (process.env.ANTHROPIC_API_KEY) {
    delete process.env.ANTHROPIC_API_KEY;
    console.log("Ignoring ANTHROPIC_API_KEY so the CLI login is used.");
  }
  console.log("Auth: Claude CLI login (run `claude login` if this fails).");
}

const server = createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let session: Session | null = null;

  const send = (payload: Outbound) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  ws.on("message", (raw) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    void (async () => {
      switch (msg.type) {
        case "prompt": {
          if (!session) {
            session = msg.sessionId
              ? await Session.rehydrate(msg.sessionId, msg.scenario, send)
              : new Session(msg.scenario, send);
          }
          await session.start(msg.text);
          return;
        }
        case "answer":
          session?.answer(msg.id, msg.label);
          return;
        case "amend":
          session?.amend(msg.pickId, msg.label, msg.description ?? "");
          return;
        case "say":
          session?.say(msg.text);
          return;
        case "ask-more":
          session?.askMore();
          return;
        case "to-design":
          session?.toDesign();
          return;
      }
    })();
  });

  ws.on("close", () => {
    session?.close();
    session = null;
  });
});

server.listen(3001, () => {
  console.log("server on :3001, ws at /ws");
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Start the server and confirm it boots**

Run: `env -u CLAUDECODE npx tsx server.ts`
Expected stdout:

```
Auth: Claude CLI login (run `claude login` if this fails).
server on :3001, ws at /ws
```

Stop it with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "refactor: reduce server.ts to transport and routing"
```

---

## Task 10: Client transport

**Files:**
- Modify: `client/useAgentSocket.ts` (full rewrite below)

- [ ] **Step 1: Replace the hook**

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export type Option = { label: string; description: string; preview?: string };
export type Question = { question: string; header: string; options: Option[] };
export type PendingQuestion = { id: string; question: Question };
export type LogEntry = { kind: "text" | "thinking" | "note"; text: string };
export type Pick = {
  id: string;
  header: string;
  question: string;
  label: string;
  description: string;
  supersededBy?: string;
};
export type Phase = "gather" | "design";

const SESSION_KEY = "aqp.sessionId";

export function useAgentSocket(url: string) {
  const ws = useRef<WebSocket | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [history, setHistory] = useState<Pick[]>([]);
  const [phase, setPhase] = useState<Phase>("gather");
  const [design, setDesign] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let sock: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let shutdown = false;

    function connect() {
      sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => setConnected(true);
      sock.onclose = () => {
        setConnected(false);
        if (!shutdown) retry = setTimeout(connect, 1000);
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "session":
            try {
              localStorage.setItem(SESSION_KEY, msg.id);
            } catch {
              // Private mode or blocked storage: session just won't resume.
            }
            return;
          case "status":
            return setStatus(msg.text);
          case "question":
            return setPending({ id: msg.id, question: msg.question });
          case "picks":
            setPicks(msg.picks);
            setHistory(msg.history);
            return;
          case "phase":
            return setPhase(msg.phase);
          case "design":
            return setDesign(msg.html);
          case "text":
            return setLog((l) => [...l, { kind: "text", text: msg.text }]);
          case "thinking":
            return setLog((l) => [...l, { kind: "thinking", text: msg.text }]);
          case "done":
            setLog((l) => [...l, { kind: "note", text: "— done —" }]);
            setBusy(false);
            return;
        }
      };
    }
    connect();
    return () => {
      shutdown = true;
      clearTimeout(retry);
      sock?.close();
    };
  }, [url]);

  const post = useCallback((payload: Record<string, unknown>) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify(payload));
  }, []);

  const submit = useCallback(
    (prompt: string, scenario: string) => {
      let sessionId: string | null = null;
      try {
        sessionId = localStorage.getItem(SESSION_KEY);
      } catch {
        sessionId = null;
      }
      setLog([]);
      setDesign(null);
      setBusy(true);
      post({ type: "prompt", text: prompt, scenario, sessionId });
    },
    [post],
  );

  const answer = useCallback(
    (label: string) => {
      if (!pending) return;
      post({ type: "answer", id: pending.id, label });
      setPending(null);
      setLog((l) => [...l, { kind: "note", text: `→ chose: ${label}` }]);
    },
    [pending, post],
  );

  const amend = useCallback(
    (pickId: string, label: string, description: string) => {
      post({ type: "amend", pickId, label, description });
      setLog((l) => [...l, { kind: "note", text: `✎ changed to: ${label}` }]);
    },
    [post],
  );

  const say = useCallback((text: string) => {
    post({ type: "say", text });
    setLog((l) => [...l, { kind: "note", text: `→ ${text}` }]);
  }, [post]);

  const askMore = useCallback(() => post({ type: "ask-more" }), [post]);
  const toDesign = useCallback(() => post({ type: "to-design" }), [post]);

  return {
    log, pending, picks, history, phase, design,
    status, busy, connected,
    submit, answer, amend, say, askMore, toDesign,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: fails — `App.tsx` still calls `submit(prompt)` with one argument.
Fixed in Task 11. Do not commit yet.

---

## Task 11: PicksPanel and phase controls

**Files:**
- Create: `client/PicksPanel.tsx`
- Modify: `client/App.tsx`

- [ ] **Step 1: Create PicksPanel**

Create `client/PicksPanel.tsx`:

```tsx
import { useState } from "react";
import type { Pick } from "./useAgentSocket";

type Props = {
  picks: Pick[];
  history: Pick[];
  busy: boolean;
  onAmend: (pickId: string, label: string, description: string) => void;
  onAskMore: () => void;
  onToDesign: () => void;
  onSay: (text: string) => void;
};

export function PicksPanel({
  picks, history, busy, onAmend, onAskMore, onToDesign, onSay,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");

  return (
    <div style={{ borderTop: "1px solid #eee", paddingTop: 12, marginTop: 12 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 13, letterSpacing: ".06em", color: "#666" }}>
        YOUR PICKS
      </h3>

      {picks.length === 0 && (
        <p style={{ color: "#999", fontSize: 13 }}>Nothing chosen yet.</p>
      )}

      {picks.map((pick) => (
        <div key={pick.id} style={{ marginBottom: 8, fontSize: 13 }}>
          <div style={{ color: "#888", fontSize: 11, textTransform: "uppercase" }}>
            {pick.header}
          </div>
          {editing === pick.id ? (
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ flex: 1, fontSize: 13, padding: "2px 4px" }}
              />
              <button
                onClick={() => {
                  if (draft.trim()) onAmend(pick.id, draft.trim(), "changed by user");
                  setEditing(null);
                }}
              >
                Save
              </button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{pick.label}</strong>
              <button
                onClick={() => {
                  setEditing(pick.id);
                  setDraft(pick.label);
                }}
                style={{ fontSize: 11, cursor: "pointer" }}
              >
                edit
              </button>
            </div>
          )}
        </div>
      ))}

      {history.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
          <summary style={{ cursor: "pointer" }}>{history.length} superseded</summary>
          {history.map((pick) => (
            <div key={pick.id} style={{ textDecoration: "line-through", marginTop: 4 }}>
              {pick.header}: {pick.label}
            </div>
          ))}
        </details>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <button onClick={onAskMore} disabled={busy}>Ask me more</button>
        <button onClick={onToDesign} disabled={busy}>Continue to Design →</button>
      </div>

      <form
        style={{ display: "flex", gap: 4, marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          onSay(note.trim());
          setNote("");
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Tell the agent something..."
          style={{ flex: 1, fontSize: 13, padding: "3px 5px" }}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into App.tsx**

In `client/App.tsx`:

a. Extend the import from `./useAgentSocket` to include `type Pick`, and add
   `import { PicksPanel } from "./PicksPanel";` and
   `import { DesignPane } from "./DesignPane";`.

b. Replace the destructuring at `App()`'s top with:

```tsx
  const {
    log, pending, picks, history, phase, design,
    status, busy, connected,
    submit, answer, amend, say, askMore, toDesign,
  } = useAgentSocket("ws://localhost:3001/ws");

  const [scenario, setScenario] = useState("branding");
```

c. Immediately after `<LogView log={log} />` inside the `<aside>`, add:

```tsx
        <PicksPanel
          picks={picks}
          history={history}
          busy={busy}
          onAmend={amend}
          onAskMore={askMore}
          onToDesign={toDesign}
          onSay={say}
        />
```

d. Add a scenario selector directly above the prompt textarea in the `<section>`:

```tsx
        <select
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          disabled={busy}
          style={{ marginBottom: 8, fontSize: 13, padding: 4 }}
        >
          <option value="branding">Brand a SaaS product</option>
          <option value="tpm-rank">Tune bb-tpm-rank ignition parameters</option>
        </select>
```

e. Change the Run button's handler from `submit(prompt)` to
   `submit(prompt, scenario)`.

f. Where the final result is rendered, show the design pane when one exists:

```tsx
        {design && phase === "design" && <DesignPane html={design} />}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails — `./DesignPane` does not exist yet. Task 12 adds it.

---

## Task 12: DesignPane

**Files:**
- Create: `client/DesignPane.tsx`

- [ ] **Step 1: Create the sandboxed pane**

Create `client/DesignPane.tsx`:

```tsx
/**
 * Renders the phase-2 dashboard. It is a complete HTML document with its own
 * styles, so it goes in a sandboxed iframe rather than being inlined: inline
 * rendering would let its CSS bleed into the app shell, and the sandbox with
 * no allow-scripts means nothing in it can execute.
 */
export function DesignPane({ html }: { html: string }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".06em",
          color: "#888",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Designed view
      </div>
      <iframe
        title="Designed tpm-rank view"
        srcDoc={html}
        sandbox=""
        style={{
          width: "100%",
          height: 620,
          border: "1px solid #ddd",
          borderRadius: 6,
          background: "#fff",
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit the client work**

```bash
git add client/
git commit -m "feat: add picks panel, phase controls, and sandboxed design pane"
```

---

## Task 13: End-to-end smoke script

**Files:**
- Create: `scripts/smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create the script**

Create `scripts/smoke.mjs`:

```js
/**
 * End-to-end smoke run. Requires a live server (npm run dev) and a working
 * Claude CLI login. Answers every question with its first option, crosses the
 * phase gate, and asserts a design document arrives.
 *
 * Usage: node scripts/smoke.mjs [scenario]
 */
import { WebSocket } from "ws";

const scenario = process.argv[2] ?? "tpm-rank";
const ws = new WebSocket("ws://localhost:3001/ws");
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;

let questions = 0;
let picks = 0;
let gated = false;
let design = null;

const fail = (why) => {
  console.error(`${el()} FAIL: ${why}`);
  process.exit(1);
};

ws.on("open", () => {
  console.log(`${el()} connected, scenario=${scenario}`);
  ws.send(JSON.stringify({
    type: "prompt",
    scenario,
    text: "Walk me through the decisions.",
  }));
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "question") {
    questions++;
    const first = m.question.options[0];
    const previews = m.question.options.filter((o) => o.preview).length;
    console.log(`${el()} Q${questions} ${m.question.header}: ${first.label} (${previews}/${m.question.options.length} previews)`);
    ws.send(JSON.stringify({ type: "answer", id: m.id, label: first.label }));
  } else if (m.type === "picks") {
    picks = m.picks.length;
  } else if (m.type === "design") {
    design = m.html;
  } else if (m.type === "done") {
    if (!gated) {
      gated = true;
      console.log(`${el()} crossing phase gate with ${picks} picks`);
      ws.send(JSON.stringify({ type: "to-design" }));
      return;
    }
    if (questions === 0) fail("no questions were asked");
    if (picks === 0) fail("no picks were recorded");
    if (!design) fail("no design document arrived");
    console.log(`${el()} OK — ${questions} questions, ${picks} picks, design ${design.length} chars`);
    process.exit(0);
  }
});

ws.on("error", (e) => fail(e.message));
setTimeout(() => fail("timed out after 10 minutes"), 600_000);
```

- [ ] **Step 2: Add the script entry**

In `package.json` scripts, add:

```json
"smoke": "node scripts/smoke.mjs"
```

- [ ] **Step 3: Run it against a live server**

In one terminal: `env -u CLAUDECODE npm run dev`
In another: `npm run smoke tpm-rank`

Expected: a line per question, then
`OK — N questions, N picks, design NNNN chars` and exit 0.

If it reports `no design document arrived`, the model emitted the dashboard
without a ```html fence. Tighten the PHASE 2 wording in
`scenarios/tpm-rank.ts` and re-run.

- [ ] **Step 4: Verify picks survive a restart**

With the server still running and a session in progress, stop the server
(Ctrl-C) and start it again. Reload the browser. Expected: the picks panel
repopulates from `.sessions/<id>.json`, and the first message afterwards is
prefixed "Picks restored from a previous run".

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.mjs package.json
git commit -m "test: add end-to-end smoke driver"
```

---

## Task 14: Manual verification and README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Verify the branding scenario did not regress**

Run: `npm run smoke branding`
Expected: questions asked, picks recorded, exit 0. The branding scenario must
behave as it did before this work.

- [ ] **Step 2: Verify amend-forward by hand**

With `npm run dev` running and the tpm-rank scenario selected: answer two
questions, click `edit` on the first pick, change it, and save.

Expected: the picks panel shows the new value, "1 superseded" appears, and the
agent's next message acknowledges the change rather than re-asking.

- [ ] **Step 3: Verify --ign-max-price is never offered**

Run: `npm run smoke tpm-rank 2>&1 | grep -i "max-price"`
Expected: no output. If any question header or option mentions a price ceiling,
the never-ask instruction in `scenarios/tpm-rank.ts` needs strengthening.

- [ ] **Step 4: Document the scenarios in README.md**

Add a section after the existing description:

```markdown
## Scenarios

Pick one from the dropdown before running:

- **Brand a SaaS product** — the original demo: vibe, palette, typography,
  shape, spacing, ending in a markdown brand guide.
- **Tune bb-tpm-rank ignition parameters** — chooses eight ignition flags for
  `bb-tpm-rank`, with previews built only from the measured tables in that
  tool's `--help`. `--ign-max-price` is pinned at 10 and never offered.

Picks appear in the left panel and can be edited at any time; editing sends the
agent a correction rather than restarting the run. "Continue to Design" moves
to phase 2, which returns a dashboard view rendered in a sandboxed iframe.

Picks are snapshotted to `.sessions/<id>.json`. A server restart restores the
picks but not the agent's context, and the UI says so.
```

- [ ] **Step 5: Final check and commit**

```bash
npm test && npm run typecheck
git add README.md
git commit -m "docs: describe scenarios, picks, and phases"
```

Expected: `pass 27`, `fail 0`, typecheck exit 0.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Module split | 2, 3, 4, 5, 8, 9, 11, 12 |
| Session + message queue | 2, 8 |
| Teardown on socket close | 8 (`close()`), 9 (`ws.on("close")`) |
| Persistence + rehydrate | 3, 8, 13 step 4 |
| Amend-forward | 4, 8 (`amend()`), 11, 14 step 2 |
| Phase gate (3 controls) | 8 (`toDesign`/`askMore`/`say`), 11 |
| Asked parameters (8 flags) | 7 |
| Pinned `--ign-max-price` | 7, 14 step 3 |
| Evidence discipline | 6, 7 |
| Hybrid preview + right-justified | 7 (prompt) |
| Phase 1 / phase 2 deliverables | 7, 8 (`extractHtmlBlock`) |
| Iframe isolation | 12 |
| Error handling table | 8 (stderr, snapshot failure, disconnect) |
| Tests: picks, queue, smoke | 2, 4, 13 |

No spec requirement is unassigned.

**Known gaps, deliberately left:** the spec's "amend while agent is mid-turn
shows a queued state" is implemented as a plain queue push — the correction is
delivered when the generator next pulls, which is correct behaviour, but the
panel does not render a distinct "queued" badge. Add it if the manual check in
Task 14 step 2 shows the delay is confusing.

**Type consistency:** `Pick` is defined once in `picks.ts` and re-declared
structurally in `client/useAgentSocket.ts` (the client cannot import from the
server tree under this Vite root). The two must stay in sync; `supersededBy` is
optional in both. `Outbound` in `session.ts` is the single source of truth for
the wire protocol, and every `msg.type` the client switches on appears in it.
