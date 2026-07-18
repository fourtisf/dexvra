// Shared "arm payment → render the pay card" step used by every flow.
const { armPayment } = require("../payments/payment");
const { sendCard } = require("../helpers/message");
const menu = require("./menu");

async function startPayment(ctx, order) {
  const r = await armPayment(ctx, order);
  const label = order.label || order.kind;

  const text = r.adminFree
    ? `🧪 <b>Admin test order (FREE)</b>\n\n<b>${label}</b>\n\nNo payment required — tap <b>Confirm</b> to activate.`
    : `💳 <b>Payment</b>\n\n<b>${label}</b>\n\n` +
      `Send <b>exactly ${r.humanAmount} ${r.native}</b> to this address:\n\n` +
      `<code>${r.address}</code>\n\n` +
      `⏱ This address is unique to your order. After you send, tap <b>Confirm</b> ` +
      `and I'll verify it on-chain (this can take up to a minute).`;

  await sendCard(ctx, text, menu.confirmPayment());
}

module.exports = { startPayment };
