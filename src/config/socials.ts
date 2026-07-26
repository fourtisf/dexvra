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
export const TELEGRAM_TRENDING_URL = "https://t.me/dexvratrending";
export const X_URL = "https://x.com/dexvra";
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
   *  of the name. */
  blurb: string;
  /** The one to follow first, if you only follow one. */
  primary?: boolean;
}

export const SOCIALS: Social[] = [
  {
    key: "announce",
    kind: "telegram",
    name: "Announcements",
    handle: "@dexvraio",
    url: TELEGRAM_URL,
    blurb: "Product news, new features, and the tokens we highlight. Start here.",
    primary: true,
  },
  {
    key: "x",
    kind: "x",
    name: "X",
    handle: "@dexvra",
    url: X_URL,
    blurb: "The same calls as the channels, for the timeline crowd.",
    primary: true,
  },
  {
    key: "listing",
    kind: "telegram",
    name: "Listing Alerts",
    handle: "@dexvralisting",
    url: TELEGRAM_LISTING_URL,
    blurb: "Every token the moment it lists — contract, chain and market cap.",
  },
  {
    key: "trending",
    kind: "telegram",
    name: "Trending",
    handle: "@dexvratrending",
    url: TELEGRAM_TRENDING_URL,
    blurb: "The live trending board, reposted as it moves.",
  },
  {
    key: "bot",
    kind: "telegram",
    name: "Dexvra Bot",
    handle: "@dexvrabot",
    url: BOT_URL,
    blurb: "List a token, book trending, buy a banner — the whole shop.",
  },
];
