// Every Dexvra channel, in one list.
//
// The same accounts are quoted by the bot (its CHANNELS config), printed onto
// the channel artwork, and linked from the footer, the sidebar and /community.
// Five places naming one account is how a rename leaves dead links scattered
// around, so the list lives here and everything reads from it.
// The URLs live HERE, not in brand.ts, so this file imports nothing and the
// list is the single definition every other file reads (brand.ts re-exports
// the individual constants for callers that only want one).
export const TELEGRAM_URL = "https://t.me/dexvraio"; // announcements + community
export const TELEGRAM_HANDLE = "@dexvraio";
export const TELEGRAM_LISTING_URL = "https://t.me/dexvralisting";
export const TELEGRAM_LISTING_HANDLE = "@dexvralisting";
export const TELEGRAM_TRENDING_URL = "https://t.me/dexvratrending";
export const TELEGRAM_TRENDING_HANDLE = "@dexvratrending";
export const X_URL = "https://x.com/dexvraio";
export const BOT_URL = "https://t.me/dexvrabot";
export const TELEGRAM_GROUP_URL = "https://t.me/dexvragroup"; // open two-way chat
export const TRADEBOT_URL = "https://t.me/dexvratradebot";

// "group" is deliberately its own kind, not a flavour of telegram: a two-way
// chat and a broadcast channel are different things to join, and a reader who
// confuses them posts a question into a channel that cannot reply.
export type SocialKind = "telegram" | "group" | "x" | "bot";

export interface Social {
  key: string;
  kind: SocialKind;
  name: string;
  handle: string;
  url: string;
  /** What someone gets by following it — the reason to tap, not a restatement
   *  of the name. 8–16 words, plain English, no in-group jargon: this page is
   *  read by project founders deciding where to spend a budget, many of whom
   *  read English as a second language. */
  blurb: string;
  /** The one to follow first, if you only follow one. */
  primary?: boolean;
}

export const SOCIALS: Social[] = [
  {
    key: "listing",
    kind: "telegram",
    name: "New listings",
    handle: "@dexvralisting",
    url: TELEGRAM_LISTING_URL,
    // "pump alert" is glossed rather than used: a founder who is not a Telegram
    // trader has no way to know what it means, and a card has no room to explain.
    blurb: "Every listing as it goes live: contract, chain, price, market cap, and alerts when a token doubles.",
    primary: true,
  },
  {
    key: "bot",
    kind: "bot",
    name: "Listing and placement bot",
    handle: "@dexvrabot",
    url: BOT_URL,
    blurb: "Book listings, trending slots and homepage banners, paid in SOL, BNB, ETH, TRX or TON.",
    primary: true,
  },
  {
    key: "announce",
    kind: "telegram",
    name: "Announcements",
    handle: "@dexvraio",
    url: TELEGRAM_URL,
    blurb: "Product and feature news, plus the extra post that higher-tier listings receive.",
  },
  {
    key: "trending",
    kind: "telegram",
    name: "Trending board",
    handle: "@dexvratrending",
    url: TELEGRAM_TRENDING_URL,
    blurb: "Every token that enters a trending slot, each rank change, and the board reposted regularly.",
  },
  {
    key: "group",
    kind: "group",
    name: "Community group",
    handle: "@dexvragroup",
    url: TELEGRAM_GROUP_URL,
    // Says two-way through BEHAVIOUR ("anyone can post") rather than through a
    // label, which is what makes the difference from a channel land.
    blurb: "Anyone can post here, not only Dexvra: traders and project teams talk directly.",
  },
  {
    key: "tradebot",
    kind: "bot",
    name: "Trading bot",
    handle: "@dexvratradebot",
    url: TRADEBOT_URL,
    // The two bots must never be confused — one sells placement, this one
    // trades — so each line leads with its own verb.
    blurb: "Buy and sell tokens inside Telegram; every listing and trending post has a buy button.",
  },
  {
    key: "x",
    kind: "x",
    name: "X",
    handle: "@dexvraio",
    url: X_URL,
    blurb: "Every listing and announcement also goes to X, for people who do not use Telegram.",
  },
];
