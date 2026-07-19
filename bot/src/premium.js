// Premium-emoji markup engine (fourtis-compatible syntax):
//   [😀](emoji/5368324170671202286)  → Telegram custom (premium) emoji, 😀 fallback
//   **bold**                          → bold
//   [text](https://url)               → text link
//   `code`                            → inline code
// parse() produces clean text + Bot-API-shaped entities (UTF-16 offsets, the
// unit Telegram uses). toGramJs() converts them for MTProto sends.
//
// Premium emoji render truly animated only when sent via GramJS (a Telegram
// Premium USER account) — a regular bot sending the same entities gets them
// silently stripped by Telegram, leaving the fallback unicode emoji. Both
// paths therefore look correct; GramJS just looks better.

const PH_RE = /\{(\w+)\}/g;

/** Parse premium markup → { text, entities } (Bot API entity objects). */
function parse(input) {
  const text = String(input == null ? "" : input);
  const patterns = [];
  let m;
  let r = /\[([^\]]+)\]\(emoji\/(\d+)\)/g;
  while ((m = r.exec(text)) !== null)
    patterns.push({ type: "custom_emoji", start: m.index, end: m.index + m[0].length, text: m[1], id: m[2] });
  r = /\*\*([^*]+)\*\*/g;
  while ((m = r.exec(text)) !== null)
    patterns.push({ type: "bold", start: m.index, end: m.index + m[0].length, text: m[1] });
  r = /\[([^\]]+)\]\(([^)]+)\)/g;
  while ((m = r.exec(text)) !== null)
    if (!m[2].startsWith("emoji/"))
      patterns.push({ type: "text_link", start: m.index, end: m.index + m[0].length, text: m[1], url: m[2] });
  r = /`([^`\n]+)`/g;
  while ((m = r.exec(text)) !== null)
    patterns.push({ type: "code", start: m.index, end: m.index + m[0].length, text: m[1] });

  patterns.sort((a, b) => a.start - b.start || b.end - a.end);
  const entities = [];
  let clean = "";
  let lastEnd = 0;
  for (const p of patterns) {
    if (p.start < lastEnd) continue; // overlapping match (e.g. link inside bold) — keep the first
    clean += text.substring(lastEnd, p.start);
    const offset = clean.length; // UTF-16 code units — what Telegram expects
    clean += p.text;
    const e = { type: p.type, offset, length: p.text.length };
    if (p.type === "custom_emoji") e.custom_emoji_id = p.id;
    if (p.type === "text_link") e.url = p.url;
    entities.push(e);
    lastEnd = p.end;
  }
  clean += text.substring(lastEnd);
  return { text: clean, entities };
}

/** Convert Bot-API-shaped entities to GramJS Api entities. `Api` is injected so
 *  this module never requires the heavy `telegram` package itself. */
function toGramJs(entities, Api) {
  const out = [];
  for (const e of entities || []) {
    if (e.type === "custom_emoji" && e.custom_emoji_id)
      out.push(new Api.MessageEntityCustomEmoji({ offset: e.offset, length: e.length, documentId: BigInt(e.custom_emoji_id) }));
    else if (e.type === "bold") out.push(new Api.MessageEntityBold({ offset: e.offset, length: e.length }));
    else if (e.type === "italic") out.push(new Api.MessageEntityItalic({ offset: e.offset, length: e.length }));
    else if (e.type === "text_link" && e.url) out.push(new Api.MessageEntityTextUrl({ offset: e.offset, length: e.length, url: e.url }));
    else if (e.type === "url") out.push(new Api.MessageEntityUrl({ offset: e.offset, length: e.length }));
    else if (e.type === "code") out.push(new Api.MessageEntityCode({ offset: e.offset, length: e.length }));
    else if (e.type === "pre") out.push(new Api.MessageEntityPre({ offset: e.offset, length: e.length, language: e.language || "" }));
    else if (e.type === "underline") out.push(new Api.MessageEntityUnderline({ offset: e.offset, length: e.length }));
    else if (e.type === "strikethrough") out.push(new Api.MessageEntityStrike({ offset: e.offset, length: e.length }));
    else if (e.type === "spoiler") out.push(new Api.MessageEntitySpoiler({ offset: e.offset, length: e.length }));
    // unknown types (mention/hashtag/…) are display-only — safe to drop on re-send
  }
  return out;
}

/** Substitute {placeholders} in an ENTITY template (admin-pasted message with
 *  premium emoji), shifting entity offsets so formatting stays glued to the
 *  right characters. All arithmetic is UTF-16 code units. Values are inserted
 *  literally — placeholders inside a substituted value are NOT re-expanded. */
function substituteEntities(text, entities, vars) {
  let out = String(text == null ? "" : text);
  const ents = (entities || []).map((e) => ({ ...e }));
  PH_RE.lastIndex = 0;
  let m;
  while ((m = PH_RE.exec(out)) !== null) {
    const key = m[1];
    const rep = vars && vars[key] != null ? String(vars[key]) : "";
    const start = m.index;
    const phLen = m[0].length;
    const delta = rep.length - phLen;
    out = out.slice(0, start) + rep + out.slice(start + phLen);
    for (const e of ents) {
      const end = e.offset + e.length;
      if (e.offset >= start + phLen) e.offset += delta; // fully after → shift
      else if (end <= start) {
        /* fully before → untouched */
      } else if (e.offset <= start && end >= start + phLen) e.length += delta; // spans it → stretch
      else if (e.offset >= start && end <= start + phLen) e.length = 0; // inside it → drop
      else if (e.offset < start) e.length = start - e.offset; // straddles left edge → truncate
      else {
        const cut = start + phLen - e.offset; // straddles right edge → move past the value
        e.offset = start + rep.length;
        e.length = Math.max(0, e.length - cut);
      }
    }
    PH_RE.lastIndex = start + rep.length; // never re-scan the inserted value
  }
  return { text: out, entities: ents.filter((e) => e.length > 0) };
}

/** True when the string uses premium-emoji markup. */
function hasPremiumMarkup(s) {
  return /\]\(emoji\/\d+\)/.test(String(s || ""));
}

/** fourtis-style forgiveness gate: real HTML tags only — a bare `&` or `<` in
 *  normal copy ("Listing & Trending") must NOT flip a template into HTML mode. */
function looksLikeHtml(s) {
  return /<\/?(b|i|u|s|a|code|pre|blockquote|tg-emoji|tg-spoiler)\b[^>]*>/i.test(String(s || ""));
}

/** Neutralize markup-control characters in USER-supplied values (token names,
 *  symbols, titles) before they're substituted into a markup template — else a
 *  name like "[click](https://scam)" would inject a link into channel posts. */
function sanitizeVar(v) {
  return String(v == null ? "" : v)
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/`/g, "'");
}

module.exports = { parse, toGramJs, substituteEntities, hasPremiumMarkup, looksLikeHtml, sanitizeVar };
