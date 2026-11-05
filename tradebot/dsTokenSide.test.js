'use strict';
// The trade card read the DEEPEST DexScreener pair and called it the token —
// so a token whose deepest pool belongs to a stranger (our token as its QUOTE)
// was named and priced as that stranger. C5xph…pump ($BTC) read as $LTC on the
// listing bot; these are the same readers in the trade bot, where the wrong
// name and price sit over a real buy. See shared/dexscreener/tokenPairs.js.
process.env.SKIP_DOTENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');

const BTC = 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump';
const LTC = 'LTCxj8Rk3sQm1yN9vW2pD7cE4hB6tA5uJ1kZ8xY2pump';
const LTC_BTC = {
  chainId: 'solana', dexId: 'pumpswap', pairAddress: 'LtcBtcPool111111111111111111111111111111111',
  baseToken: { address: LTC, name: 'Little Titty Coin', symbol: 'LTC' },
  quoteToken: { address: BTC, name: 'Big Titty Coin', symbol: 'BTC' },
  priceNative: '0.1964', priceUsd: '0.003212', liquidity: { usd: 1100000 }, volume: { h24: 90000 },
  fdv: 3100000, marketCap: 3100000, priceChange: { h1: 1, h24: 4.2 }, txns: { h24: { buys: 900, sells: 300 } },
  info: { imageUrl: 'https://cdn.example/ltc.png', socials: [{ type: 'twitter', url: 'https://x.com/ltc' }] },
};
const BTC_WBTC = {
  chainId: 'solana', dexId: 'pumpswap', pairAddress: '3M9sVgL4u6atkaiEXf3XhQqnFmb6iJvZK3MemCQaen1w',
  baseToken: { address: BTC, name: 'Big Titty Coin', symbol: 'BTC' },
  quoteToken: { address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', name: 'Wrapped BTC', symbol: 'WBTC' },
  priceNative: '0.0000002035', priceUsd: '0.01635', liquidity: { usd: 486000 }, volume: { h24: 631000 },
  fdv: 16200000, marketCap: 16200000, priceChange: { h1: 4.15, h24: 85.53 }, txns: { h24: { buys: 4666, sells: 8785 } },
  info: { imageUrl: 'https://cdn.example/btc.png', socials: [{ type: 'twitter', url: 'https://x.com/btc' }] },
};
const PAYLOAD = { pairs: [LTC_BTC, BTC_WBTC] };

const realFetch = global.fetch;
function stub() {
  global.fetch = async (u) => {
    if (String(u).includes('api.dexscreener.com/latest/dex/tokens/')) {
      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
}
test.afterEach(() => { global.fetch = realFetch; });

test('the Solana card reader (solana.dexScreener) names and prices $BTC, not the deeper $LTC pool', async () => {
  stub();
  const solana = require('./solana');
  const m = await solana.dexScreener(BTC);
  assert.equal(m.symbol, 'BTC');
  assert.equal(m.name, 'Big Titty Coin');
  assert.equal(m.priceUsd, 0.01635);
  assert.equal(m.mcapUsd, 16200000);
  assert.equal(m.liquidityUsd, 486000);
});

test('the indexed market (core.dsMarket) is the token\'s own pair', async () => {
  stub();
  const core = require('./core');
  const m = await core.dsMarket(BTC, 'solana');
  assert.ok(m, 'a market');
  assert.equal(m.sym, 'BTC');
  assert.equal(m.priceUsd, 0.01635);
  assert.equal(m.mcapUsd, 16200000);
});

test('the card\'s 24h stats (tokeninfo.marketStats) are the token\'s own pair', async () => {
  stub();
  const ti = require('./tokeninfo');
  // tokeninfo's DexScreener chain map covers the EVM chains; drive one with an
  // EVM-shaped copy of the same two pairs.
  const T = '0x1111111111111111111111111111111111111111', S = '0x2222222222222222222222222222222222222222';
  PAYLOAD.pairs = [
    { ...LTC_BTC, chainId: 'base', baseToken: { ...LTC_BTC.baseToken, address: S }, quoteToken: { ...LTC_BTC.quoteToken, address: T } },
    { ...BTC_WBTC, chainId: 'base', baseToken: { ...BTC_WBTC.baseToken, address: T } },
  ];
  try {
    const s = await ti.marketStats(T, 'base');
    assert.equal(s.chgH24, 85.53);
    assert.equal(s.buysH24, 4666);
    assert.equal(s.liqUsd, 486000);
  } finally { PAYLOAD.pairs = [LTC_BTC, BTC_WBTC]; }
});

// ── The GeckoTerminal twin (shared/geckoterminal/poolSide.js) ────────────────
const T = '0x1111111111111111111111111111111111111111', S = '0x2222222222222222222222222222222222222222', W = '0x3333333333333333333333333333333333333333';
const gtRel = (net, base, quote) => ({ base_token: { data: { id: `${net}_${base}` } }, quote_token: { data: { id: `${net}_${quote}` } } });
const GT_LTC_BTC = {
  id: 'robinhood_0xltcbtc', attributes: { address: '0x4444444444444444444444444444444444444444', name: 'LTC / BTC', reserve_in_usd: '1100000', base_token_price_usd: '0.003212', quote_token_price_usd: '0.01635', market_cap_usd: '3100000', price_change_percentage: { h1: '1', h24: '4.2' }, volume_usd: { h24: '90000' }, transactions: { h24: { buys: 900, sells: 300 } } },
  relationships: gtRel('robinhood', S, T),
};
const GT_BTC_WBTC = {
  id: 'robinhood_0xbtcwbtc', attributes: { address: '0x5555555555555555555555555555555555555555', name: 'BTC / WBTC', reserve_in_usd: '486000', base_token_price_usd: '0.01635', quote_token_price_usd: '80000', market_cap_usd: '16200000', price_change_percentage: { h1: '4.15', h24: '85.53' }, volume_usd: { h24: '631000' }, transactions: { h24: { buys: 4666, sells: 8785 } } },
  relationships: gtRel('robinhood', T, W),
};
function stubGt(pools) {
  global.fetch = async (u) => {
    if (String(u).includes('api.geckoterminal.com')) return new Response(JSON.stringify({ data: pools }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
}

test('the GT market (core.gtMarket) is the token\'s own pool, never a stranger\'s with it as quote', async () => {
  stubGt([GT_LTC_BTC, GT_BTC_WBTC]);
  const core = require('./core');
  const m = await core.gtMarket(T, 'robinhood');
  assert.ok(m, 'a market');
  assert.equal(m.sym, 'BTC');
  assert.equal(m.priceUsd, 0.01635);
  assert.equal(m.mcapUsd, 16200000);
  assert.equal(m.liqUsd, 486000);
});

test('the card\'s 24h stats on GT (tokeninfo.marketStats) are the token\'s own pool', async () => {
  stubGt([GT_LTC_BTC, GT_BTC_WBTC]);
  const ti = require('./tokeninfo');
  const s = await ti.marketStats(T, 'robinhood');
  assert.equal(s.chgH24, 85.53, 'never LTC\'s +4.2%');
  assert.equal(s.buysH24, 4666);
  assert.equal(s.liqUsd, 486000);
});
