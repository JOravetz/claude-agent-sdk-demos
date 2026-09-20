import { useState } from "react";
import type { Pick } from "./useAgentSocket";

type Props = {
  picks: Pick[];
  history: Pick[];
  busy: boolean;
  onAmend: (pickId: string, label: string, description: string) => void;
  onAskMore: () => void;
  onToDesign: () => void;
  onSay: (text: string) => void;
};

/**
 * Persisted picks with an edit affordance. Editing does not rewind the
 * conversation: it sends the agent a correction and lets it adapt forward.
 */
export function PicksPanel({
  picks,
  history,
  busy,
  onAmend,
  onAskMore,
  onToDesign,
  onSay,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");

  return (
    <div style={{ borderTop: "1px solid #eee", paddingTop: 12, marginTop: 12 }}>
      <h3
        style={{
          margin: "0 0 8px",
          fontSize: 13,
          letterSpacing: ".06em",
          color: "#666",
        }}
      >
        YOUR PICKS
      </h3>

      {picks.length === 0 && (
        <p style={{ color: "#999", fontSize: 13 }}>Nothing chosen yet.</p>
      )}

      {picks.map((pick) => (
        <div key={pick.id} style={{ marginBottom: 8, fontSize: 13 }}>
          <div
            style={{ color: "#888", fontSize: 11, textTransform: "uppercase" }}
          >
            {pick.header}
          </div>
          {editing === pick.id ? (
            <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ flex: 1, fontSize: 13, padding: "2px 4px" }}
              />
              <button
                onClick={() => {
                  if (draft.trim()) {
                    onAmend(pick.id, draft.trim(), "changed by user");
                  }
                  setEditing(null);
                }}
              >
                Save
              </button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <strong>{pick.label}</strong>
              <button
                onClick={() => {
                  setEditing(pick.id);
                  setDraft(pick.label);
                }}
                style={{ fontSize: 11, cursor: "pointer" }}
              >
                edit
              </button>
            </div>
          )}
        </div>
      ))}

      {history.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
          <summary style={{ cursor: "pointer" }}>
            {history.length} superseded
          </summary>
          {history.map((pick) => (
            <div
              key={pick.id}
              style={{ textDecoration: "line-through", marginTop: 4 }}
            >
              {pick.header}: {pick.label}
            </div>
          ))}
        </details>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <button onClick={onAskMore} disabled={busy}>
          Ask me more
        </button>
        <button onClick={onToDesign} disabled={busy}>
          Continue to Design →
        </button>
      </div>

      <form
        style={{ display: "flex", gap: 4, marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!note.trim()) return;
          onSay(note.trim());
          setNote("");
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Tell the agent something..."
          style={{ flex: 1, fontSize: 13, padding: "3px 5px" }}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
