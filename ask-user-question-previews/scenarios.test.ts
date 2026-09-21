import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, getScenario } from "./scenarios/index.js";

test("every scenario supplies its own design prompt", () => {
  for (const [id, scenario] of Object.entries(SCENARIOS)) {
    assert.equal(scenario.id, id, `${id} is registered under the wrong key`);
    assert.equal(typeof scenario.designPrompt, "function", `${id} has no designPrompt`);
    assert.ok(scenario.designPrompt(1).length > 100, `${id} design prompt is too thin`);
  }
});

test("tpm-rank's design prompt carries simulated rows, labelled", () => {
  const prompt = SCENARIOS["tpm-rank"].designPrompt(7);
  assert.match(prompt, /SIMULATED/);
  assert.match(prompt, /RANK\s+SYM/, "should embed the tape table header");
  assert.match(prompt, /SIM[A-Z]/, "rows should use synthetic symbols");
});

test("the same seed yields the same tpm-rank design prompt", () => {
  assert.equal(
    SCENARIOS["tpm-rank"].designPrompt(3),
    SCENARIOS["tpm-rank"].designPrompt(3),
  );
});

// The bug this guards: the design instruction used to live in Session as one
// hardcoded string, so pressing "Continue to Design" on a branding
// conversation handed it a simulated market tape and asked for a per-flag
// rationale.
test("branding's design prompt contains no tpm-rank language", () => {
  const prompt = SCENARIOS.branding.designPrompt(7);
  for (const leak of [
    "tpm",
    "invocation",
    "per-flag",
    "SIMULATED",
    "VOL/MIN",
    "ign-",
  ]) {
    assert.ok(
      !prompt.toLowerCase().includes(leak.toLowerCase()),
      `branding design prompt leaked tpm-rank concept: ${leak}`,
    );
  }
});

test("branding's design prompt asks for a rendered page", () => {
  const prompt = SCENARIOS.branding.designPrompt(7);
  assert.match(prompt, /```html/);
  assert.match(prompt, /homepage/i);
});

test("both scenarios steer away from the retired Unsplash source API", () => {
  for (const scenario of Object.values(SCENARIOS)) {
    const all = scenario.systemPrompt + scenario.designPrompt(1);
    assert.ok(
      !all.includes("source.unsplash.com/") ||
        all.includes("Do NOT use source.unsplash.com"),
      `${scenario.id} recommends a dead image host`,
    );
  }
});

test("branding sources real imagery by searching; tpm-rank forbids images", () => {
  const branding = SCENARIOS.branding.systemPrompt;
  assert.match(branding, /WebSearch/, "branding should be told to search");
  assert.match(branding, /Special:FilePath/, "should use the fetch-free image URL");
  assert.match(branding, /403/, "should warn that WebFetch on wikimedia fails");
  assert.match(branding, /loremflickr/, "should name a fallback");
  assert.match(branding, /Never invent/i, "should forbid invented image URLs");

  // tpm-rank's ban sits in the system prompt, which is in force for the whole
  // conversation, so it covers the design turn too.
  assert.match(
    SCENARIOS["tpm-rank"].systemPrompt,
    /No external fonts, scripts, or images/i,
  );
  assert.ok(!/loremflickr|wikimedia/i.test(SCENARIOS["tpm-rank"].systemPrompt));
});

test("only branding may reach the network", () => {
  assert.deepEqual(SCENARIOS["tpm-rank"].tools, ["AskUserQuestion"]);
  assert.ok(SCENARIOS.branding.tools.includes("WebSearch"));
  assert.ok(SCENARIOS.branding.tools.includes("AskUserQuestion"));
});

test("getScenario falls back to the default for an unknown id", () => {
  assert.equal(getScenario("nope").id, "branding");
  assert.equal(getScenario(undefined).id, "branding");
});
