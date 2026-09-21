import "dotenv/config";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { Session, type Outbound } from "./session.js";

// Auth: this demo runs on the Claude CLI's own login (an Anthropic Max
// subscription). An ANTHROPIC_API_KEY in the environment takes precedence over
// that login, so a stale or placeholder value makes every request fail with
// 401 "API key is invalid". Drop it so the subscription login always wins.
// Set ANTHROPIC_AUTH=api-key to opt back into key-based billing instead.
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

/**
 * A dev server must not die because one tab closed at an awkward moment.
 *
 * Aborting a query can make the SDK throw from inside its own async handlers
 * (writing a tool response to a transport that just went away). Those land as
 * unhandled rejections with no call site of ours to catch them. Log and carry
 * on; anything else is still fatal, so real bugs stay loud.
 */
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/abort/i.test(message)) {
    console.warn(`[server] ignoring post-abort rejection: ${message}`);
    return;
  }
  throw reason;
});

const server = createServer();
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let session: Session | null = null;

  const send = (payload: Outbound) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  ws.on("message", (raw) => {
    let msg: Record<string, string | undefined>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    void (async () => {
      switch (msg.type) {
        case "prompt": {
          if (!session) {
            session = msg.sessionId
              ? await Session.rehydrate(msg.sessionId, msg.scenario, send)
              : new Session(msg.scenario, send);
          }
          await session.start(msg.text ?? "");
          return;
        }
        case "answer":
          session?.answer(msg.id ?? "", msg.label ?? "");
          return;
        case "amend":
          session?.amend(msg.pickId ?? "", msg.label ?? "", msg.description ?? "");
          return;
        case "say":
          session?.say(msg.text ?? "");
          return;
        case "ask-more":
          session?.askMore();
          return;
        case "to-design":
          session?.toDesign();
          return;
      }
    })();
  });

  ws.on("close", () => {
    session?.close();
    session = null;
  });
});

server.listen(3001, () => {
  console.log("server on :3001, ws at /ws");
});
