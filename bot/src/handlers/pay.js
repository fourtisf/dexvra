// Shared "arm payment → render the pay card" step used by every flow. The pay
// card text is an editable template (pay_card / pay_card_admin).
const { armPayment } = require("../payments/payment");
const { sendCard } = require("../helpers/message");
const menu = require("./menu");
const premium = require("../premium");
const tpl = require("../templates");

async function startPayment(ctx, order) {
  const r = await armPayment(ctx, order);
  // label embeds the user's symbol — sanitize so it can't inject markup
  const label = premium.sanitizeVar(order.label || order.kind);
  if (r.adminFree) {
    await sendCard(ctx, tpl.render("pay_card_admin", { label }), menu.confirmPayment());
    return;
  }
  // The address (and the exact amount) are tap-to-copy: enforced here rather
  // than trusted to the template's backticks, which a re-saved card loses.
  const text = premium.ensureCode(
    tpl.render("pay_card", { label, amount: r.humanAmount, native: r.native, address: r.address }),
    r.address,
    r.humanAmount,
  );
  await sendCard(ctx, text, menu.confirmPayment(r.address));
}

module.exports = { startPayment };
