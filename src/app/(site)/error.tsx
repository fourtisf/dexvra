"use client";

// Page-level error boundary (keeps the app shell; only the page area shows the
// failure). Surfaces the real message so issues are diagnosable in production.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="view">
      <div className="panel big-empty" style={{ alignItems: "stretch", textAlign: "left" }}>
        <div style={{ fontSize: 40, textAlign: "center" }}>⚠️</div>
        <p style={{ textAlign: "center" }}>This page hit an error. Reload to try again.</p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "rgba(255,255,255,.04)",
            border: "1px solid var(--line2)",
            borderRadius: 12,
            padding: 12,
            fontSize: 12,
            color: "var(--orange)",
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {error?.message || "Unknown error"}
          {error?.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
        <button className="btn-primary" style={{ alignSelf: "center" }} onClick={() => reset()}>
          Reload
        </button>
      </div>
    </section>
  );
}
