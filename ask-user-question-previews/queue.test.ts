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
