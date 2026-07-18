// Listing flow (Xpress + Listing & Trending). Full implementation lands in
// Phase D; this stub keeps the bot bootable with the exact exports the registry
// wires.
const { answer, sendCard } = require("../helpers/message");
const { mainMenu } = require("./menu");

const soon = async (ctx) => {
  await answer(ctx);
  await sendCard(ctx, "⚙️ Listing flow is being set up — check back shortly.", mainMenu());
};

module.exports = {
  entryXpress: soon,
  entryListingTrending: soon,
  chainPick: soon,
  tierPick: soon,
  editField: soon,
  approve: soon,
  discard: soon,
};
