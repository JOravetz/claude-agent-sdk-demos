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
  assert.deepEqual(
    rows.map((r) => r.value),
    [null, 300000, 500000, 1000000],
  );
  assert.deepEqual(
    rows.map((r) => r.symbols),
    [229, 61, 30, 11],
  );
  assert.deepEqual(
    rows.map((r) => r.fires),
    [1148, 475, 280, 122],
  );
});

test("hasEvidence distinguishes measured flags from unmeasured ones", () => {
  assert.equal(hasEvidence("--ign-min-vol-min"), true);
  assert.equal(hasEvidence("--ign-on"), false);
});
