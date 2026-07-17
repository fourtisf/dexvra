# HANDOFF — {{BRAND}} · Multi-Chain Token Listing & Discovery Platform

> **Untuk:** Michael (build via Claude Code)
> **Dari:** ALFA
> **Prototype (source of truth untuk UI/UX):** `fourtis-discovery.html` — single-file HTML, 14 views, semua interaksi sudah berfungsi dengan mock data. Buka file ini dulu, klik semua halaman, baru mulai coding.
> **Brand name:** masih placeholder `{{BRAND}}`. Simpan sebagai satu konstanta (`BRAND_NAME`) di config — jangan hardcode di komponen. Logo huruf "F" di prototype juga placeholder.

---

## 1. Apa yang dibangun

Platform listing & discovery token multi-chain (kompetitor cointrending.io / moontok.io). Token developer bayar untuk listing (SOL), trader pakai gratis untuk menemukan token baru. Revenue: listing tiers, verification badge, ad slots.

Chains di v1: **Solana, Base, Ethereum, BSC, TON, Robinhood Chain**. Arsitektur harus gampang nambah chain (config-driven, bukan hardcode).

**Bukan** DEX/aggregator — tidak ada swap di platform. Tombol Buy = deeplink ke Jupiter (Solana) / router chain lain.

---

## 2. Stack yang disarankan

- **Next.js 14+ (App Router) + TypeScript + Tailwind** — port CSS dari prototype (design tokens ada di `:root` prototype: warna mint `#3DF59F`, cyan `#22D3EE`, dst).
- **Postgres via Supabase + Prisma** (atau Drizzle, terserah kamu).
- **Redis (Upstash)** untuk cache harga & rate-limit.
- **Cron/queue:** Vercel Cron atau worker terpisah untuk refresh data.
- Kalau kamu punya preferensi stack lain yang lebih cepat buat kamu, silakan — yang wajib dipertahankan adalah **UI/UX prototype dan data model di bawah**.

## 3. Sumber data (pilih & konfirmasi biaya dulu)

| Kebutuhan | Opsi |
|---|---|
| Harga, mcap, vol, liq, txns per pair | **DexScreener API** (gratis, rate-limited) / GeckoTerminal / Birdeye (Solana, paid tier lebih dalam) |
| New pairs feed | DexScreener new pairs endpoint per chain |
| Scanner — Solana | Helius/QuickNode RPC: mint authority, freeze authority; RugCheck API untuk LP lock & holder distribution |
| Scanner — EVM | **GoPlus Security API** (tax, honeypot, LP lock, ownership) |
| Fear & Greed | alternative.me API (gratis) |

Semua data pihak ketiga masuk lewat satu service layer (`/lib/providers/`) supaya provider bisa diganti tanpa menyentuh UI. Cache di Redis: harga 15–30 detik, metadata token 1 jam, hasil scan 10 menit.

---

## 4. Data model (Prisma sketch — sesuaikan)

```prisma
model Token {
  id          String   @id @default(cuid())
  chain       String
  address     String
  symbol      String
  name        String
  logoUrl     String?
  listedAt    DateTime @default(now())
  verified    Boolean  @default(false)
  source      String   // "listing" | "indexed"
  listing     Listing?
  @@unique([chain, address])
}

model Listing {
  id          String   @id @default(cuid())
  tokenId     String   @unique
  tier        String   // TRENCH | EXPRESS | FASTTRACK
  status      String   // PENDING_PAYMENT | IN_REVIEW | LIVE | REJECTED
  payerWallet String
  txSignature String?  // bukti bayar on-chain
  website     String?
  twitter     String?
  telegram    String?
  createdAt   DateTime @default(now())
}

model User {
  id        String   @id @default(cuid())
  wallet    String   @unique   // auth = wallet signature (SIWS), tanpa email
  createdAt DateTime @default(now())
  watchlist Watch[]
  alerts    Alert[]
}

model Watch  { id String @id @default(cuid()); userId String; tokenId String; @@unique([userId, tokenId]) }

model Alert {
  id        String  @id @default(cuid())
  userId    String
  tokenId   String
  direction String  // PUMP | DUMP
  thresholdPct Int
  active    Boolean @default(true)
}

model AdBooking {
  id        String   @id @default(cuid())
  slot      String   // TICKER | CAROUSEL | FULL_NETWORK
  tokenId   String
  startsAt  DateTime
  endsAt    DateTime
  txSignature String
  status    String   // PENDING | ACTIVE | ENDED
  creativeUrl String? // untuk carousel takeover
}
```

## 5. Pembayaran (SOL)

Harga (konfirmasi final ke ALFA sebelum live):
- Listing: **Trench 0.5 SOL · Express 2 SOL · Fast-Track 5 SOL**
- Verification badge: **1.5 SOL** (one-time)
- Ads per 24 jam: **Ticker 1 SOL · Carousel 3 SOL · Full Network 6 SOL**

Mekanisme v1 yang simpel & aman: user transfer SOL ke **treasury wallet** → submit tx signature di form → backend verifikasi via RPC (`getTransaction`: cek recipient, amount, usia tx < 30 menit, signature belum pernah dipakai) → status jadi `IN_REVIEW`. Solana Pay QR boleh ditambah belakangan. **Jangan** simpan private key apa pun di server selain treasury yang terpisah dari hot operations.

## 6. Fase build

### Phase 1 — Read-only discovery (target: bisa dipamerin)
Semua halaman baca dari prototype: **Home** (ticker berjalan, carousel auto-rotate 3 slide, pulse strip: chain heat + Fear&Greed gauge + wire feed, board dengan tab periode 5m/1h/6h/24h + filter chain + sorting kolom), **Trending** (gainers/losers), **New Pairs** (kolom age, sort termuda), **All Coins** (+ filter lokal), **Search** (halaman sendiri + topbar), **Token Detail** (modal: chart/sparkline, stats, copy CA, socials, deeplink Buy), **Playbook** (4 artikel statis — konten nyusul dari ALFA), **Install App** (PWA beneran: manifest + service worker, halaman ini jadi fallback instruksi manual).
Acceptance: data live dari API, refresh otomatis, mobile responsive sesuai breakpoints prototype, Lighthouse mobile ≥ 85.

### Phase 2 — Accounts & engagement
Wallet connect (Phantom/Backpack + WalletConnect untuk EVM) dengan **Sign-In-With-Solana** sebagai auth. Watchlist persist ke DB (prototype-nya in-memory). Alerts: form sesuai prototype, worker cek harga tiap menit, delivery v1 = **Telegram bot** (user link akun via `/start <code>`); ini sekaligus fondasi fase Telegram ke depan.
Acceptance: alert kepicu ≤ 90 detik setelah threshold lewat.

### Phase 3 — Monetization
Flow **List My Token** 3-step persis prototype (form → tier → review/pay → sukses) + verifikasi pembayaran + **admin panel** sederhana (queue review: approve/reject, kelola ad bookings, toggle verified). Get Verified flow. Advertise: booking slot dengan kalender ketersediaan (slot terbatas per hari — carousel maks 1 takeover aktif). Auto-post ke channel Telegram tiap listing LIVE (webhook).
Acceptance: dari bayar sampai LIVE tanpa sentuh database manual.

## 7. Detail perilaku yang sering kelewat (semua sudah ada di prototype — ikuti)

- Tab periode mengubah label kolom (`24h %` → `1h %`) dan datanya, bukan cuma filter.
- Baris token: klik row = buka detail, klik bintang = watchlist (jangan bentrok — cek `stopPropagation` di prototype).
- Ticker atas = ranking top mover, pause saat hover.
- Carousel: auto 5 detik, pause hover, dots + panah; slide 2 & 3 adalah inventory iklan (Carousel Takeover).
- New Pairs pakai kolom Age (relative: `8m`, `2h`, `3d`) dan live dot.
- Scanner menampilkan verdict banner (clean/caution) — jangan pernah tampilkan "100% safe"; selalu ada disclaimer DYOR.
- Empty states: watchlist kosong, my listings kosong — copy-nya sudah ada di prototype.
- `prefers-reduced-motion` dihormati (semua animasi mati).
- Angka: format `$1.2M / $840K`, harga kecil pakai 6–8 desimal (fungsi `fmtPrice` di prototype bisa di-port langsung).

## 8. Non-goals v1

Tanpa swap on-site, tanpa chat/comment, tanpa voting, tanpa multi-bahasa (EN dulu), tanpa mobile app native (PWA cukup).

## 9. Env & keamanan

`DATABASE_URL, REDIS_URL, TREASURY_WALLET, HELIUS_KEY (atau RPC lain), GOPLUS_KEY, TELEGRAM_BOT_TOKEN, ADMIN_WALLETS (comma-separated, buat akses admin panel)`.
Rate-limit semua endpoint publik. Sanitasi semua input listing (URL socials divalidasi, CA divalidasi per format chain). Admin panel dilindungi wallet-signature check terhadap `ADMIN_WALLETS`.

## 10. Urutan kerja yang disarankan untuk Claude Code

1. Scaffold Next.js + port design tokens & layout shell (sidebar 14 nav + topbar + ticker) dari prototype.
2. Provider layer + cron ingest → Home board live.
3. Sisa halaman read-only Phase 1.
4. PWA + deploy staging → **review ALFA** (jangan lanjut sebelum approve).
5. Phase 2 → review → Phase 3.

Kalau ada keputusan produk yang ambigu, default-nya: **ikuti prototype**, dan tanya ALFA lewat catatan di PR, jangan improvisasi diam-diam.
