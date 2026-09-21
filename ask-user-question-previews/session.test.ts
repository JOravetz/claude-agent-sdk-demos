import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHtmlBlock,
  isValidSessionId,
  Session,
  stripPreviews,
} from "./session.js";

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

test("valid UUIDs are accepted as session ids", () => {
  assert.equal(isValidSessionId("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), true);
});

test("path traversal attempts are rejected", () => {
  for (const bad of [
    "../../../etc/passwd",
    "../../.bashrc",
    "a/b",
    "..",
    "3f2504e0-4f89-41d3-9a0c-0305e82c3301/../../x",
    "",
  ]) {
    assert.equal(isValidSessionId(bad), false, `${bad} must be refused`);
  }
});

test("a session given a traversal id issues a fresh UUID instead", () => {
  const session = new Session("branding", () => {}, "../../../etc/passwd");
  assert.equal(isValidSessionId(session.id), true);
  assert.ok(!session.id.includes("/"));
});

test("close() marks the session torn down", () => {
  const session = new Session("branding", () => {});
  assert.equal(session.closed, false);
  session.close();
  assert.equal(session.closed, true);
});

test("close() is idempotent", () => {
  const session = new Session("branding", () => {});
  session.close();
  session.close();
  assert.equal(session.closed, true);
});

test("close() stops further messages reaching the agent", () => {
  const session = new Session("branding", () => {});
  session.close();
  // Must not throw: the UI can still fire handlers as a socket tears down.
  session.say("late message");
  session.askMore();
  assert.equal(session.closed, true);
});

// --- snapshot persistence -------------------------------------------------
// Session.rehydrate reads .sessions/<id>.json relative to cwd, so these write
// a real file under a throwaway UUID and clean it up.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

async function withSnapshot(
  body: string,
  fn: (id: string) => Promise<void>,
): Promise<void> {
  const id = randomUUID();
  const file = join(".sessions", `${id}.json`);
  await mkdir(".sessions", { recursive: true });
  await writeFile(file, body, "utf8");
  try {
    await fn(id);
  } finally {
    await rm(file, { force: true });
  }
}

test("rehydrate restores picks, phase and the deliverable", async () => {
  const snapshot = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "design",
    picks: {
      nextId: 2,
      picks: [
        { id: "p1", header: "Vibe", question: "Which vibe?", label: "Editorial", description: "d" },
      ],
    },
    deliverable: "# Brand Guide\n\nDeep Forest #1F2B25",
    designs: ["<h1>mock</h1>"],
  });

  await withSnapshot(snapshot, async (id) => {
    const sent: unknown[] = [];
    const session = await Session.rehydrate(id, "branding", (p) => sent.push(p));
    assert.equal(session.phase, "design");
    assert.equal(session.picksForTest.length, 1);
    assert.equal(session.picksForTest[0].label, "Editorial");
    assert.match(session.deliverableForTest ?? "", /Deep Forest/);
    assert.deepEqual(session.designsForTest, ["<h1>mock</h1>"]);
  });
});

test("rehydrate still reads a legacy picks-only snapshot", async () => {
  const legacy = JSON.stringify({
    nextId: 2,
    picks: [
      { id: "p1", header: "Vibe", question: "Which vibe?", label: "Editorial", description: "d" },
    ],
  });

  await withSnapshot(legacy, async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.equal(session.picksForTest.length, 1);
    assert.equal(session.phase, "gather");
    assert.equal(session.deliverableForTest, undefined);
  });
});

test("rehydrate survives a corrupt snapshot", async () => {
  await withSnapshot("{not json", async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.equal(session.picksForTest.length, 0);
  });
});

// --- preview stripping ----------------------------------------------------
test("stripPreviews removes preview HTML but keeps everything else", () => {
  const questions = [
    {
      question: "Which vibe?",
      header: "Vibe",
      options: [
        { label: "A", description: "first", preview: "<div>huge</div>" },
        { label: "B", description: "second", preview: "<div>also huge</div>" },
      ],
    },
  ];

  const lean = stripPreviews(questions);
  assert.equal(lean[0].question, "Which vibe?");
  assert.equal(lean[0].header, "Vibe");
  assert.equal(lean[0].options.length, 2);
  assert.equal(lean[0].options[0].label, "A");
  assert.equal(lean[0].options[0].description, "first");
  assert.ok(!("preview" in lean[0].options[0]));
  assert.ok(!("preview" in lean[0].options[1]));
});

test("stripPreviews does not mutate the caller's questions", () => {
  const questions = [
    { question: "q", header: "h", options: [{ label: "A", description: "d", preview: "<p>x</p>" }] },
  ];
  stripPreviews(questions);
  assert.equal(questions[0].options[0].preview, "<p>x</p>");
});

test("stripPreviews is a large saving on a realistic question", () => {
  const preview = "<div style='padding:20px'>".repeat(60) + "</div>".repeat(60);
  const questions = [
    {
      question: "Which palette?",
      header: "Palette",
      options: Array.from({ length: 4 }, (_, i) => ({
        label: `Option ${i}`,
        description: "a short description",
        preview,
      })),
    },
  ];

  const before = JSON.stringify(questions).length;
  const after = JSON.stringify(stripPreviews(questions)).length;
  assert.ok(after < before / 10, `expected >90% saving, got ${before} -> ${after}`);
});

test("stripPreviews copes with options that never had a preview", () => {
  const questions = [
    { question: "q", header: "h", options: [{ label: "A", description: "d" }] },
  ];
  const lean = stripPreviews(questions);
  assert.equal(lean[0].options[0].label, "A");
});

test("a pre-migration snapshot's single design is carried forward as a list", async () => {
  const legacy = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "design",
    picks: { nextId: 1, picks: [] },
    design: "<h1>old single</h1>",
  });
  await withSnapshot(legacy, async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.deepEqual(session.designsForTest, ["<h1>old single</h1>"]);
  });
});

test("multiple designs accumulate rather than replacing each other", async () => {
  const snapshot = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "design",
    picks: { nextId: 1, picks: [] },
    designs: ["<h1>one</h1>", "<h1>two</h1>"],
  });
  await withSnapshot(snapshot, async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.equal(session.designsForTest.length, 2);
    assert.equal(session.designsForTest[1], "<h1>two</h1>");
  });
});
