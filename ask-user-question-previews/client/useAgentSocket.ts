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
  const [design, setDesign] = useState<string | null>(null);
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
            return setDesign(msg.html);
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
      setDesign(null);
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

  const askMore = useCallback(() => post({ type: "ask-more" }), [post]);
  const toDesign = useCallback(() => post({ type: "to-design" }), [post]);

  return {
    log,
    pending,
    picks,
    history,
    phase,
    design,
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
