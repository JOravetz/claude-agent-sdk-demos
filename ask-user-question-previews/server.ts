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
