/**
 * Renders the phase-2 design document.
 *
 * It is a complete HTML document with its own styles, so it goes in a
 * sandboxed iframe rather than being inlined: inline rendering would let its
 * CSS bleed into the app shell, and the sandbox with no allow-scripts means
 * nothing in it can execute.
 *
 * A 620px pane is no way to judge a page design, so it can also be opened full
 * size in a new tab or saved to disk.
 */

/**
 * A blob: tab is NOT sandboxed — anything in the document would execute there,
 * unlike in the pane. Today's documents contain no scripts, but that is an
 * observation about current output, not a guarantee, so strip them on the way
 * out rather than trusting the model to stay well behaved.
 */
function withoutScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}

function makeBlobUrl(html: string): string {
  return URL.createObjectURL(
    new Blob([withoutScripts(html)], { type: "text/html" }),
  );
}

export function DesignPane({
  html,
  label = "Designed view",
}: {
  html: string;
  label?: string;
}) {
  function openFullSize() {
    const url = makeBlobUrl(html);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoking immediately would race the new tab's load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function download() {
    const url = makeBlobUrl(html);
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
