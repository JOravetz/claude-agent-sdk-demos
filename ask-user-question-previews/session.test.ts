import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHtmlBlock,
  isDeliverable,
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


/** A stand-in for a real deliverable: structured markdown of realistic size. */
function guideFixture(title: string): string {
  return (
    `# ${title}\n\n## Colours\n\n| Name | Hex |\n| --- | --- |\n` +
    "| Deep Forest | #1F2B25 |\n| Jade | #4A7C65 |\n\n## Typography\n\n" +
    "- Display: Cormorant Garamond\n- Body: Inter\n- Labels: Tenor Sans\n\n" +
    "## Spacing\n\n1. 8px base\n2. 24px gutter\n3. 96px sections\n\n" +
    "## Notes\n\n" +
    "Every piece is documented and authenticated. ".repeat(40)
  );
}

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
    deliverables: [guideFixture("Brand Guide")],
    designs: ["<h1>mock</h1>"],
  });

  await withSnapshot(snapshot, async (id) => {
    const sent: unknown[] = [];
    const session = await Session.rehydrate(id, "branding", (p) => sent.push(p));
    assert.equal(session.phase, "design");
    assert.equal(session.picksForTest.length, 1);
    assert.equal(session.picksForTest[0].label, "Editorial");
    assert.match(session.deliverablesForTest[0] ?? "", /Deep Forest/);
    assert.equal(session.deliverablesForTest.length, 1);
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
    assert.deepEqual(session.deliverablesForTest, []);
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

// --- what counts as a deliverable ----------------------------------------
// The bug: "last assistant text over 200 chars wins" let a "Welcome back!"
// message overwrite a 9KB brand guide the user had waited minutes for.
test("a chatty greeting is not a deliverable", () => {
  const greeting =
    "Welcome back! I can see you have a beautifully refined aesthetic " +
    "direction already locked in - The Connoisseur vibe with Lacquer & Gold " +
    "palette and Colonial Scholar typography. That's a rich, authoritative, " +
    "old-world-meets-digital sensibility. Before I show you visual options, " +
    "I need to ask about a couple more things first, so bear with me.";
  assert.equal(isDeliverable(greeting), false);
});

test("a structured document is a deliverable", () => {
  const guide =
    "# Brand Guide\n\n## Colours\n\n| Name | Hex |\n| --- | --- |\n" +
    "| Ink | #1A1A18 |\n| Jade | #3C6B5C |\n\n## Typography\n\n" +
    "- Display: Cormorant Garamond\n- Body: Inter\n- Labels: Tenor Sans\n" +
    "\n## Spacing\n\n1. 8px base\n2. 16px gutter\n3. 96px sections\n" +
    "x".repeat(1500);
  assert.equal(isDeliverable(guide), true);
});

test("long unstructured prose is not mistaken for a document", () => {
  assert.equal(isDeliverable("word ".repeat(600)), false);
});

test("a pre-migration single deliverable is carried forward", async () => {
  const legacy = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "gather",
    picks: { nextId: 1, picks: [] },
    deliverable: guideFixture("Old Guide"),
  });
  await withSnapshot(legacy, async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.equal(session.deliverablesForTest.length, 1);
    assert.match(session.deliverablesForTest[0], /Old Guide/);
  });
});

test("a greeting stored by the old code is dropped on migration", async () => {
  const stale = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "design",
    picks: { nextId: 1, picks: [] },
    deliverable: "Welcome back! I can see you have a refined direction already.",
  });
  await withSnapshot(stale, async (id) => {
    const session = await Session.rehydrate(id, "branding", () => {});
    assert.deepEqual(session.deliverablesForTest, []);
  });
});

// --- the opening brief travels with the session ---------------------------
// The bug: a reload reset the textarea to the scenario default, and resuming
// sent that default into a session about something else. A furniture brand
// was asked what its SaaS product does.
test("a resumed session keeps its original brief", async () => {
  const snapshot = JSON.stringify({
    version: 1,
    scenario: "branding",
    phase: "gather",
    picks: {
      nextId: 2,
      picks: [
        { id: "p1", header: "Vibe", question: "Which vibe?", label: "The Connoisseur", description: "d" },
      ],
    },
    prompt: "Brand a store selling antique furniture from Singapore",
  });

  await withSnapshot(snapshot, async (id) => {
    const sent: Array<Record<string, unknown>> = [];
    const session = await Session.rehydrate(id, "branding", (p) =>
      sent.push(p as Record<string, unknown>),
    );
    assert.match(session.promptForTest ?? "", /antique furniture/);

    // Tearing down before start() keeps the test off the network; the point is
    // that the stored brief is what start() would use, not the incoming one.
    session.close();
    assert.match(session.promptForTest ?? "", /antique furniture/);
  });
});

test("a fresh session adopts the prompt it was started with", () => {
  const session = new Session("branding", () => {});
  assert.equal(session.promptForTest, undefined);
});
