// Payment confirm handler + pending-payment orchestration. Full implementation
// (temp-wallet poll + sweep + onSuccess) lands in Phase C. Stub keeps the
// confirm button responsive.
const { answer, toast } = require("../helpers/message");

async function confirmPayHandler(ctx) {
  await answer(ctx);
  if (!ctx.session || !ctx.session.pendingPayment) {
    await toast(ctx, "No pending payment. Send /start to begin.");
    return;
  }
  await toast(ctx, "⏳ Payment verification is being set up — please hold.");
}

module.exports = { confirmPayHandler };
