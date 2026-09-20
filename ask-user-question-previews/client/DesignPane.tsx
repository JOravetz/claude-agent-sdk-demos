/**
 * Renders the phase-2 dashboard. It is a complete HTML document with its own
 * styles, so it goes in a sandboxed iframe rather than being inlined: inline
 * rendering would let its CSS bleed into the app shell, and the sandbox with
 * no allow-scripts means nothing in it can execute.
 */
export function DesignPane({ html }: { html: string }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".06em",
          color: "#888",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Designed view
      </div>
      <iframe
        title="Designed tpm-rank view"
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
