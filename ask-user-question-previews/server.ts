import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Auth: this demo runs on the Claude CLI's own login (an Anthropic Max
// subscription). The SDK spawns the CLI, which authenticates with the OAuth
// credentials `claude login` writes to ~/.claude/.credentials.json — no API
// key needed.
//
// An ANTHROPIC_API_KEY in the environment takes precedence over that login, so
// a stale or placeholder value (e.g. the literal `sk-ant-...` copied out of
// .env.example) makes every request fail with 401 "API key is invalid". Drop it
// so the subscription login always wins. Set ANTHROPIC_AUTH=api-key to opt back
// into key-based billing instead.
if (process.env.ANTHROPIC_AUTH === "api-key") {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_AUTH=api-key but ANTHROPIC_API_KEY is not set.");
  } else {
    console.log("Auth: ANTHROPIC_API_KEY (key-based billing).");
  }
} else {
  if (process.env.ANTHROPIC_API_KEY) {
    delete process.env.ANTHROPIC_API_KEY;
    console.log("Ignoring ANTHROPIC_API_KEY so the CLI login is used.");
  }
  console.log("Auth: Claude CLI login (run `claude login` if this fails).");
}

// Shape of AskUserQuestion's input. Defined locally so the demo stays
// compatible if the SDK's exported type name changes between versions.
type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
};
type AskInput = { questions: Question[] };

const server = createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

// canUseTool blocks until the browser answers. Each pending entry holds a
// promise resolver keyed by request id; the WebSocket message handler looks it up
// and resolves it when the answer arrives. Entries also track the owning
// WebSocket so they can be rejected if that socket closes mid-wait.
const pending = new Map<
  string,
  { ws: WebSocket; resolve: (label: string) => void; reject: (err: Error) => void }
>();

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "prompt") {
      void runQuery(ws, msg.text);
    } else if (msg.type === "answer") {
      pending.get(msg.id)?.resolve(msg.label);
      pending.delete(msg.id);
    }
  });
  // Reject any outstanding waits for this socket on disconnect so the
  // query() loop unwinds instead of hanging indefinitely.
  ws.on("close", () => {
    for (const [id, entry] of pending) {
      if (entry.ws === ws) {
        entry.reject(new Error("client disconnected"));
        pending.delete(id);
      }
    }
  });
});

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function runQuery(ws: WebSocket, prompt: string) {
  send(ws, { type: "status", text: "starting..." });
  // The CLI writes startup failures (bad auth, nested session, missing binary)
  // to stderr and exits 1. Without this the browser only sees "process exited
  // with code 1", so keep the last few lines to attach to the error.
  const stderrLines: string[] = [];
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "sonnet",
        // Extended thinking. Claude's reasoning arrives as `thinking` content
        // blocks on the assistant messages below, which we stream to the
        // browser so you can watch it work instead of staring at a spinner.
        // Sonnet needs an explicit budget; `{ type: "adaptive" }` lets Opus 4.6+
        // decide for itself.
        thinking: { type: "enabled", budgetTokens: 4000 },
        stderr: (data: string) => {
          process.stderr.write(`[cli] ${data}`);
          stderrLines.push(data);
          if (stderrLines.length > 20) stderrLines.shift();
        },
        systemPrompt:
          "You are a branding assistant. When the user asks for help branding a " +
          "site or product, gather their preferences first: ask about color " +
          "palette, typography/style, overall vibe, and anything else that shapes " +
          "the direction. Use AskUserQuestion for each decision point and include " +
          "an HTML preview on each option so they can see what they're choosing. " +
          "Always use the AskUserQuestion tool to ask questions. Never ask " +
          "questions in your text output; the user can only respond through the " +
          "tool's UI. Ask one or two questions at a time; don't overwhelm.\n\n" +
          "Every option must be self-contained. Never offer options like 'I have " +
          "my own idea' or 'I'll tell you later' that require follow-up input. " +
          "The user has a free-text box for that; your options should all be " +
          "concrete choices with previews.\n\n" +
          "When you have gathered enough, output the final " +
          "brand guide directly as markdown: color hex codes, font names, " +
          "spacing/radius values, and a usage summary. You have no write tools " +
          "available, so the markdown IS the deliverable.",
        // NOT plan mode. Plan mode makes Claude more likely to ask, but it
        // wraps up by calling ExitPlanMode, and that call ends the turn --
        // query() returns before the brand guide is ever written, leaving the
        // UI on "The final deliverable will be...". Approving the tool does not
        // help; neither does switching the mode from canUseTool. The system
        // prompt above already forces AskUserQuestion, so the default mode asks
        // just as many questions and actually produces the deliverable.
        permissionMode: "default",
        // Restrict available tools to just AskUserQuestion.
        tools: ["AskUserQuestion"],
        // Opt into HTML previews (the feature this demo showcases).
        toolConfig: { askUserQuestion: { previewFormat: "html" } },
        canUseTool: async (toolName, input) => {
          // ToolSearch and ExitPlanMode are SDK infrastructure: Claude uses
          // them to load AskUserQuestion and to wrap up plan mode. You'll see
          // them fire even though we only listed AskUserQuestion in `tools`.
          // Let them pass through unchanged.
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
          const questions = (input as AskInput).questions;
          const answers: Record<string, string> = {};

          // Ask each question in turn, blocking until the browser picks.
          send(ws, { type: "status", text: "waiting for your pick..." });
          for (const q of questions) {
            const id = randomUUID();
            const label = await new Promise<string>((resolve, reject) => {
              pending.set(id, { ws, resolve, reject });
              send(ws, { type: "question", id, question: q });
            });
            answers[q.question] = label;
          }
          send(ws, { type: "status", text: "applying your choices..." });

          return {
            behavior: "allow",
            updatedInput: { questions, answers },
          };
        },
      },
    })) {
      // query() yields a stream of messages representing the conversation as
      // it unfolds: system init, assistant turns (text + tool_use blocks),
      // user turns (tool results fed back to the model), and a final result.
      // This loop maps each message type to a browser status update so the
      // UI can show what Claude is doing at each stage.
      console.log(`[stream] ${msg.type}${"subtype" in msg ? `/${msg.subtype}` : ""}`);

      if (msg.type === "system" && msg.subtype === "init") {
        send(ws, { type: "status", text: "thinking..." });
      }

      if (msg.type === "assistant") {
        // Each assistant message contains content blocks: text (markdown
        // output) and tool_use (a tool call like AskUserQuestion). Forward
        // text to the browser and update the status for tool calls.
        const blocks = msg.message.content;
        for (const block of blocks) {
          console.log(`  block: ${block.type}${block.type === "tool_use" ? ` (${block.name})` : ""}`);
          if (block.type === "text") {
            send(ws, { type: "text", text: block.text });
          }
          // Extended thinking: Claude's internal reasoning for this turn.
          // Shown in the log so the UI has something to say while a turn is
          // still generating.
          if (block.type === "thinking") {
            send(ws, { type: "thinking", text: block.thinking });
          }
          if (block.type === "tool_use") {
            send(ws, { type: "status", text: `calling ${block.name}...` });
          }
        }
        // If this assistant turn ended on text or thinking (not tool_use),
        // generation is still in progress. Keep the spinner visible until
        // canUseTool fires or the result message arrives.
        const last = blocks[blocks.length - 1];
        if (last?.type === "text" || last?.type === "thinking") {
          send(ws, { type: "status", text: "generating..." });
        }
      }

      // A "user" message here means a tool result was fed back to the model,
      // which is now generating the next turn. Update status so the previous
      // "calling X..." text does not go stale.
      if (msg.type === "user") {
        send(ws, { type: "status", text: "generating..." });
      }

      if (msg.type === "result") {
        send(ws, { type: "status", text: "" });
        send(ws, { type: "done" });
      }
    }
  } catch (err) {
    console.error("query() failed:", err);
    // Attach whatever the CLI said on its way out; the thrown error itself
    // only carries the exit code.
    const detail = stderrLines.join("").trim();
    send(ws, { type: "status", text: "" });
    send(ws, {
      type: "text",
      text: detail ? `Error: ${err}\n\n\`\`\`\n${detail}\n\`\`\`` : `Error: ${err}`,
    });
    send(ws, { type: "done" });
  }
}

server.listen(3001, () => {
  console.log("server on :3001, ws at /ws");
});
