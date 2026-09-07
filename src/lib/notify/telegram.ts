// Telegram channel poster. Unconfigured is a supported state: every call
// becomes a no-op rather than an error, so nothing in the app depends on the
// bot being set up.
const API = "https://api.telegram.org";

const token = () => (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const chatId = () => (process.env.TELEGRAM_CHAT_ID ?? "").trim();

export const telegramConfigured = (): boolean => Boolean(token() && chatId());

/** Telegram's HTML mode only needs these three escaped — but token names and
 *  symbols come from arbitrary on-chain metadata, so escape everything. */
export const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Trims untrusted on-chain text to something a channel post can carry. */
export const clip = (value: string | null | undefined, max: number): string => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Posts one message. Never throws — returns whether it actually went out. */
export async function sendTelegram(html: string, timeoutMs = 8000): Promise<boolean> {
  if (!telegramConfigured()) return false;
  try {
    const res = await fetch(`${API}/bot${token()}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId(),
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
