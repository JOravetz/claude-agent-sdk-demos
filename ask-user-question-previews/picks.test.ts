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
