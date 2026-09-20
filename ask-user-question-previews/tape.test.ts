import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTape, SimulatedTape, tapeSample } from "./fixtures/tape.js";

test("the same seed always produces the same tape", () => {
  assert.deepEqual(tapeSample(10, 42), tapeSample(10, 42));
});

test("different seeds produce different tapes", () => {
  assert.notDeepEqual(tapeSample(10, 1), tapeSample(10, 2));
});

test("rows are ranked by trades/min, descending", () => {
  const rows = tapeSample(15, 7);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].tpm >= rows[i].tpm,
      `rank ${i} (${rows[i - 1].tpm}) must not be below rank ${i + 1} (${rows[i].tpm})`,
    );
    assert.equal(rows[i].rank, i + 1);
  }
});

test("symbols are synthetic so simulated rows cannot be mistaken for real ones", () => {
  for (const row of tapeSample(5, 3)) {
    assert.match(row.sym, /^SIM/, `${row.sym} must be a synthetic ticker`);
  }
});

test("only lit rows carry an IGN stamp and a tier", () => {
  for (const row of tapeSample(20, 11)) {
    if (row.lit) {
      assert.match(row.ign, /^\d+s$/);
    } else {
      assert.equal(row.ign, "");
      assert.equal(row.tier, "");
    }
  }
});

test("tier bands follow the configured cuts", () => {
  const tape = new SimulatedTape(5, [2000, 4000, 8000]);
  for (let i = 0; i < 30; i++) {
    for (const row of tape.tick()) {
      if (!row.lit) continue;
      if (row.tpm >= 8000) assert.equal(row.tier, "T3");
      else if (row.tpm >= 4000) assert.equal(row.tier, "T2");
      else if (row.tpm >= 2000) assert.equal(row.tier, "T1");
      else assert.equal(row.tier, "");
    }
  }
});

test("a tape produces at least one ignition over a realistic window", () => {
  const tape = new SimulatedTape(9);
  let lit = 0;
  for (let i = 0; i < 40; i++) {
    lit += tape.tick().filter((r) => r.lit).length;
  }
  assert.ok(lit > 0, "no ignitions in 40 buckets - the generator is inert");
});

test("volume per minute is consistent with trades per minute", () => {
  for (const row of tapeSample(8, 4)) {
    assert.ok(row.volMin > row.tpm, "each trade must move at least one share");
  }
});

test("formatTape right-justifies numeric columns", () => {
  const lines = formatTape(tapeSample(6, 2)).split("\n");
  assert.match(lines[0], /RANK/);
  assert.match(lines[1], /^-+$/);
  // Every body row must be the same width as the header: that is what
  // right-justification buys, and what a ragged column would break.
  for (const line of lines.slice(2)) {
    assert.equal(line.length, lines[0].length);
  }
});
