"use client";

import { useState } from "react";
import { Logo } from "@/components/Logo";

export default function AdminLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (r.ok) {
        // Land on the dashboard (the secret base path, minus any /login suffix).
        const base = window.location.pathname.replace(/\/login\/?$/, "") || "/";
        window.location.assign(base);
        return;
      }
      const j = await r.json().catch(() => ({}));
      setErr(j.error || "Login failed");
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-login">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-logo"><Logo size={52} /></div>
          <div>
            <div className="lt">Dexvra</div>
            <div className="ls">Admin Console</div>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <input
            type="text"
            placeholder="Username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="login-err">{err}</div>
          <button className="abtn p login-btn" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
