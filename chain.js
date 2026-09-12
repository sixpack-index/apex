/* =========================================================================
   The browser's side of reading the chain.

   The selection rules, the formulas and the addresses live in core.js - it
   is read by both the page and the server. What is left here is only what
   depends on the browser: the conversation with our API, the cache in
   localStorage, and the order in which the token address is taken.

   Two sources, in exactly this order:

     1. **Our server** - /api/state. It reads the chain itself, once a
        minute, and hands out the last successful reading together with its
        age. Other people's free APIs fall over: DexScreener silently
        returns zero pairs on a large request, Blockscout throws a 500 about
        every other time. While only the browser was reading, the visitor
        saw that - the page flashed dashes out of nowhere.

     2. **The chain directly**, if the server did not answer. The service
        can be asleep, deploying, or unreachable from somebody's network;
        the page has to work then too. Plus that way it opens on a double
        click through file://, where no /api exists at all.

   Neither of the two paths is the "real" one with the other as a spare:
   both show the same thing by the same formulas. The difference is who went
   for the data and how long ago.

   Like the core, the file is wrapped in a function: ordinary <script>s share
   one lexical scope across the whole page, and a constant of the same name
   in a neighbouring file brings down not itself but everything.
   ========================================================================= */

(function () {

const C = globalThis.ApexCore;

/* An empty base means the same domain: /api/* is rewritten to Railway
   through vercel.json. No preflights, no second domain in the browser. An
   absolute address is needed only when opening from file://, where there is
   no domain of one's own. */
const API_BASE = (location.protocol === 'file:')
  ? 'https://api-production-2cac.up.railway.app'
  : '';

const CACHE_KEY = 'apex.chain.v2';
const CACHE_MS = 60 * 1000;

/** The conversation with our API. Returns null silently: the caller decides. */
async function fromApi(path, opts) {
  try {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 8000);
    try {
      const res = await fetch(API_BASE + path, {
        signal: stop.signal,
        headers: { accept: 'application/json', ...((opts && opts.headers) || {}) },
        method: (opts && opts.method) || 'GET',
        body: opts && opts.body,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: (d && d.error) || ('http ' + res.status) };
      return d;
    } finally { clearTimeout(timer); }
  } catch (e) {
    return null;                       // the server is silent - that is not the page's error
  }
}

/* =========================================================================
   The chain's top ten
   ========================================================================= */

/**
 * The most liquid traded tokens of the chain - what the treasury would buy.
 * How many of them there are is decided by MODEL.seats in the core.
 * Returns the data and where it came from. The second is not decoration: if
 * the list came from the spare path or is stale, the page has to say so out
 * loud.
 */
async function readChain() {
  const cached = readCache();
  if (cached) return { ...cached, cached: true };

  const s = await fromApi('/api/state');
  if (s && s.ok && s.basket && Array.isArray(s.basket.rows) && s.basket.rows.length) {
    const data = {
      basket: s.basket.rows,
      scanned: s.basket.scanned,
      priced: s.basket.priced,
      source: s.basket.source,
      via: 'api',
      /* The age is taken from the server rather than counted by our own
         clock: the visitor's clock lies more often than it seems, and
         "data from the future" looks like a breakage. */
      age: s.basket.age,
      at: Date.now(),
    };
    writeCache(data);
    return { ...data, cached: false };
  }

  /* The server did not answer - we read it ourselves with the same
     functions it uses. */
  const d = await C.readBasket();
  const data = { ...d, via: 'direct', age: 0 };
  writeCache(data);
  return { ...data, cached: false };
}

/* A cache for a minute: reloading the page must not hit either our server
   or other people's free APIs every single time. Private mode throws an
   exception on a write - we live without a cache, silently. */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.at || Date.now() - d.at > CACHE_MS) return null;
    if (!Array.isArray(d.basket) || !d.basket.length) return null;
    return d;
  } catch (_) { return null; }
}

function writeCache(d) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (_) {}
}

/* =========================================================================
   Our own token and the treasury.

   The dashes on the page are not stubs but empty slots. An address appears,
   and everything is counted off the chain from the same sources as the
   basket: the price, the market cap, the liquidity of its pool, the daily
   turnover, the number of holders, the payout history.

   The address is taken, in rising order of priority:
     1. from the database (the token setting) - shared by everyone, set from
        the console;
     2. from localStorage - a fitting in one's own browser, touching nobody;
     3. from the query string ?token=0x… - a fitting by link, also one's own.

   The first item used to be a line in this file, and writing in the address
   meant making a deploy. On launch day that is the longest and the riskiest
   step: a typo in it costs the launch. Now the address is a row in the
   database.
   ========================================================================= */

/* Left in place for the case where the API is unreachable but the address
   is already known. Normally empty: the real home of the address is the
   database. */
const LAUNCH = {
  token: '',
  vault: '',
  supply: C.MODEL.supply,
};

let SERVER_CONFIG = { token: '', vault: '', theme: '', note: '', buy: '' };

/* The address of the deepest pool of our token. It arrives together with the
   reading of the market and is needed for exactly one thing - putting
   together the "buy" link, see buyLink. */
let SELF_PAIR = '';

/**
 * The buy link. It goes to DexScreener - that is the decision.
 *
 * The order: the link from the settings, then the deepest pool on
 * DexScreener, then a search by the contract address in the same place.
 * Empty happens only while the token address is not set: then there is no
 * button at all, and that is right.
 *
 * WHY NOT TO THE LAUNCHPAD
 *
 * For a short while `pons.family/token/0x…` stood here - their canonical
 * path, the way ponsfolio.com links to its own coin. Taken out by the
 * owner's decision: DexScreener is both more reliable (we already read the
 * market from there, so we know the page exists) and does not tie the main
 * button of the storefront to somebody else's frontend, which can move.
 *
 * The pool taken is the deepest one: the server puts its address into
 * self.pairId on every reading of the market. On a shallow pool slippage
 * would eat the purchase, which is why it is the deep one and not the first
 * that turns up.
 *
 * The search by address is the spare path for the first minutes after the
 * launch, while DexScreener has not indexed the pool. Without it there
 * would have been no button at the most crowded moment.
 *
 * The https check here is not a formality: the value comes from the address
 * bar and goes into an href attribute. Everything that does not start with
 * https has to bounce off - otherwise `?buy=javascript:…` turns into
 * somebody else's script on our storefront.
 */
function buyLink() {
  const ok = s => (/^https:\/\/[^\s"'<>]+$/i.test(String(s || '').trim()) ? String(s).trim() : '');

  let u = String(SERVER_CONFIG.buy || '').trim();
  try { u = ok(localStorage.getItem('apex.buy')) || u; } catch (_) {}
  try { u = ok(new URLSearchParams(location.search).get('buy')) || u; } catch (_) {}
  if (ok(u)) return ok(u);

  /* The deepest pool: the chart and the swap window are both there. */
  if (SELF_PAIR) return C.API.dexPage + SELF_PAIR;

  /* We do not know the pool yet - we lead to a search by the contract
     address. One extra click, but the button is there from the first
     minute. */
  const t = launchAddress('token');
  return t ? C.API.dexSearch + t : '';
}

/** Local overrides of the address - only for a fitting in one's own browser. */
function localOverride(kind) {
  const ok = a => (C.isAddress(a) ? a : '');
  let a = '';
  try { a = ok(localStorage.getItem('apex.' + kind)) || a; } catch (_) {}
  try { a = ok(new URLSearchParams(location.search).get(kind)) || a; } catch (_) {}
  return a;
}

function launchAddress(kind) {
  return localOverride(kind) || SERVER_CONFIG[kind] || LAUNCH[kind] || '';
}

/**
 * Everything about our token in one piece. Returns null where there is no
 * data - the page shows a dash by exactly that sign, and not by a "we have
 * not launched yet" flag.
 *
 * onPartial is called as soon as the market is known: DexScreener answers
 * in fractions of a second, while the holders come from Blockscout, which
 * drags. Waiting for the slowest one means keeping the whole summary empty
 * for extra seconds.
 */
async function readLaunch(onPartial, override) {
  const forced = (override && override.token) || localOverride('token');
  const forcedVault = (override && override.vault) || localOverride('vault');

  /* The address being fitted is read through /api/probe: the server goes
     into the chain and saves nothing. That is how the console checks
     somebody else's token without changing what everyone else sees. */
  if (forced) {
    const p = await fromApi('/api/probe?token=' + encodeURIComponent(forced));
    if (p && p.ok) {
      const out = {
        token: forced, vault: forcedVault,
        price: p.market.price, marketCap: p.market.marketCap,
        liq: p.market.liq, vol24: p.market.vol24, pools: p.market.pools,
        holders: p.holders, epochs: [], via: 'api',
      };
      /* A fitting has to show the buy button too: that is what it is opened
         for. Without this line "Try it on yourself" drew a page with no
         button even though on a live token it would have appeared. */
      SELF_PAIR = p.market.pairId || SELF_PAIR;
      if (typeof onPartial === 'function') onPartial({ ...out });
      if (forcedVault) out.epochs = await epochsOf(forcedVault);
      return out;
    }
    return await readDirect(forced, forcedVault, onPartial);
  }

  /* The ordinary path: what is configured in the database and has already
     been read by the collector. */
  const s = await fromApi('/api/state');
  if (s && s.ok) {
    SERVER_CONFIG = s.config || SERVER_CONFIG;
    const token = s.config.token || '';
    /* The address the payouts go out from is the crank's working wallet.
       There is no separate "vault" field in the console any more: the
       address was one and the same while the fields were two, and the
       ledger stayed empty until both were filled in. The old value from
       the database is respected - if it is lying there, it wins. */
    const vault = s.config.vault || s.config.operator || '';
    const out = {
      token, vault,
      price: null, marketCap: null, liq: null, vol24: null,
      pools: null, holders: null, epochs: [], via: 'api',
    };
    if (s.self) {
      out.price = s.self.price;
      out.marketCap = s.self.marketCap;
      out.liq = s.self.liq;
      out.vol24 = s.self.vol24;
      out.pools = s.self.pools;
      SELF_PAIR = s.self.pairId || SELF_PAIR;
      out.holders = s.self.holders;
      out.age = s.self.age;
    }
    if (typeof onPartial === 'function') onPartial({ ...out });
    if (s.epochs > 0) {
      const e = await fromApi('/api/epochs?limit=20');
      if (e && e.ok) out.epochs = e.rows.map(r => ({ at: r.at, hash: r.hash, symbol: r.symbol, amount: r.amount }));
    }
    return out;
  }

  return await readDirect(LAUNCH.token, LAUNCH.vault, onPartial);
}

/** The same answer, but read off the chain with our own hands. */
async function readDirect(token, vault, onPartial) {
  const out = {
    token, vault,
    price: null, marketCap: null, liq: null, vol24: null,
    pools: null, holders: null, epochs: [], via: 'direct',
  };
  if (!token) { if (typeof onPartial === 'function') onPartial({ ...out }); return out; }

  try {
    Object.assign(out, await C.marketOf(token));
    /* The pool address is remembered here too. Without this line, on a
       direct reading - that is, exactly when the server is down - the
       "Buy" button led not to the pool but to a search: the pool had been
       read but put nowhere. Caught while checking in a browser with the
       server switched off. */
    SELF_PAIR = out.pairId || SELF_PAIR;
  } catch (e) {
    console.warn('the token did not read:', e.message);
  }
  if (typeof onPartial === 'function') onPartial({ ...out });

  out.holders = await C.holdersOf(token);
  if (vault) out.epochs = await epochsOf(vault);
  return out;
}

/**
 * The treasury's payouts straight from the explorer - for the case when the
 * server is silent. While there is no contract, the format of the events is
 * unknown: we read the incoming transfers to the treasury address. When the
 * contract appears, here there will be a reading of its Distributed event,
 * and the page will not know about the swap.
 */
async function epochsOf(vault) {
  try {
    const d = await C.ask(C.CHAIN.explorer + '/api/v2/addresses/' + vault +
                          '/token-transfers?type=ERC-20');
    return (d.items || []).slice(0, 20).map(t => ({
      at: t.timestamp,
      hash: t.transaction_hash || t.tx_hash,
      symbol: t.token && t.token.symbol,
    }));
  } catch (e) {
    console.warn('the treasury history did not read:', e.message);
    return [];
  }
}

/* =========================================================================
   Writing the settings. Only the console uses this, and only with the key
   that it asks a human for and keeps in its own localStorage. The key is
   neither in this file nor in the repository: a file ends up in a commit
   one day.
   ========================================================================= */
async function writeConfig(fields, key) {
  const r = await fromApi('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-apex-key': key || '' },
    body: JSON.stringify(fields),
  });
  if (!r) return { ok: false, error: 'server did not answer' };
  if (r.ok) SERVER_CONFIG = r.config || SERVER_CONFIG;
  return r;
}

/**
 * Ask the server whether the key will do. There is nothing here to check it
 * with - the page does not have the key and must not have it; on that side
 * there is a counter of attempts.
 */
async function checkKey(key) {
  return await fromApi('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-apex-key': key || '' },
    body: '{}',
  });
}

async function serverState() {
  const s = await fromApi('/api/state');
  if (s && s.ok) SERVER_CONFIG = s.config || SERVER_CONFIG;
  return s;
}

/* An ordinary script and not an ES module, deliberately: the browser does
   not load modules over file://, and it must be possible to open the page
   with a double click, with no server. */
window.ApexChain = {
  readChain, readLaunch, launchAddress, buyLink, writeConfig, serverState, checkKey,
  ask: C.ask, LAUNCH, CHAIN: C.CHAIN, API: C.API, MODEL: C.MODEL,
  FALLBACK_TOKENS: C.FALLBACK_TOKENS, NOT_CONSTITUENTS: C.NOT_CONSTITUENTS,
  isAddress: C.isAddress,
  get config() { return SERVER_CONFIG; },
};

})();
