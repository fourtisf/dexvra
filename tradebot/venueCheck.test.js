'use strict';
/*
 * `venue:check` IS DRIVEN HERE, NOT READ.
 *
 * Its whole job is to answer which of three venues a token has, and its first
 * cut got that answer WRONG in the reassuring direction: it asked one wide
 * `eth_getLogs` for the pair's trades, the node this exists for SILENTLY answers
 * `[]` to a range that wide, and the check reported "no logs from the pair" for
 * a pair doing $6,069 of volume a day. `node --check` passed on that, because it
 * is a runtime shape — the same lesson `curveTrade` had to learn about a stage
 * with no timeout, one file over.
 *
 * So the node below is faithful to the one that matters: it SERVES narrow ranges
 * and silently EMPTIES wide ones. A version that goes back to a single wide ask
 * finds nothing here, exactly as it found nothing on the box.
 */
process.env.SKIP_DOTENV = '1';
process.env.RPC = 'http://127.0.0.1:8611';         // before chains.js freezes it
process.env.ENABLED_CHAINS = 'robinhood';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { ethers } = require('ethers');

const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

const TOKEN = '0x4e51c77048ead3d01e2cb1f96dfcad37bf587777';
const PAIR  = '0x8bb731b2e3b04d69c0736b1cc1dc27e6fe12c657';
const QUOTE = '0xe93237c50d904957cf27e7b1133b510c669c2e74';
const ROUTER = '0x1111111111111111111111111111111111111111';
const HEAD = 49329875;
const SERVES = 600;        // the widest range this node will actually answer

const I = new ethers.Interface([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function symbol() view returns (string)',
  'function getPair(address,address) view returns (address)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
]);

const stats = { wide: 0, stepped: 0 };
let server;

function rpc(req, res) {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const r = JSON.parse(b);
    const send = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })); };
    if (r.method === 'eth_chainId') return send('0x1237');
    if (r.method === 'eth_blockNumber') return send('0x' + HEAD.toString(16));
    if (r.method === 'eth_getLogs') {
      const f = r.params[0];
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      if (to - from > SERVES) { stats.wide++; return send([]); }   // ⚠️ SILENT, not an error
      stats.stepped++;
      if (String(f.address).toLowerCase() === PAIR && to >= HEAD - 1200) {
        return send([{
          address: PAIR, topics: ['0x' + 'd7'.repeat(32)], data: '0x',
          blockNumber: '0x' + (HEAD - 100).toString(16), blockHash: '0x' + 'be'.repeat(32),
          transactionHash: '0x' + 'ab'.repeat(32), transactionIndex: '0x0', logIndex: '0x0', removed: false,
        }]);
      }
      return send([]);
    }
    if (r.method === 'eth_getTransactionByHash') {
      return send({
        hash: r.params[0], blockHash: '0x' + 'be'.repeat(32), blockNumber: '0x' + (HEAD - 100).toString(16),
        transactionIndex: '0x0', from: '0x' + 'cc'.repeat(20), to: ROUTER, value: '0x0',
        gas: '0x30d40', gasPrice: '0x3b9aca00', nonce: '0x1', type: '0x0', chainId: '0x1237',
        input: '0x38ed1739' + '00'.repeat(160), v: '0x1b', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32),
      });
    }
    if (r.method === 'eth_call') {
      const { to, data } = r.params[0];
      const t = String(to).toLowerCase(), sel = String(data).slice(0, 10);
      const enc = (fn, v) => send(I.encodeFunctionResult(fn, v));
      if (t === PAIR) {
        if (sel === I.getFunction('token0').selector) return enc('token0', [TOKEN]);
        if (sel === I.getFunction('token1').selector) return enc('token1', [QUOTE]);
        if (sel === I.getFunction('getReserves').selector) return enc('getReserves', [10880488461546503015405152091n, 7807921544329731847n, 0]);
        return send('0x');                                  // no factory(), no fee() — the real fork
      }
      if (t === QUOTE && sel === I.getFunction('symbol').selector) return enc('symbol', ['MSFT']);
      if (t === ROUTER && sel === I.getFunction('getAmountsOut').selector) {
        const [, p] = I.decodeFunctionData('getAmountsOut', data);
        if (p.length === 2) return enc('getAmountsOut', [[10n ** 18n, 1394n * 10n ** 18n]]);
        return send('0x');                                  // no three-hop route
      }
      return send('0x');
    }
    send(null);
  });
}

async function run() {
  const realFetch = global.fetch;
  const realLog = console.log;
  const lines = [];
  global.fetch = async (u, o) => {
    if (String(u).includes('dexscreener')) {
      return { ok: true, status: 200, async json() {
        return { pairs: [{ chainId: 'robinhood', dexId: 'flapsh', pairAddress: PAIR,
          baseToken: { symbol: 'MACROHARD' }, quoteToken: { symbol: 'MSFT' }, liquidity: { usd: 8039.69 } }] };
      } };
    }
    return realFetch(u, o);
  };
  console.log = (...a) => { lines.push(a.join(' ')); };
  process.argv = [process.argv[0], 'venue-check', TOKEN, '--chain', 'robinhood'];
  try {
    delete require.cache[require.resolve('./scripts/venue-check.js')];
    await require('./scripts/venue-check.js').main();
  } finally { console.log = realLog; global.fetch = realFetch; }
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

test.before(async () => { server = http.createServer(rpc); await new Promise((r) => server.listen(8611, r)); });
test.after(() => server && server.close());

test('⚠️ it never makes an over-wide getLogs — the node answers those with silence', async () => {
  stats.wide = 0; stats.stepped = 0;
  await run();
  assert.equal(stats.wide, 0, 'a wide ask is silently emptied by this node — the walk exists to avoid it');
  assert.ok(stats.stepped > 10, `the stepped walk did not run — ${stats.stepped} narrow ask(s)`);
});

test('it reaches the V2 verdict, names the quote token, and says the factory is not ours', async () => {
  const out = await run();
  assert.match(out, /VERDICT: a Uniswap-V2-style pair, quoted in MSFT/);
  assert.match(out, new RegExp(`quote token ${QUOTE}`, 'i'));
  assert.match(out, /this pair is from a different one/);
  assert.match(out, /no fee\(\)\/swapFee\(\)/, 'an unpublished fee is a fact the buy path would need');
});

test('⚠️ it finds the router AND proves it, rather than reporting the `to` as a router', async () => {
  const out = await run();
  assert.match(out, new RegExp(`to ${ROUTER}`, 'i'), 'the candidate came off a real trade');
  // The proof, and the reason a `to` alone is not enough: it can be an
  // aggregator, a multicall, or somebody's own contract.
  assert.match(out, /quotes quote → token — 1\.0 in → 1394\.0 out/);
  assert.match(out, /does not quote WETH → quote → token/, 'a path it cannot quote must not read as one it can');
});

test('the ported DexScreener slug map equals core.js\'s own', () => {
  const m = SRC.match(/const DS_CHAIN_KEY = (\{[^}]*\});/);
  assert.ok(m, 'core.js no longer declares DS_CHAIN_KEY the way this guard reads it');
  // eslint-disable-next-line no-eval
  const real = eval('(' + m[1] + ')');
  const { DS_SLUG } = require('./scripts/venue-check.js');
  assert.deepEqual(DS_SLUG, real, 'venue:check would look up the wrong DexScreener chain');
});
