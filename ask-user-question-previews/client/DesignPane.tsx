import {
  DOWNLOAD_MIME,
  sandboxedWrapper,
} from "./designExport";

/**
 * Renders the phase-2 design document.
 *
 * It is a complete HTML document with its own styles, so it goes in a
 * sandboxed iframe rather than being inlined: inline rendering would let its
 * CSS bleed into the app shell, and the sandbox with no allow-scripts means
 * nothing in it can execute.
 *
 * A 620px pane is no way to judge a page design, so it can also be opened full
 * size in a new tab or saved to disk. Both of those paths are careful about
 * script execution — see designExport.ts for why.
 */
export function DesignPane({
  html,
  label = "Designed view",
}: {
  html: string;
  label?: string;
}) {
  function openFullSize() {
    // The new tab gets a wrapper page, not the document itself: a blob URL
    // inherits THIS origin, so an executing script would be same-origin with
    // the app. Inside the wrapper's sandbox="" iframe it cannot execute at all.
    const url = URL.createObjectURL(
      new Blob([sandboxedWrapper(html, label)], { type: "text/html" }),
    );
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoking immediately would race the new tab's load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([html], { type: DOWNLOAD_MIME }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: ".06em",
            color: "#888",
            textTransform: "uppercase",
          }}
        >
          {label} · {Math.round(html.length / 1024)} KB
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={openFullSize} style={{ fontSize: 12, cursor: "pointer" }}>
            Open full size ↗
          </button>
          <button onClick={download} style={{ fontSize: 12, cursor: "pointer" }}>
            Download .html
          </button>
        </div>
      </div>
      <iframe
        title={label}
        srcDoc={html}
        sandbox=""
        style={{
          width: "100%",
          height: 620,
          border: "1px solid #ddd",
          borderRadius: 6,
          background: "#fff",
        }}
      />
    </div>
  );
}
