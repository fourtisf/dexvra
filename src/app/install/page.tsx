"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { BRAND_NAME } from "@/config/brand";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallPage() {
  const { toast } = useApp();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (installed) {
      toast(`${BRAND_NAME} is already installed 🎉`);
      return;
    }
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setInstalled(true);
      setDeferred(null);
    } else {
      // No native prompt available (iOS Safari, or already dismissed):
      // the manual steps below are the fallback per the handoff.
      toast("Use your browser's install / Add to Home Screen option 📲");
    }
  };

  return (
    <section className="view">
      <PageHead icon="📲" title="Install App" sub={`${BRAND_NAME} on your home screen — full-screen, fast, no app store needed.`} />
      <div className="panel" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="check-list">
          <div className="check">📱 <b>&nbsp;iPhone / iPad</b>&nbsp;— Safari → Share → &quot;Add to Home Screen&quot;</div>
          <div className="check">🤖 <b>&nbsp;Android</b>&nbsp;— Chrome → ⋮ menu → &quot;Install app&quot;</div>
          <div className="check">💻 <b>&nbsp;Desktop</b>&nbsp;— Chrome/Edge → install icon in the address bar</div>
        </div>
        <button className="btn-primary" style={{ alignSelf: "flex-start", marginTop: 10 }} onClick={install}>
          📲 {installed ? "Installed ✓" : `Install ${BRAND_NAME}`}
        </button>
        <p className="hint" style={{ marginTop: 6 }}>
          Works offline for your watchlist. Push alerts land here too.
        </p>
      </div>
    </section>
  );
}
