"use client";

// Root-level error boundary. Replaces the whole document when something throws
// during render/hydration in layout or a provider. Shows the real message so
// failures are diagnosable instead of Next's generic "client-side exception".
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#090C12",
          color: "#F1F5FB",
          fontFamily: "-apple-system,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 640, width: "100%", textAlign: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              margin: "0 auto 18px",
              borderRadius: 16,
              background: "linear-gradient(135deg,#3DF59F,#22D3EE)",
              display: "grid",
              placeItems: "center",
              color: "#03150B",
              fontWeight: 800,
              fontSize: 26,
            }}
          >
            D
          </div>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something broke while loading Dexvra</h1>
          <p style={{ color: "#9AA6BC", fontSize: 14, margin: "0 0 16px" }}>
            The error below helps us fix it. Try reloading first.
          </p>
          <pre
            style={{
              textAlign: "left",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "rgba(255,255,255,.04)",
              border: "1px solid rgba(255,255,255,.12)",
              borderRadius: 12,
              padding: 14,
              fontSize: 12.5,
              color: "#FF9D4D",
              maxHeight: 260,
              overflow: "auto",
            }}
          >
            {error?.message || "Unknown error"}
            {error?.digest ? `\n\ndigest: ${error.digest}` : ""}
            {error?.stack ? `\n\n${error.stack.split("\n").slice(0, 8).join("\n")}` : ""}
          </pre>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              padding: "11px 20px",
              borderRadius: 999,
              border: "none",
              background: "linear-gradient(135deg,#3DF59F,#22D3EE)",
              color: "#03150B",
              fontWeight: 800,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
