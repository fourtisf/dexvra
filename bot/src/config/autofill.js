"use strict";
/**
 * The listing form's autofill clock, and the ONE spelling of the token lookup
 * it makes.
 *
 * Its own module because two things must ask the SAME question: the form
 * (handlers/listing.js) and `npm run launchpads:check`, which prints what the
 * form would prefill. A check that asked with its own options would measure a
 * different stack from the one a buyer's paste runs — `fonts:check`'s nine
 * green ticks over a banner publishing boxes, one feature over.
 *
 * Read at require time, so a test sets LISTING_AUTOFILL_MS before it loads.
 */
const AUTOFILL_MAX_MS = Math.max(1000, Number(process.env.LISTING_AUTOFILL_MS || 8000));
/** What the discovery merge may spend before it answers with what it has —
 *  under the form's own ceiling, or the ceiling fires first and discards it. */
const DISCOVERY_BUDGET_MS = Math.max(Math.round(AUTOFILL_MAX_MS / 2), AUTOFILL_MAX_MS - 750);
/** `chainMeta`: the token's own on-chain metadata is asked too (solanaMeta.js)
 *  — the one socials source a third party cannot refuse. Only this caller opts
 *  in; see discovery.fetchTokenInfoX. */
const INFO_OPTS = Object.freeze({ budgetMs: DISCOVERY_BUDGET_MS, chainMeta: true });

module.exports = { AUTOFILL_MAX_MS, DISCOVERY_BUDGET_MS, INFO_OPTS };
