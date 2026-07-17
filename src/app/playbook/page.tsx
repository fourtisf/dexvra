"use client";

import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { BRAND_NAME } from "@/config/brand";

// 4 static guides — final copy comes from ALFA; cards + interaction match the
// prototype until then.
const GUIDES = [
  { icon: "⚡", title: `How listing on ${BRAND_NAME} works`, blurb: "Tiers, timing, and what happens after you hit submit.", read: "4 MIN READ" },
  { icon: "📊", title: "Reading the board like a pro", blurb: "What MCAP, liquidity, and buy/sell splits actually tell you.", read: "6 MIN READ" },
  { icon: "🛡️", title: "Rug-proofing 101", blurb: "LP locks, mint authority, and the red flags to check first.", read: "5 MIN READ" },
  { icon: "🚀", title: "Getting the most from a boost", blurb: "When to book a slot and how to time your campaign.", read: "3 MIN READ" },
];

export default function PlaybookPage() {
  const { toast } = useApp();
  return (
    <section className="view">
      <PageHead icon="📖" title="Playbook" sub="Short, practical guides — from listing your token to dodging rugs." />
      <div className="guide-grid">
        {GUIDES.map((g) => (
          <div className="guide" key={g.title} onClick={() => toast("Full guide ships with the build 📖")}>
            <div className="gi">{g.icon}</div>
            <div>
              <h4>{g.title}</h4>
              <p>{g.blurb}</p>
              <div className="rt">{g.read}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
