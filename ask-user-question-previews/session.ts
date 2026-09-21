import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { END, MessageQueue } from "./queue.js";
import { PickStore, type Pick, type PickStoreData } from "./picks.js";
import { writeIfChanged } from "./snapshot.js";
import { getScenario, type Scenario } from "./scenarios/index.js";

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

/**
 * What a session snapshot holds. Picks alone are not enough: the deliverable is
 * the thing the user actually wanted, and losing it on a closed tab makes
 * "resume" a half-promise. No timestamp field -- the file mtime carries that,
 * and a changing timestamp would defeat writeIfChanged.
 */
type Snapshot = {
  version: 1;
  scenario: string;
  phase: Phase;
  picks: PickStoreData;
  /** Substantial assistant text blocks, oldest first: brand guides, invocations. */
  deliverables?: string[];
  /** Pre-migration single block; read, never written. */
  deliverable?: string;
  /** Every phase-2 HTML document, oldest first. */
  designs?: string[];
  /** Pre-migration single document; read, never written. */
  design?: string;
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

/**
 * Drop `preview` from every option before the tool result goes back to the
 * model.
 *
 * The preview HTML exists for the browser. Returning it in updatedInput puts
 * the full markup of every option of every question into the conversation for
 * the rest of the session -- on a 19-question run that is hundreds of
 * kilobytes of HTML the model wrote itself and does not need to re-read. It
 * made later turns crawl, and a design turn on top of it stalled outright.
 */
export function stripPreviews<T extends { options: Array<Record<string, unknown>> }>(
  questions: T[],
): T[] {
  return questions.map((q) => ({
    ...q,
    options: q.options.map(({ preview: _preview, ...rest }) => rest),
  }));
}

/**
 * Is this assistant text an artifact worth storing, or conversational filler?
 *
 * Deliverables are documents - brand guides, invocations, specs - and run to
 * kilobytes with markdown structure. Greetings and acknowledgements do not.
 */
export function isDeliverable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 1500) return false;
  const structure = (trimmed.match(/^#{1,4} |^\| |^- |^\d+\. /gm) || []).length;
  return structure >= 5;
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
  private deliverables: string[] = [];
  private designs: string[] = [];
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
      const parsed = JSON.parse(raw) as Snapshot | PickStoreData;
      if ("version" in parsed) {
        session.picks = PickStore.fromObject(parsed.picks);
        session.phase = parsed.phase;
        // Older snapshots held single values; carry them forward as lists.
        // Filter on the way in as well as the way out. Snapshots written
        // before isDeliverable existed can hold a greeting where a brand guide
        // belongs; carrying that forward would perpetuate the bug's artifact.
        session.deliverables = (
          parsed.deliverables ?? (parsed.deliverable ? [parsed.deliverable] : [])
        ).filter(isDeliverable);
        session.designs =
          parsed.designs ?? (parsed.design ? [parsed.design] : []);
      } else {
        // Snapshot written before deliverables were stored.
        session.picks = PickStore.fromObject(parsed);
      }
    } catch {
      // No snapshot: a fresh session under a known id.
    }
    return session;
  }

  private async snapshot(): Promise<void> {
    // A session with nothing in it is not worth a file. Every page load mints
    // an id, and writing unconditionally left 55 empty snapshots out of 61.
    if (
      this.picks.current().length === 0 &&
      this.deliverables.length === 0 &&
      this.designs.length === 0
    ) {
      return;
    }
    const doc: Snapshot = {
      version: 1,
      scenario: this.scenario.id,
      phase: this.phase,
      picks: this.picks.toObject(),
      ...(this.deliverables.length
        ? { deliverables: this.deliverables }
        : {}),
      ...(this.designs.length ? { designs: this.designs } : {}),
    };
    try {
      await writeIfChanged(
        join(SESSION_DIR, `${this.id}.json`),
        JSON.stringify(doc, null, 2),
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

    // The instruction is the SCENARIO's business. It used to live here, which
    // meant a branding conversation was handed a simulated market tape and
    // asked for "the per-flag rationale".
    const seed = [...this.id].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 7);
    this.say(this.scenario.designPrompt(seed));
    void this.snapshot();
  }

  askMore(): void {
    this.say("Keep going - ask me the next decision.");
  }

  close(): void {
    // Abort FIRST, and do NOT settle the pending question promises.
    //
    // Rejecting them looks tidier but crashes the server: the rejection
    // propagates into canUseTool, the SDK then tries to write a tool response
    // to the transport we just aborted, and its write() throws "Operation
    // aborted" inside its own async frame -- outside any try/catch of ours, so
    // it surfaces as an unhandled rejection and takes the process down. One
    // closed tab killed the server for every other client.
    //
    // Leaving them unsettled means canUseTool simply never returns. That is
    // correct here: the query is aborted, nothing will ever read the answer,
    // and the whole session is discarded.
    if (!this.abort.signal.aborted) this.abort.abort();
    this.pendingQuestions.clear();
    this.queue.close();
    void this.snapshot();
  }

  /** True once close() has torn the session down. Exposed for tests. */
  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  // Read-only views of private state, for tests.
  get picksForTest(): Pick[] {
    return this.picks.current();
  }
  get deliverablesForTest(): string[] {
    return this.deliverables;
  }
  get designsForTest(): string[] {
    return this.designs;
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
    // Show what the previous run produced. The conversation did not survive,
    // but the artifact did, and a resumed session that showed nothing would be
    // indistinguishable from a lost one.
    if (this.phase === "design") this.send({ type: "phase", phase: this.phase });
    for (const text of this.deliverables) this.send({ type: "text", text });
    for (const html of this.designs) this.send({ type: "design", html });

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
          tools: this.scenario.tools,
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
            // Anything the scenario declared is allowed through untouched;
            // only AskUserQuestion needs the browser round trip below.
            if (toolName !== "AskUserQuestion") {
              if (this.scenario.tools.includes(toolName)) {
                this.send({ type: "status", text: `${toolName}...` });
                return { behavior: "allow", updatedInput: input };
              }
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
            return {
              behavior: "allow",
              updatedInput: { questions: stripPreviews(questions), answers },
            };
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
              if (html && this.designs[this.designs.length - 1] !== html) {
                this.designs.push(html);
                this.send({ type: "design", html });
              }
              // Keep substantial text as a deliverable, appended rather than
              // replacing. "Last one over 200 chars wins" let a chatty
              // "Welcome back!" clobber a 9KB brand guide the user had waited
              // for. A real artifact is markdown of some size; greetings are not.
              if (isDeliverable(block.text)) this.deliverables.push(block.text);
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
          void this.snapshot();
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
