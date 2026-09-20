# justfile manual

Recipes have one name each. Recipes that take arguments own their argument
list and accept a long and a short form of every flag; the two are
interchangeable:

```bash
just agent --scenario branding --verbose
just agent -s branding -v
```

Every argument-taking recipe answers `-h` / `--help` with its own usage and
examples. `just` on its own prints the summary; `just guide` prints this file.

---

## The one you want: `just agent`

Starts the stack if it isn't up, then drives one scenario from the first
question through the phase gate to a rendered dashboard. Answers every question
with its first option, so it is a smoke test, not a design session — use the
browser when you want to make the choices yourself.

```bash
just agent                       # tpm-rank, start the stack, leave it running
just agent -s branding           # the original branding demo
just agent --scenario branding   # identical, long form
just agent -s tpm-rank -v        # short flags, shell traced
just agent -n                    # drive a server that is ALREADY up
just agent -s branding -x        # run it, then tear the stack down
just agent -t 900                # allow 15 minutes instead of 10
```

| flag | long | meaning |
|---|---|---|
| `-s` | `--scenario` | `tpm-rank` (default) or `branding` |
| `-n` | `--no-start` | require a running server; don't start one |
| `-k` | `--keep` | leave the stack up afterwards (default) |
| `-x` | `--stop` | tear the stack down afterwards |
| `-t` | `--timeout` | seconds before giving up (default 600) |
| `-v` | `--verbose` | trace the shell |
| `-h` | `--help` | usage |

An unknown scenario or a non-numeric timeout is rejected **before** anything
starts, so a typo costs nothing.

`--timeout` matters more than it looks. A tpm-rank run generates four
self-contained HTML previews per question; first turns of 30–60 seconds are
normal and several minutes has been observed. Exit code 124 means the timeout
fired while the agent was still working — not a failure of the code.

---

## Daily loop

```bash
just install          # once
just doctor           # before the first run of the day
just up               # detached, logs to .dev.log
just open             # prints http://localhost:5173
just logs             # tail the server log, Ctrl-C to stop tailing
just down             # stop everything, including stray CLI children
```

`just dev` is the foreground equivalent of `up` if you'd rather watch it.

---

## `just doctor`

Checks the five things that have actually broken this demo:

```
node          version 18+
dependencies  node_modules present
auth          which credential path is live, and whether .env is sabotaging it
nesting       whether CLAUDECODE is set
ports         :3001 and :5173
strays        claude CLI children under the server
```

Two of those deserve explanation.

**auth** — the SDK spawns the Claude CLI, and an `ANTHROPIC_API_KEY` in the
environment takes precedence over your `claude login`. A `.env` still holding
the literal `sk-ant-...` placeholder from `.env.example` is a *value*, so every
request fails with `401 API key is invalid`. `doctor` fails loudly on exactly
that string. The server also drops an inherited key by default; set
`ANTHROPIC_AUTH=api-key` to opt into key-based billing.

**strays** — each open browser tab holds one CLI child. More children than tabs
means sessions aren't being torn down. `just down` kills them.

---

## `just tape`

Prints the deterministic simulated tape the design phase renders against. The
demo never runs `bb-tpm-rank` and never reads live market data, so this is what
phase 2 draws. Same `--ticks` and `--seed` always give the same rows.

```bash
just tape                     # 14 ticks, seed 7
just tape -n 40               # later in the session — more ignitions
just tape --ticks 5 --seed 3  # long form
just tape -n 30 -S 11         # short flags
```

```
RANK  SYM        TPM    dTPM     PRICE     1m%   IGN  TIER    VOL/MIN
---------------------------------------------------------------------
   1  SIME      7363    +537   10.8185  +1.40%   10s    T2  1,163,354
   2  SIMN      7066    +346   13.9318  +6.42%   35s    T2  3,165,568
   3  SIMJ      2899    -629    3.4292  +2.19%   15s    T1    866,801
```

Symbols are synthetic on purpose. Real tickers carrying invented trade rates
would be indistinguishable from a recorded session in a screenshot.

---

## Checks

```bash
just test         # unit tests — node:test, no network, no CLI
just typecheck    # tsc --noEmit
just check        # both
```

`just check` is the gate before a commit. None of it touches the API, so it is
fast and free.

For a live check use `just smoke`, which drives an already-running server and
neither starts nor stops anything:

```bash
just up
just smoke -s branding    # regression-check the original demo
just smoke                # tpm-rank
```

---

## Inspecting state

```bash
just sessions     # stored snapshots, with how many live picks each holds
just ps           # server, client, and any CLI children
```

Picks are snapshotted to `.sessions/<uuid>.json` as you make them. A server
restart restores the picks but *not* the agent's context — the UI says so rather
than pretending the conversation continued.

```
SESSION                                 PICKS  MODIFIED
446e9cec-4350-4b6f-9395-2631c282411f        2  2026-09-20 06:15
```

---

## Cleaning

```bash
just clean        # .sessions and .dev.log
just distclean    # also node_modules
```

---

## Running from inside a Claude Code session

The CLI refuses to start inside another Claude Code session:

```
Error: Claude Code cannot be launched inside another Claude Code session.
```

Every recipe that reaches the CLI strips `CLAUDECODE` first, so `just agent`,
`just dev` and `just up` work from anywhere. A bare `npm run dev` will not —
use the recipe, or `env -u CLAUDECODE npm run dev`.

`just doctor` warns when it sees `CLAUDECODE` set, so the failure is diagnosed
before you hit it.

---

## Exit codes

| code | meaning |
|---:|---|
| `0` | success |
| `1` | runtime failure — server wouldn't start, nothing listening, smoke assertion failed |
| `2` | bad arguments — unknown flag, unknown scenario, non-numeric number |
| `124` | `--timeout` fired; the agent was still working |
