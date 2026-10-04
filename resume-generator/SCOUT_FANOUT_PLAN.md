# Scout Fan-out Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In manifest mode, partition the file manifest into K size-balanced clusters and dispatch K `scout` subagents in parallel; each scout reads its cluster in its own context window and returns structured findings the lead aggregates before drafting.

**Architecture:** No new infrastructure — reuses the `Task`-based subagent pattern already wired for `researcher`. Adds (1) deterministic size-balanced partitioning in `loadContext`, (2) a `scout` agent type, (3) prompt changes telling the lead to dispatch all scouts in a single turn so they actually run in parallel.

**Tech Stack:** TypeScript, Claude Agent SDK (`query` + `agents` + `Task`), Node `fs`/`path`.

**Scope:** `resume-generator/resume-generator.ts` and `resume-generator/README.md`. No test infra exists in this demo; verification is smoke-runs against `/home/jjoravet/JJO_CV --pages 3`.

---

### Task 1: Add cluster partitioning to manifest mode

**Files:**
- Modify: `resume-generator/resume-generator.ts` — `loadContext` and the `Context` type.

**Design:**
- Constants near the top: `MAX_SCOUTS = 6`, `MIN_FILES_FOR_FANOUT = 5`, `SCOUT_BUCKET_TARGET_SIZE = 8`.
- New helper:

```ts
function partitionManifest(files: ManifestFile[]): ManifestFile[][] {
  if (files.length < MIN_FILES_FOR_FANOUT) return [];
  const k = Math.max(2, Math.min(MAX_SCOUTS, Math.ceil(files.length / SCOUT_BUCKET_TARGET_SIZE)));
  const buckets: { files: ManifestFile[]; bytes: number }[] = Array.from({ length: k }, () => ({ files: [], bytes: 0 }));
  for (const f of [...files].sort((a, b) => b.size - a.size)) {
    const smallest = buckets.reduce((best, b) => b.bytes < best.bytes ? b : best);
    smallest.files.push(f);
    smallest.bytes += f.size;
  }
  return buckets.map(b => b.files);
}
```

- Extend the manifest `Context` variant with `clusters: ManifestFile[][]` (empty array means "below fan-out threshold; lead reads directly").
- Log dispatch plan when `clusters.length > 0`: one line per cluster (`Cluster N: M files, B bytes`).

- [ ] Add the three constants and `partitionManifest`.
- [ ] Add `clusters` to the manifest `Context`; populate it in `loadContext`.
- [ ] Log the partition plan when `clusters.length > 0`.
- [ ] Smoke: `timeout 4 npx tsx resume-generator.ts "X" --context /home/jjoravet/JJO_CV --pages 3 2>&1 | head -30` — confirm K resolves and cluster sizes are roughly balanced.
- [ ] Commit: `feat(resume-generator): partition manifest into size-balanced scout clusters`.

---

### Task 2: Register the `scout` agent type

**Files:**
- Modify: `resume-generator/resume-generator.ts` — add `SCOUT_PROMPT`, extend `MY_AGENT_TYPES`, add a `scout` entry to the `agents:` block.

**Design:**
- `SCOUT_PROMPT`: instruct the scout to `Read` every file in its assigned list (paths injected by the lead in the Task prompt) and return structured markdown:

  ```
  ## Roles & Dates
  ## Discoveries / Projects
  ## Skills & Tools
  ## Education / Credentials
  ## Notable Phrasing (verbatim quotes worth reusing)
  ## Gaps or Conflicts
  ```

  Omit sections with no content. Never fabricate. Cite the source filename inline.
- Tools: `['Read']` only (no Web, no Write, no Bash).
- Model: `'sonnet'`.
- Add `'scout'` to `MY_AGENT_TYPES` so the existing `SubagentStart`/`SubagentStop` hooks log dispatch and completion.

- [ ] Add `SCOUT_PROMPT` constant.
- [ ] Register `scout` in the `agents:` block of the `query()` options.
- [ ] Add `'scout'` to `MY_AGENT_TYPES`.
- [ ] Syntax check: `npx tsx --check resume-generator.ts` → no output.
- [ ] Commit: `feat(resume-generator): add scout subagent type for parallel file ingestion`.

---

### Task 3: Lead workflow — dispatch scouts in parallel

**Files:**
- Modify: `resume-generator/resume-generator.ts` — `leadSystemPrompt` and the manifest-mode branch of the user prompt.

**Design:**
- **System prompt:** insert a new STEP 0 before the existing STEP 1:

  > **STEP 0 — Scout fan-out (mandatory when SCOUT CLUSTERS are present):**
  > Dispatch one `scout` Task call per cluster **in the same assistant message** (parallel tool_use blocks) — do not serialize, do not skip clusters. Each scout's Task prompt must include the cluster's absolute file paths and the instruction "Read all listed files and return structured findings." After all scouts return, aggregate the findings in your own context. Do NOT Read additional files unless a critical gap remains.

- **User prompt (manifest mode):** branch on `context.clusters.length > 0`:
  - With clusters → emit a `<scout-clusters>` block (one `<cluster id="N" bytes="B">` per cluster, each containing absolute paths). Drop the old "pick a few files" instruction.
  - Without clusters → keep current behavior (lead Reads directly).
- **Telemetry:** existing hooks already log `SubagentStart` / `SubagentStop` once `'scout'` is in `MY_AGENT_TYPES` — no new code.

- [ ] Add STEP 0 to `leadSystemPrompt`.
- [ ] Build the `<scout-clusters>` block; branch the manifest-mode prompt on `clusters.length > 0`.
- [ ] Smoke run: `npm start "Joseph J. Oravetz" -- --context /home/jjoravet/JJO_CV --pages 3 > /tmp/scout-run.log 2>&1`.
- [ ] Verify: `grep "Subagent started: scout" /tmp/scout-run.log | wc -l` equals K, and the start lines cluster together in time (parallel dispatch, not serial).
- [ ] Verify: `agent/custom_scripts/resume.docx` exists and content references projects from clusters the prior 3-file run skipped.
- [ ] Commit: `feat(resume-generator): dispatch scouts in parallel for manifest-mode triage`.

---

### Task 4: README update

**Files:**
- Modify: `resume-generator/README.md` — "Context modes" subsection and "How it works".

**Design:**
- Add a sentence to the manifest-mode paragraph: "When the directory contains ≥5 files, the lead fans out K scout subagents (K = ⌈N/8⌉, clamped to [2, 6]) in parallel; each reads one size-balanced cluster in its own context window and returns structured markdown findings."
- Insert a new step between current step 1 (triage) and step 2 (clarify) of "How it works":
  > 2. **Scout fan-out** (manifest mode, ≥5 files) — K scouts run in parallel, each ingests one size-balanced cluster and returns markdown findings the lead aggregates.
- Renumber the rest.

- [ ] Update README.
- [ ] Commit: `docs(resume-generator): document scout fan-out behavior`.

---

## End-to-end verification

After all four tasks:

1. Run: `cd resume-generator && npm start "Joseph J. Oravetz" -- --context /home/jjoravet/JJO_CV --pages 3`.
2. Confirm in stdout:
   - `📁 Manifest mode: 58 file(s) …`
   - Partition log showing K clusters with roughly balanced byte totals
   - K `↳ Subagent started: scout (…)` lines in close succession
   - K matching `↳ Subagent finished: scout (…)` lines
   - `📄 Resume saved to: …/resume.docx`
3. Open `resume.docx`; coverage should exceed the prior 3-file run (e.g., Sakhalin-III, Norwegian Barents, Mahato Block — all in files the prior run never read).

## Out of scope (deliberately)

- No JSON schema for scout output — markdown is easier for the lead to consume; the cost is no machine-side validation.
- No retry-on-scout-failure logic — `Task` already surfaces errors back to the lead, which can decide.
- No section-level draft parallelism — rejected in the prior recommendation (lead drafts 3 pages cheaply, section interdependencies create assembly headaches).
- No `PreCompact` hook wiring — orthogonal; a single-run context still fits comfortably.
