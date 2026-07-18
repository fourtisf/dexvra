// Free-text + media routers. Dispatch by ctx.session state to the flow that is
// awaiting input. Full routing lands in Phase D; stub keeps text/photo inert.
async function textRouter(ctx) {
  // Ignore group chatter; only act on private-chat input for an active flow.
  if (!ctx.chat || ctx.chat.type !== "private") return;
  const s = ctx.session || {};
  if (!s.type) return; // no active flow — nothing to capture yet
}

async function mediaRouter(ctx) {
  if (!ctx.chat || ctx.chat.type !== "private") return;
}

module.exports = { textRouter, mediaRouter };
