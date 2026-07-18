// Banner Ads flow. Full implementation lands in Phase D; stub for bootability.
const { answer, sendCard } = require("../helpers/message");
const { mainMenu } = require("./menu");

const soon = async (ctx) => {
  await answer(ctx);
  await sendCard(ctx, "⚙️ Banner Ads flow is being set up — check back shortly.", mainMenu());
};

module.exports = {
  entryBanner: soon,
  typePick: soon,
  durationPick: soon,
  payPick: soon,
  yesNo: soon,
};
