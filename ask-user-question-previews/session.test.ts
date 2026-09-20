import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHtmlBlock, isValidSessionId, Session } from "./session.js";

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
