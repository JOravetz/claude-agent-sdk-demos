import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
  const dir = await scratch();
  const file = join(dir, "a.json");
  await writeIfChanged(file, "hello");
  const entries = await readdir(dir);
  assert.deepEqual(entries, ["a.json"]);
  await rm(dir, { recursive: true, force: true });
});
