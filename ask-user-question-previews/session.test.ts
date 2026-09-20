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
