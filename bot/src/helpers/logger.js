// Minimal leveled console logger with timestamps. Optionally mirrors warn/error
// to a Telegram log channel once a bot instance is attached (attach()).
let botRef = null;
let logChannel = "";

const ts = () => new Date().toISOString().replace("T", " ").replace(/\..+/, "");

function out(level, args) {
  const line = `[${ts()}] ${level} ${args.map(String).join(" ")}`;
  if (level === "ERROR" || level === "WARN") console.error(line);
  else console.log(line);
}

function forward(text) {
  if (!botRef || !logChannel) return;
  botRef.telegram
    .sendMessage(logChannel, text.slice(0, 3800), { disable_web_page_preview: true })
    .catch(() => {});
}

const log = {
  attach(bot, channel) {
    botRef = bot;
    logChannel = channel || "";
  },
  info: (...a) => out("INFO", a),
  warn: (...a) => {
    out("WARN", a);
    forward(`⚠️ ${a.map(String).join(" ")}`);
  },
  error: (...a) => {
    out("ERROR", a);
    forward(`🚨 ${a.map(String).join(" ")}`);
  },
  debug: (...a) => {
    if (process.env.DEBUG) out("DEBUG", a);
  },
  event: (text) => {
    out("EVENT", [text]);
    forward(text);
  },
  // Rich HTML report to the log channel (visitor / purchase reports). Console
  // gets a tag-stripped line.
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
};

module.exports = log;
