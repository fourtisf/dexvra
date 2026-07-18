// Trending flow. Full implementation lands in Phase D; stub for bootability.
const { answer, sendCard } = require("../helpers/message");
const { mainMenu } = require("./menu");

const soon = async (ctx) => {
  await answer(ctx);
  await sendCard(ctx, "⚙️ Trending flow is being set up — check back shortly.", mainMenu());
};

module.exports = { entryTrending: soon, durationPick: soon };
