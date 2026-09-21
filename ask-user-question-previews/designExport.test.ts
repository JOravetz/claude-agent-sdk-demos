import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_MIME,
  escapeForSrcdoc,
  sandboxedWrapper,
} from "./client/designExport.js";

test("the wrapper sandboxes the document", () => {
  const wrapper = sandboxedWrapper("<h1>hi</h1>", "Designed page");
  assert.match(wrapper, /<iframe sandbox="" srcdoc="/);
  assert.match(wrapper, /^<!DOCTYPE html>/);
});

test("ampersands escape before quotes, so entities are not doubled", () => {
  assert.equal(escapeForSrcdoc('&amp; "x"'), "&amp;amp; &quot;x&quot;");
});

// Each of these walks straight past a regex that strips <script> and quoted
// on* attributes, which is why the export does not rely on one.
const BYPASSES = [
  `<img src=x onerror=alert(1)>`, // unquoted handler
  `<scr<script>ipt>alert(1)</script>`, // nested tag
  `<svg><script>alert(1)</script></svg>`, // svg-namespaced
  `<body onload=alert(1)>`, // unquoted on body
  `<a href="javascript:alert(1)">x</a>`, // javascript: URL
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`, // nested srcdoc
];

test("a payload cannot break out of the srcdoc attribute", () => {
  for (const payload of BYPASSES) {
    const wrapper = sandboxedWrapper(payload, "t");
    const attr = wrapper.slice(
      wrapper.indexOf('srcdoc="') + 'srcdoc="'.length,
      wrapper.indexOf('"></iframe>'),
    );
    // Every double quote in the payload must be an entity inside the value,
    // otherwise the attribute closes early and the rest becomes live markup.
    assert.ok(!attr.includes('"'), `raw quote survived for: ${payload}`);
    assert.ok(
      wrapper.endsWith('"></iframe></body></html>'),
      `wrapper structure broken by: ${payload}`,
    );
  }
});

test("a quote-led breakout attempt stays inside the attribute", () => {
  const payload = `"><script>alert(1)</script><x y="`;
  const wrapper = sandboxedWrapper(payload, "t");
  assert.ok(wrapper.includes("&quot;&gt;<script>") === false);
  assert.match(wrapper, /srcdoc="&quot;>/);
  // Exactly one iframe: the payload did not manufacture more markup.
  assert.equal((wrapper.match(/<iframe/g) || []).length, 1);
});

test("the title is escaped too", () => {
  const wrapper = sandboxedWrapper("<p>x</p>", '"><script>alert(1)</script>');
  assert.match(wrapper, /<title>&quot;>/);
});

test("downloads do not use a renderable HTML MIME type", () => {
  assert.equal(DOWNLOAD_MIME, "application/octet-stream");
  assert.ok(!DOWNLOAD_MIME.includes("html"));
});
