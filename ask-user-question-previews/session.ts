import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { END, MessageQueue } from "./queue.js";
import { PickStore, type Pick } from "./picks.js";
import { writeIfChanged } from "./snapshot.js";
import { getScenario, type Scenario } from "./scenarios/index.js";
import { formatTape, tapeSample } from "./fixtures/tape.js";

export type Phase = "gather" | "design";

export type Outbound =
  | { type: "session"; id: string; scenario: string }
  | { type: "status"; text: string }
  | { type: "question"; id: string; question: unknown }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "picks"; picks: Pick[]; history: Pick[] }
  | { type: "phase"; phase: Phase }
  | { type: "design"; html: string }
  | { type: "done" };

type AskedQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description: string; preview?: string }>;
};

const SESSION_DIR = ".sessions";

/**
 * Session ids reach us from the browser and end up in a file path, for both
 * reads and writes. Anything but a literal UUID is refused: a crafted id such
 * as "../../../.bashrc" would otherwise let a client choose where snapshot()
 * writes. Validated in the constructor so every path that sets `this.id` --
 * including rehydrate() -- is covered.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/** Pull one fenced ```html block out of a markdown text block. */
export function extractHtmlBlock(text: string): string | null {
  const match = text.match(/```html\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export class Session {
  readonly id: string;
  readonly scenario: Scenario;
  phase: Phase = "gather";

  private picks = new PickStore();
  private queue = new MessageQueue<string>();
  private pendingQuestions = new Map<
    string,
    { resolve: (label: string) => void; reject: (err: Error) => void }
  >();
  private running = false;
  private stderrLines: string[] = [];
  /**
   * Aborting is what actually stops the spawned CLI. Closing the queue only
   * sets a flag, so if query() is not currently awaiting take() -- mid-turn, or
   * idle after a turn -- it never observes END and the child process outlives
   * the socket. Every abandoned tab would leak a CLI.
   */
  private readonly abort = new AbortController();

  constructor(
    scenarioId: string | undefined,
    private readonly send: (payload: Outbound) => void,
    id?: string,
  ) {
    if (id !== undefined && !isValidSessionId(id)) {
      console.warn(`[session] refusing malformed session id; issuing a fresh one`);
      id = undefined;
    }
    this.id = id ?? randomUUID();
    this.scenario = getScenario(scenarioId);
  }

  /** Restore picks from a previous process. Agent context is NOT restored. */
  static async rehydrate(
    id: string,
    scenarioId: string | undefined,
    send: (payload: Outbound) => void,
  ): Promise<Session> {
    const session = new Session(scenarioId, send, id);
    // Read by the VALIDATED id the constructor settled on, never the raw
    // argument: a rejected id gets a fresh UUID with no snapshot to load.
    try {
      const raw = await readFile(join(SESSION_DIR, `${session.id}.json`), "utf8");
      session.picks = PickStore.fromJSON(raw);
    } catch {
      // No snapshot: a fresh session under a known id.
    }
    return session;
  }

  private async snapshot(): Promise<void> {
    try {
      await writeIfChanged(
        join(SESSION_DIR, `${this.id}.json`),
        this.picks.toJSON(),
      );
    } catch (err) {
      // A failed snapshot must never kill a live conversation.
      console.error(`[session ${this.id}] snapshot failed:`, err);
    }
  }

  private emitPicks(): void {
    this.send({
      type: "picks",
      picks: this.picks.current(),
      history: this.picks.history(),
    });
    void this.snapshot();
  }

  /** Push a user message into the live conversation. */
  say(text: string): void {
    this.queue.push(text);
  }

  answer(questionId: string, label: string): void {
    const waiter = this.pendingQuestions.get(questionId);
    if (!waiter) return;
    this.pendingQuestions.delete(questionId);
    waiter.resolve(label);
  }

  amend(pickId: string, label: string, description: string): void {
    const replacement = this.picks.amend(pickId, label, description);
    this.emitPicks();
    this.say(
      `Correction: for "${replacement.question}" I previously chose a ` +
        `different option. Use "${label}" instead. Keep the other decisions ` +
        `unless they conflict - if they do, say which ones change.`,
    );
  }

  toDesign(): void {
    this.phase = "design";
    this.send({ type: "phase", phase: "design" });

    // The market may be closed and the demo never runs bb-tpm-rank, so supply
    // rows rather than letting the model invent them. Seeded from the session
    // id: different sessions get different tapes, each one reproducible.
    const seed = [...this.id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 7);
    const rows = formatTape(tapeSample(14, seed));

    this.say(
      "Stop gathering. Continue to Design: first give me the final invocation " +
        "and the per-flag rationale, then the phase 2 HTML dashboard document.\n\n" +
        "Render the dashboard against exactly these rows. They are SIMULATED - " +
        "synthetic symbols, not a recorded session - and the dashboard must say " +
        "so visibly. Do not add, rename, or re-price any row.\n\n" +
        "```\n" +
        rows +
        "\n```",
    );
  }

  askMore(): void {
    this.say("Keep going - ask me the next decision.");
  }

  close(): void {
    for (const [, waiter] of this.pendingQuestions) {
      waiter.reject(new Error("client disconnected"));
    }
    this.pendingQuestions.clear();
    this.queue.close();
    // Order matters: close the queue first so a generator that IS waiting
    // unwinds cleanly, then abort to kill a CLI that is not reading from it.
    if (!this.abort.signal.aborted) this.abort.abort();
    void this.snapshot();
  }

  /** True once close() has torn the session down. Exposed for tests. */
  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  /** Start the single query() for this session. Safe to call more than once. */
  async start(firstPrompt: string): Promise<void> {
    if (this.running) {
      this.say(firstPrompt);
      return;
    }
    this.running = true;

    const restored = this.picks.current();
    if (restored.length > 0) {
      this.say(
        "Picks restored from a previous run (the conversation itself did not " +
          "survive): " +
          restored.map((p) => `${p.header} = ${p.label}`).join("; ") +
          `. ${firstPrompt}`,
      );
    } else {
      this.say(firstPrompt);
    }
    this.send({ type: "session", id: this.id, scenario: this.scenario.id });
    this.emitPicks();

    const queue = this.queue;
    async function* prompts(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = await queue.take();
        if (next === END) return;
        yield {
          type: "user",
          message: { role: "user", content: next },
          parent_tool_use_id: null,
          session_id: "",
        };
      }
    }

    try {
      for await (const msg of query({
        prompt: prompts(),
        options: {
          model: "sonnet",
          abortController: this.abort,
          thinking: { type: "enabled", budgetTokens: 4000 },
          systemPrompt: this.scenario.systemPrompt,
          permissionMode: "default",
          tools: ["AskUserQuestion"],
          toolConfig: { askUserQuestion: { previewFormat: "html" } },
          stderr: (data: string) => {
            process.stderr.write(`[cli] ${data}`);
            this.stderrLines.push(data);
            if (this.stderrLines.length > 20) this.stderrLines.shift();
          },
          canUseTool: async (toolName, input) => {
            if (toolName === "ToolSearch" || toolName === "ExitPlanMode") {
              return { behavior: "allow", updatedInput: input };
            }
            if (toolName !== "AskUserQuestion") {
              return {
                behavior: "deny",
                message:
                  "Ask the user another question with AskUserQuestion instead.",
              };
            }
            const questions = (input as { questions: AskedQuestion[] }).questions;
            const answers: Record<string, string> = {};
            this.send({ type: "status", text: "waiting for your pick..." });

            for (const q of questions) {
              const questionId = randomUUID();
              const label = await new Promise<string>((resolve, reject) => {
                this.pendingQuestions.set(questionId, { resolve, reject });
                this.send({ type: "question", id: questionId, question: q });
              });
              answers[q.question] = label;

              const chosen = q.options.find((o) => o.label === label);
              this.picks.record({
                header: q.header ?? "",
                question: q.question,
                label,
                description: chosen?.description ?? "",
              });
              this.emitPicks();
            }
            this.send({ type: "status", text: "applying your choices..." });
            return { behavior: "allow", updatedInput: { questions, answers } };
          },
        },
      })) {
        if (msg.type === "system" && msg.subtype === "init") {
          this.send({ type: "status", text: "thinking..." });
        }
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              const html =
                this.phase === "design" ? extractHtmlBlock(block.text) : null;
              if (html) this.send({ type: "design", html });
              this.send({ type: "text", text: block.text });
            }
            if (block.type === "thinking") {
              this.send({ type: "thinking", text: block.thinking });
            }
            if (block.type === "tool_use") {
              this.send({ type: "status", text: `calling ${block.name}...` });
            }
          }
        }
        if (msg.type === "user") {
          this.send({ type: "status", text: "generating..." });
        }
        if (msg.type === "result") {
          this.send({ type: "status", text: "" });
          this.send({ type: "done" });
        }
      }
    } catch (err) {
      if (this.abort.signal.aborted) {
        // Expected: the socket closed and we tore the session down.
        return;
      }
      console.error("query() failed:", err);
      const detail = this.stderrLines.join("").trim();
      this.send({ type: "status", text: "" });
      this.send({
        type: "text",
        text: detail
          ? `Error: ${err}\n\n\`\`\`\n${detail}\n\`\`\``
          : `Error: ${err}`,
      });
      this.send({ type: "done" });
    } finally {
      this.running = false;
    }
  }
}
