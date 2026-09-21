import { useCallback, useEffect, useRef, useState } from "react";

/**
 * WebSocket plumbing: connects to the server, auto-reconnects on disconnect,
 * and dispatches incoming messages to local state. Not part of the
 * AskUserQuestion/preview feature being demoed; just the transport.
 *
 * `Pick` mirrors the server's type in picks.ts. The client cannot import from
 * the server tree under this Vite root, so the two must stay in sync by hand.
 */

export type Option = { label: string; description: string; preview?: string };
export type Question = { question: string; header: string; options: Option[] };
export type PendingQuestion = { id: string; question: Question };
export type LogEntry = { kind: "text" | "thinking" | "note"; text: string };
export type Pick = {
  id: string;
  header: string;
  question: string;
  label: string;
  description: string;
  supersededBy?: string;
};
export type Phase = "gather" | "design";

const SESSION_KEY = "aqp.sessionId";

export function useAgentSocket(url: string) {
  const ws = useRef<WebSocket | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [history, setHistory] = useState<Pick[]>([]);
  const [phase, setPhase] = useState<Phase>("gather");
  // Every design produced this session, oldest first. A later document used
  // to overwrite the earlier one, silently losing work the user had waited
  // minutes for.
  const [designs, setDesigns] = useState<string[]>([]);
  // Intents pressed while the agent was mid-turn, shown as pending.
  const [queued, setQueued] = useState<string[]>([]);
  // The prompt the server says this session began with, so a reload does
  // not silently revert the textarea to the scenario default.
  const [restoredPrompt, setRestoredPrompt] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let sock: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    let shutdown = false;

    function connect() {
      sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => setConnected(true);
      sock.onclose = () => {
        setConnected(false);
        if (!shutdown) retry = setTimeout(connect, 1000);
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case "session":
            try {
              localStorage.setItem(SESSION_KEY, msg.id);
            } catch {
              // Private mode or blocked storage: the session just won't resume.
            }
            if (msg.prompt) setRestoredPrompt(msg.prompt);
            return;
          case "status":
            return setStatus(msg.text);
          case "question":
            return setPending({ id: msg.id, question: msg.question });
          case "picks":
            setPicks(msg.picks);
            setHistory(msg.history);
            return;
          case "phase":
            return setPhase(msg.phase);
          case "design":
            setDesigns((d) => (d[d.length - 1] === msg.html ? d : [...d, msg.html]));
            setQueued([]);
            return;
          case "text":
            return setLog((l) => [...l, { kind: "text", text: msg.text }]);
          case "thinking":
            return setLog((l) => [...l, { kind: "thinking", text: msg.text }]);
          case "done":
            setLog((l) => [...l, { kind: "note", text: "— done —" }]);
            setBusy(false);
            return;
        }
      };
    }
    connect();
    return () => {
      shutdown = true;
      clearTimeout(retry);
      sock?.close();
    };
  }, [url]);

  const post = useCallback((payload: Record<string, unknown>) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify(payload));
  }, []);

  const submit = useCallback(
    (prompt: string, scenario: string) => {
      let sessionId: string | null = null;
      try {
        sessionId = localStorage.getItem(SESSION_KEY);
      } catch {
        sessionId = null;
      }
      setLog([]);
      setDesigns([]);
      setQueued([]);
      setBusy(true);
      post({ type: "prompt", text: prompt, scenario, sessionId });
    },
    [post],
  );

  const answer = useCallback(
    (label: string) => {
      if (!pending) return;
      post({ type: "answer", id: pending.id, label });
      setPending(null);
      setLog((l) => [...l, { kind: "note", text: `→ chose: ${label}` }]);
    },
    [pending, post],
  );

  const amend = useCallback(
    (pickId: string, label: string, description: string) => {
      post({ type: "amend", pickId, label, description });
      setQueued((q) => [...q, `change to ${label}`]);
      setLog((l) => [...l, { kind: "note", text: `✎ changed to: ${label}` }]);
    },
    [post],
  );

  const say = useCallback(
    (text: string) => {
      post({ type: "say", text });
      setLog((l) => [...l, { kind: "note", text: `→ ${text}` }]);
    },
    [post],
  );

  // Fix: these used to be disabled while the agent was mid-turn, so a click
  // did nothing at all - no queueing, no feedback. The server queues the
  // message either way, so send it and show the user it was accepted.
  const askMore = useCallback(() => {
    post({ type: "ask-more" });
    setQueued((q) => [...q, "more questions"]);
  }, [post]);
  const toDesign = useCallback(() => {
    post({ type: "to-design" });
    setQueued((q) => [...q, "design"]);
  }, [post]);

  return {
    log,
    pending,
    picks,
    history,
    phase,
    designs,
    restoredPrompt,
    queued,
    status,
    busy,
    connected,
    submit,
    answer,
    amend,
    say,
    askMore,
    toDesign,
  };
}
