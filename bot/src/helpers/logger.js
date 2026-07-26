// Minimal leveled console logger with timestamps. Optionally mirrors warn/error
// to a Telegram log channel once a bot instance is attached (attach()).
let botRef = null;
let logChannel = ""; // business feed: /start, purchases — what the operator reads
let errorChannel = ""; // warn/error; same channel unless ERROR_CHANNEL is set

const ts = () => new Date().toISOString().replace("T", " ").replace(/\..+/, "");

function out(level, args) {
  const line = `[${ts()}] ${level} ${args.map(String).join(" ")}`;
  if (level === "ERROR" || level === "WARN") console.error(line);
  else console.log(line);
}

// ── Channel de-duplication ───────────────────────────────────────────────────
// A warn inside a polling loop repeats for as long as the condition holds, and
// the condition is usually permanent: one BSC token with a broken GeckoTerminal
// pool posted "ignoring absurd 24h change 39594.71%" every three minutes,
// forever, burying every real alert in the log channel.
//
// The numbers drift each poll (39594.71 → 39393.73 → 36939.24), so exact-string
// matching would not catch it. The key therefore collapses every number to #,
// which makes "same problem, new reading" one event instead of hundreds.
//
// Nothing is thrown away: the first occurrence goes out immediately, and when
// the window closes a single line reports how many were folded into it. The
// console still gets every line — that is what pm2 logs are for.
const DEDUPE_MS = 15 * 60 * 1000;
const MAX_KEYS = 500; // bounded: a runaway loop must not also leak memory
const recent = new Map(); // key → { last: ms, suppressed: n, sample: string }

const dedupeKey = (text) =>
  String(text)
    .replace(/\d+(?:[.,]\d+)?/g, "#") // 39594.71% and 39393.73% are the same event
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x#") // …but keep addresses distinct from each other
    .slice(0, 300);

function evictOldest() {
  if (recent.size <= MAX_KEYS) return;
  const oldest = [...recent.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, recent.size - MAX_KEYS);
  for (const [k] of oldest) recent.delete(k);
}

/** true when this text should be sent now; false when it is a repeat inside the
 *  window (counted, and summarised on the next send). */
function admit(text, now) {
  const key = dedupeKey(text);
  const hit = recent.get(key);
  if (hit && now - hit.last < DEDUPE_MS) {
    hit.suppressed++;
    return { send: false };
  }
  const folded = hit ? hit.suppressed : 0;
  recent.set(key, { last: now, suppressed: 0 });
  evictOldest();
  return { send: true, folded };
}

function forward(text, channel) {
  const to = channel || logChannel;
  if (!botRef || !to) return;
  const { send, folded } = admit(text, Date.now());
  if (!send) return;
  const body = folded > 0 ? `${text}\n(+${folded} more like this in the last ${DEDUPE_MS / 60000} min)` : text;
  botRef.telegram
    .sendMessage(to, body.slice(0, 3800), { disable_web_page_preview: true })
    .catch(() => {});
}

const log = {
  attach(bot, channel, errors) {
    botRef = bot;
    logChannel = channel || "";
    errorChannel = errors || channel || "";
  },
  info: (...a) => out("INFO", a),
  warn: (...a) => {
    out("WARN", a);
    forward(`⚠️ ${a.map(String).join(" ")}`, errorChannel);
  },
  error: (...a) => {
    out("ERROR", a);
    forward(`🚨 ${a.map(String).join(" ")}`, errorChannel);
  },
  debug: (...a) => {
    if (process.env.DEBUG) out("DEBUG", a);
  },
  event: (text) => {
    out("EVENT", [text]);
    forward(text);
  },
  // Rich HTML report to the log channel (visitor / purchase reports). Console
  // gets a tag-stripped line. NOT de-duplicated: these are business events
  // (a purchase, a new visitor) where two identical-looking lines are two real
  // things that happened, and collapsing them would hide revenue.
  report: (html) => {
    out("REPORT", [String(html).replace(/<[^>]+>/g, "").replace(/\n/g, " | ")]);
    if (botRef && logChannel) {
      botRef.telegram
        .sendMessage(logChannel, String(html).slice(0, 3800), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => {});
    }
  },
  // Test seam: the dedupe state is process-local and would otherwise leak
  // between cases.
  _resetDedupe: () => recent.clear(),
  _dedupeKey: dedupeKey,
};

module.exports = log;
