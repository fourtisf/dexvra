// ⚡ Run now — the BUTTON, driven through real Telegraf updates.
//
// Two defects live entirely in WHEN and WHERE, and a source scan reads as fine
// on both:
//
//  1 ⚠️ A CALLBACK ANSWER EXPIRES; A MESSAGE EDIT DOES NOT. A scan prices up to
//    `maxLookupsPerRun` candidates serially at an 8s timeout each — minutes,
//    far past Telegram's ~15s deadline. `answerCbQuery` then fails with "query
//    is too old", the .catch swallows it, and the operator is told nothing while
//    the listing may well have gone out. That is `atrun` on the trending panel,
//    reported as "di klik fiturnya not work".
//
//  2 ⚠️ IT MUST QUEUE A JOB, NOT SCAN HERE. The panel runs in @dexvraadminbot;
//    the scan belongs to `dexvra-bot`, which owns the channel transport and is
//    where the scheduled loop already holds the scan lock. Scanning in this
//    process would put a second scanner on the same state file with nothing
//    between them — two snapshots, and the later write loses the earlier one's
//    listings. The test asserts the job, because a direct call would pass every
//    assertion about the verdict.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alrunui-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_ALRUNUI";

const test = require("node:test");
const assert = require("node:assert");

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const fpStore = require("../src/forcepost/store");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 5151, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;
const REAL = { request: fpStore.request, get: fpStore.get };

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 778, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  bot.catch((e) => {
    throw e;
  });
  const calls = [];
  let mid = 200;
  Telegram.prototype.callApi = async function stubbedCallApi(method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = (data) =>
    bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.payload.text || ""));
  const edits = () => calls.filter((c) => c.method === "editMessageText").map((c) => String(c.payload.text || ""));
  const buttons = () =>
    calls
      .filter((c) => c.method === "editMessageText" && c.payload.reply_markup)
      .flatMap((c) => (c.payload.reply_markup.inline_keyboard || []).flat());
  return { bot, calls, tap, answers, edits, buttons };
}

/** A finished job carrying `report`, as the runner would have written it. */
const finished = (report, over = {}) => ({
  id: "fp_test1",
  kind: "free_listing_run",
  status: "done",
  results: [{ channel: "dexvra.io", ok: true, run: { busy: false, listed: report.listed, report } }],
  ...over,
});

const baseReport = (over = {}) => ({
  at: Date.now(),
  forced: true,
  skippedPace: null,
  picked: [],
  candidates: 12,
  priced: 4,
  listed: 0,
  known: 0,
  cooled: 0,
  offChain: 0,
  unsupported: 0,
  reasons: {},
  refused: 0,
  refusals: {},
  unpriced: 0,
  unpricedWhy: {},
  sources: [],
  off: false,
  capped: null,
  paced: null,
  blocker: null,
  ...over,
});

function stubJob(job) {
  fpStore.request = async (kind, opts) => {
    stubJob.requested.push({ kind, opts });
    return job;
  };
  fpStore.get = () => job;
}
stubJob.requested = [];

function restore() {
  fpStore.request = REAL.request;
  fpStore.get = REAL.get;
  Telegram.prototype.callApi = REAL_CALL_API;
  stubJob.requested = [];
}

test("the panel offers ⚡ Run now", async () => {
  const h = harness();
  try {
    await h.tap("al");
    const labels = h.buttons().map((b) => b.text);
    assert.ok(
      labels.some((t) => t.includes("Run now")),
      `no ⚡ Run now on the Auto Listing panel — got ${JSON.stringify(labels)}`,
    );
  } finally {
    restore();
  }
});

test("⚠️ the tap is ANSWERED before the work starts — the answer is what expires", async () => {
  const h = harness();
  let answeredWhileWorking = null;
  fpStore.request = async () => {
    // The moment the slow half begins, what has the operator been told?
    answeredWhileWorking = h.answers();
    return finished(baseReport());
  };
  fpStore.get = () => finished(baseReport());
  try {
    await h.tap("alrun");
    assert.strictEqual(answeredWhileWorking.length, 1, "the callback was still unanswered while the work ran — it expires in ~15s");
    assert.match(answeredWhileWorking[0], /Scanning/i, "the acknowledgement has to say what is running");
    // …and only ONE: Telegram keeps the first per callback and drops the rest,
    // so a second one carrying the result would be silently discarded.
    assert.strictEqual(h.answers().length, 1);
  } finally {
    restore();
  }
});

test("⚠️ it QUEUES a job for the main bot — it does not scan in the admin process", async () => {
  const h = harness();
  stubJob(finished(baseReport()));
  try {
    await h.tap("alrun");
    assert.strictEqual(stubJob.requested.length, 1, "nothing was queued — this handler scanned in the wrong process");
    assert.strictEqual(stubJob.requested[0].kind, "free_listing_run");
    assert.match(String(stubJob.requested[0].opts.by), /owner/, "who asked has to reach the log — it publishes in public");
  } finally {
    restore();
  }
});

test("the RESULT lands on the panel, and names the tokens it listed", async () => {
  const h = harness();
  stubJob(
    finished(
      baseReport({
        listed: 2,
        picked: [
          { sym: "NINEHOOD", chain: "solana", mcap: 1_480_000, trigger: 1_100_000, pkg: "free" },
          { sym: "PONS", chain: "robinhood", mcap: 2_400_000, trigger: 1_300_000, pkg: "xpress" },
        ],
        skippedPace: { waitMs: 150 * 60_000, gapMs: 180 * 60_000 },
      }),
    ),
  );
  try {
    await h.tap("alrun");
    const panel = h.edits().join("\n");
    assert.match(panel, /Listed 2/, "the outcome never reached the panel — a toast that expires is the whole bug");
    assert.match(panel, /NINEHOOD/);
    assert.match(panel, /PONS/);
    assert.match(panel, /robinhood/);
    // ⚠️ The pace was DEFERRED, not spent. Without this a forced listing reads
    // as a free extra and the next operator taps it ten times.
    assert.match(panel, /2h30m/, "the skipped wait has to be named, or ⚡ reads as a bypass");
  } finally {
    restore();
  }
});

test("⚠️ a run that listed nothing says WHICH gate stopped it — never a bare 'nothing happened'", async () => {
  const cases = [
    [baseReport({ blocker: "site API unreachable: ECONNREFUSED" }), /could not run/i, /ECONNREFUSED/],
    [baseReport({ off: true }), /is OFF/i, /Enable/],
    [baseReport({ capped: "7/7" }), /cap is reached/i, /7\/7/],
    [baseReport({ reasons: { "below its trigger": 4 } }), /nothing qualified/i, /below its trigger/],
  ];
  for (const [report, must, also] of cases) {
    const h = harness();
    stubJob(finished(report));
    try {
      await h.tap("alrun");
      const panel = h.edits().join("\n");
      assert.match(panel, must, `verdict missing for ${JSON.stringify(report.blocker || report.capped || (report.off ? "off" : "reasons"))}`);
      assert.match(panel, also);
    } finally {
      restore();
    }
  }
});

test("a tap that raced the scheduled scan says so, rather than looking like a dead button", async () => {
  const h = harness();
  stubJob({
    id: "fp_busy",
    kind: "free_listing_run",
    status: "done",
    results: [{ channel: "dexvra.io", ok: false, run: { busy: true, listed: 0, report: null } }],
  });
  try {
    await h.tap("alrun");
    const panel = h.edits().join("\n");
    assert.match(panel, /already running/i);
    assert.match(panel, /try again/i, "a refusal with no next step is a bug report the code files against its owner");
  } finally {
    restore();
  }
});

test("a job the main bot never picked up points at dexvra-bot, not at the market", async () => {
  const h = harness();
  stubJob({ id: "fp_exp", kind: "free_listing_run", status: "expired" });
  try {
    await h.tap("alrun");
    const panel = h.edits().join("\n");
    assert.match(panel, /expired/i);
    assert.match(panel, /dexvra-bot/, "the process that runs the scan is the whole diagnosis");
  } finally {
    restore();
  }
});
