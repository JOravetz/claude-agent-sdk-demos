/**
 * End-to-end smoke run. Requires a live server (npm run dev) and a working
 * Claude CLI login. Answers every question with its first option, crosses the
 * phase gate, and asserts a design document arrives.
 *
 * Usage: node scripts/smoke.mjs [scenario]
 */
import { WebSocket } from "ws";

const scenario = process.argv[2] ?? "tpm-rank";
const ws = new WebSocket("ws://localhost:3001/ws");
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;

let questions = 0;
let picks = 0;
let gated = false;
let design = null;

const fail = (why) => {
  console.error(`${el()} FAIL: ${why}`);
  process.exit(1);
};

ws.on("open", () => {
  console.log(`${el()} connected, scenario=${scenario}`);
  ws.send(
    JSON.stringify({
      type: "prompt",
      scenario,
      text: "Walk me through the decisions.",
    }),
  );
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "question") {
    questions++;
    const first = m.question.options[0];
    const previews = m.question.options.filter((o) => o.preview).length;
    console.log(
      `${el()} Q${questions} ${m.question.header}: ${first.label} (${previews}/${m.question.options.length} previews)`,
    );
    ws.send(JSON.stringify({ type: "answer", id: m.id, label: first.label }));
  } else if (m.type === "picks") {
    picks = m.picks.length;
  } else if (m.type === "design") {
    design = m.html;
  } else if (m.type === "done") {
    if (!gated) {
      gated = true;
      console.log(`${el()} crossing phase gate with ${picks} picks`);
      ws.send(JSON.stringify({ type: "to-design" }));
      return;
    }
    if (questions === 0) fail("no questions were asked");
    if (picks === 0) fail("no picks were recorded");
    if (!design) fail("no design document arrived");
    console.log(
      `${el()} OK — ${questions} questions, ${picks} picks, design ${design.length} chars`,
    );
    process.exit(0);
  }
});

ws.on("error", (e) => fail(e.message));
setTimeout(() => fail("timed out after 10 minutes"), 600_000);
