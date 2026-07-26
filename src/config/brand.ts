// Every user-visible brand string routes through these constants — never
// hardcode them in components, so a rename is a one-file change.
export const BRAND_NAME = "Dexvra";
export const BRAND_SUB = "Discovery";
export const BRAND_MARK = "D"; // logo monogram letter
export const BRAND_TAGLINE = "Find the next Moonshot";
export const BRAND_DOMAIN = "dexvra.io";

// Public Telegram bot — every "List Token" CTA leads here.
export const BOT_URL = "https://t.me/dexvrabot";

// Social destinations. Handles match the ones the bot posts with (see the bot's
// CHANNELS config and X_HANDLE) and the ones printed on the channel artwork —
// three places quoting the same account, so they live in one constant.
export const TELEGRAM_URL = "https://t.me/dexvraio"; // announcements + community
export const TELEGRAM_HANDLE = "@dexvraio";
export const X_URL = "https://x.com/dexvra";
export const TELEGRAM_LISTING_URL = "https://t.me/dexvralisting";
export const TELEGRAM_TRENDING_URL = "https://t.me/dexvratrending";
