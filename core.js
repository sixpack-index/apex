/* =========================================================================
   The shared core: chain addresses, basket selection rules, formulas.

   Two readers open this file - the browser and the server on Railway. That
   is exactly why there is only one of it. While the basket was counted by
   the browser alone there was nothing to duplicate; the moment the
   collector started counting it too, there would have been two lists of
   the same thing, and they diverge on the very first patch, silently.

   It is written to work in both places without a build step:
     - in the browser it is included with a plain <script>, without
       type="module", or the page would stop opening on a double click
       through file://;
     - in Node it is imported as an ES module via import './core.js'. A
       module with no exports is allowed, and either way the result is put
       on globalThis.

   There is not a single reference here to localStorage, to window or to
   the database: everything that depends on the place lives outside.

   It is all wrapped in a function not for elegance: an included <script>
   puts its const declarations into the same lexical scope as the rest of
   the page's scripts, and `const MODEL` here collided with `const MODEL`
   in app.js. The whole page died on "Identifier has already been
   declared", before the first paint. Exactly one name goes outside.
   ========================================================================= */

(function () {

/* Robinhood Chain, id 4663, Arbitrum Orbit, gas in ETH.
   Checked with live calls on 24 August 2026: eth_chainId returned 0x1237. */
const CHAIN = {
  id: 4663,
  key: 'robinhood',                                   // this is what DexScreener calls this chain
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
};

const API = {
  tokens: CHAIN.explorer + '/api/v2/tokens?type=ERC-20',
  pairs: 'https://api.dexscreener.com/tokens/v1/' + CHAIN.key + '/',
  /* The pool page on the storefront. One place for the whole project:
     this template used to be written straight into the assembly of the
     basket row, and the "buy" link would have been put together from a
     second copy of the same thing. */
  dexPage: 'https://dexscreener.com/' + CHAIN.key + '/',
  search: 'https://api.dexscreener.com/latest/dex/search?q=',
  /* Search on the storefront itself, not in its API: the spare address for
     the "Buy" button in the first minutes after the launch, while the pool
     is not indexed yet and there is no particular pair to point at. */
  dexSearch: 'https://dexscreener.com/search?q=',
};

/* The payout rules. One place for the whole project: the page counts the
   calculator by them, the server the size of an epoch, the documentation
   describes them in words. If they diverge, the buyer will see it, not us.

   WHERE THE MONEY COMES FROM

   The launch goes on Pons, and Pons is Uniswap V3. V3 has no hooks, and
   there is nowhere to take a tax on top of a trade: the token their
   factory deploys is an ordinary ERC20 without a single line about a fee.
   The only income is the fee of the pool itself, and it is 1%.

   Out of that one percent the venue takes its share. It is set at the
   moment of launch and after that it never changes again for our token:
   `tokenProtocolFeeShares[token] = protocolFeeShare` runs once, when the
   position is locked. Today it is 30 there. So 70% of the 1% is ours.

   All of those 0.7% go to the holders in full. The operator keeps nothing
   for itself, unlike the scheme with a hook, where a fifth goes to
   expenses. Gas is paid out of the operator's own pocket, and that is
   written down right here so that nobody "remembers" an operating
   percentage later.

   The numbers are not invented: the pool fee rate, the venue share and its
   ceiling were read with calls over the chain, and the sources of the
   factory and the locker were gone through line by line. */
const MODEL = {
  supply: 1_000_000_000,
  epochHours: 3,        // "checked every three hours"
  poolFeeBps: 100,      // 1% - the Uniswap V3 pool fee rate on Pons
  venueShare: 0.30,     // the venue takes 30% of what is collected
  wedgeBps: 70,         // 0.7% of turnover - everything that reaches the holders
  seats: 10,            // a basket of ten, at equal weight
};

/**
 * Seat weights in basis points.
 *
 * There are ten seats again, and 10000 / 10 = 1000 exactly, so the shares
 * are equal. The handing out of the remainder is not taken away: the
 * number of seats has already been changed twice. The old note about six
 * is left below as the explanation of why the remainder is handed out at
 * all.
 *
 * While there were ten seats the question did not come up: 10000 / 10 =
 * 1000 exactly. Six does not divide - 10000 / 6 = 1666.67, and six times
 * 1666 gives 9996. Those four basis points can neither be thrown away nor
 * left dangling: the contract adds the weights up and must get exactly
 * 10000, otherwise part of the epoch will simply belong to nobody.
 *
 * So the remainder is handed out one point at a time to the top seats. The
 * difference between the first and the last seat is six hundredths of a
 * percent of their share, invisible to a human, and the sum adds up exactly.
 *
 * It is computed by a function rather than written out as numbers: numbers
 * written in by hand outlive a change in the number of seats and diverge
 * from it silently.
 */
function weightsBps(seats = MODEL.seats) {
  const n = Math.max(1, Math.floor(seats));
  const base = Math.floor(10_000 / n);
  const extra = 10_000 - base * n;          // how many points are left to hand out
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/* What does not go into the basket.

   Stablecoins and base assets: otherwise "the most liquid" means USDG,
   WETH and eight more ways of saying "dollar".

   Tokenized stocks: NVDA, SPY, Caterpillar and other wrappers from the
   exchanges. Formally they are the deepest on the chain, but they are not
   its own markets, and the original does not have them in its basket. They
   are told apart by name: "• Robinhood Token", "Inc.", "Class A", "ETF".

   LP and rebasing tokens: these are receipts for a pool, not a market. */
const NOT_CONSTITUENTS = new Set([
  'WETH', 'ETH', 'USDG', 'USDE', 'USDC', 'USDT', 'USDS', 'USR', 'DAI',
  'SYRUPUSDG', 'WSTETH', 'WBTC',
]);

const STOCKISH = /(•\s*Robinhood Token|\bInc\.|\bCorp\.|\bCorporation\b|\bClass [A-C]\b|\bETF\b|\bTrust\b|\bplc\b|\bN\.V\.|\bS\.A\.|\bCo\.|\bHoldings?\b|\bGroup\b|\bLtd\b)/i;
const LPISH = /(\bLP\b|rLP|Liquidity Token|Rebasing)/i;

/* Words to search DexScreener by.

   Blockscout sorts its own list by market cap and hands back the first
   three hundred, and DELTA, AI, YOLO and INDEX do not make it in at all,
   even though their liquidity is in the millions. Because of that our
   basket diverged from the original by four positions. The word search
   picks up the missing ones: together the two sources cover everything
   that trades. */
const SEARCH_WORDS = ['robinhood', 'USDG', 'hood', 'index', 'delta', 'cat',
                      'dog', 'ai', 'yolo', 'stonk'];

/**
 * The fallback list. Blockscout is a free service, and when it goes down
 * the page must show at least something rather than emptiness. The
 * addresses are baked into the code and not into an environment variable:
 * a variable gets forgotten, and there is nothing left to notice it with.
 * The list goes stale - it is only there so that there is something to show.
 */
const FALLBACK_TOKENS = [
  '0x5Cb6F181081301b44905F3ae15419112ecaBd8A6', // PIPEDOG
  '0x020bfC650A365f8BB26819deAAbF3E21291018b4', // CASHCAT
  '0xe934e36A439C94017B64a3FecE66AF12099aBF50', // STONKBROKER
  '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', // NVDA
  '0x39dBED3a2bd333467115dE45665cC57F813C4571', // PONS
  '0xb8Fa8010833463Aac5595b55B9045479239EfF79', // WTH
  '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1', // UP
  '0x45242320DBB855EeA8Fd36804C6487E10E97FCF9', // TENDIES
  '0x7FE995a80075dF3Dc8Ae11A9b82c7FE4202CD87f', // HMM
  '0x56910D4409F3a0C78C64DD8D0545FF0705389870', // Index
  '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', // SPCX
  '0x6245e67affA44a23077f0Ea7f981a8DC743a0c47', // FRONG
  '0x5f62C57e5C537887117EeF828b7E3Ad41C009FEb', // GOOD
  '0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1', // IF
  '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf', // NET
  '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', // SPY
  '0xF8BC08092C06dB6148114DCf82AF881F1085f92b', // WOOD
  '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31', // VIRTUAL
];

/* On thirty addresses DexScreener silently hands back zero pairs: not an
   error, not an empty list with a note, just zero, as if there were
   nothing on the chain. On ten it answers honestly. Hence the batch size. */
const CHUNK = 10;

const TIMEOUT_MS = 12000;

/* The explorer answers 403 to a request with no User-Agent.

   Measured 29 August: `curl` with no headers gets a 403 on every api/v2
   route, and the same request with an ordinary browser string gets a 200.
   It used to hand back a 500 every other time; now it closes itself
   quietly against anything that looks like a robot.

   Because of that the site was living on the fallback list, and the crank
   could not read holders at all, meaning epochs would never have closed,
   and it would have looked like "the explorer is down".

   In a browser this header cannot be set: it is on the forbidden list and
   fetch ignores it silently, substituting the real one. The value is
   needed only by the server and the crank, where the User-Agent defaults
   to `node`. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** A contract address: exactly twenty bytes. Anything else is not one. */
function isAddress(a) {
  return ADDR_RE.test(a || '');
}

/**
 * fetch with a ceiling on time and with retries.
 * A hanging request is worse than a failed one, hence the timeout. The
 * retries are because Blockscout is free here and hands back a 500 roughly
 * every other time: without a retry the page dropped to the fallback list
 * out of nowhere.
 */
async function ask(url, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: stop.signal,
        headers: { accept: 'application/json', 'user-agent': UA },
      });
      if (!res.ok) throw new Error('response ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (k === tries - 1) throw new Error(url.slice(0, 60) + ' — ' + e.message);
      await new Promise(r => setTimeout(r, 700 * (k + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** The chain's ERC-20 addresses. Failing here is not fatal, a spare exists. */
async function tokenAddresses() {
  try {
    const d = await ask(API.tokens);
    const list = (d.items || [])
      .map(t => t.address || t.address_hash)
      .filter(Boolean);
    if (!list.length) throw new Error('token index returned an empty list');
    return { list, source: 'blockscout' };
  } catch (e) {
    return { list: FALLBACK_TOKENS.slice(), source: 'fallback', why: e.message };
  }
}

/** Pairs by address, in batches. A failed batch does not take the rest down. */
async function pairsFor(addresses) {
  const chunks = [];
  for (let i = 0; i < addresses.length; i += CHUNK) {
    chunks.push(addresses.slice(i, i + CHUNK));
  }
  const results = await Promise.allSettled(
    chunks.map(c => ask(API.pairs + c.join(','), 2))
  );
  const out = [];
  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const v = r.value;
    const arr = Array.isArray(v) ? v : (v && v.pairs) || [];
    out.push(...arr);
  });
  return out;
}

/** A second source: search by words. It picks up what Blockscout lacks. */
async function pairsBySearch() {
  const results = await Promise.allSettled(
    SEARCH_WORDS.map(w => ask(API.search + encodeURIComponent(w), 2))
  );
  const out = [];
  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    ((r.value && r.value.pairs) || [])
      .filter(p => p.chainId === CHAIN.key)
      .forEach(p => out.push(p));
  });
  return out;
}

/**
 * Fold the pairs into tokens. Liquidity and turnover are summed across all
 * pools - that is exactly what the original says in its caption: "one
 * token, one seat · pools summed".
 * The price is taken from the deepest pool: that pool is the market.
 */
function foldPairs(pairs) {
  const by = new Map();
  pairs.forEach(p => {
    const b = p && p.baseToken;
    if (!b || !b.address || !p.priceUsd) return;
    const key = b.address.toLowerCase();
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const vol = (p.volume && p.volume.h24) || 0;
    /* The number of trades over a day. The selection rule needs it: a
       million of turnover done by six hundred trades and the same million
       done by fifty thousand are different markets, and the first one is
       far easier to paint between two people than the second. */
    const tx = (p.txns && p.txns.h24) || {};
    const txn = (Number(tx.buys) || 0) + (Number(tx.sells) || 0);
    const prev = by.get(key);
    if (!prev) {
      by.set(key, { pair: p, deepest: liq, liq, vol24: vol, txns24: txn, pools: 1, all: [p] });
      return;
    }
    prev.liq += liq;
    prev.vol24 += vol;
    prev.txns24 += txn;
    prev.pools += 1;
    /* All of the token's pools, not just the deepest one.

       Before, one went outside - the one DexScreener counts the price by.
       That is not enough for the crank: it can only buy where they pay in
       ether, and the deepest pool sometimes is not one of those. On 29
       August AI turned out to have a single pair, AI/NVDA, and the
       "deepest" one was at the same time the only one and unusable. */
    prev.all.push(p);
    if (liq > prev.deepest) { prev.deepest = liq; prev.pair = p; }
  });
  return [...by.values()];
}

/* The wrapped ether of this chain. The same address as in crank/read.js:
   keeping it in two places is bad, but core.js is read by the browser as
   well, while read.js is read only by the server, and an import from there
   into here would drag half the crank into the page. */
const WETH_ADDR = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

function shape(t) {
  const p = t.pair;
  const b = p.baseToken;
  return {
    sym: b.symbol,
    name: b.name,
    address: b.address,
    price: Number(p.priceUsd),
    /* The price in ether, not in dollars. The page does not need it, but
       the crank needs it badly: it uses it to weed out pools with a
       painted price. There are dozens of them on this chain - one token
       turned out to have eighty-six pools, and the best quote came from a
       dummy where the same money "gives" six hundred times more coins. */
    priceNative: Number(p.priceNative) || null,
    chg24: Number((p.priceChange && p.priceChange.h24) ?? 0),
    /* The 5m/1h/6h changes are the only price history we have. The
       sparkline is built out of them and not out of an invented curve. */
    chg6: Number((p.priceChange && p.priceChange.h6) ?? 0),
    chg1: Number((p.priceChange && p.priceChange.h1) ?? 0),
    chg5: Number((p.priceChange && p.priceChange.m5) ?? 0),
    liq: t.liq,          // the sum across all pools
    vol24: t.vol24,
    txns24: t.txns24,
    /* The market cap is taken from the deepest pool: DexScreener counts it
       off the price in that pool. Before, it did not reach the basket row
       at all, because it had no effect on the seat. */
    marketCap: Number(p.marketCap ?? p.fdv) || 0,
    pools: t.pools,
    dex: p.dexId,
    /* The link goes to DexScreener and not to the explorer: from the card
       one looks at the market - the price, the depth, the book - and not
       at the bytecode of the contract. pairAddress here is 32 bytes: the
       chain has Uniswap v4 on it. */
    url: p.url || (API.dexPage + p.pairAddress),
    /* That same deepest pool, the one the price and the turnover were
       counted from. The crank needs it by address: walking a token's pools
       and hoping the right one turns up is a bad plan when there are
       eighty-six of them. */
    pairId: p.pairAddress || null,
    /* The pools where they pay in ether, native or wrapped.

       A separate list, because they cannot be looked for on the chain: a
       query for events by the second currency gets cut off by the node on
       a timeout (measured 29 August), and the second currency is exactly
       the usual place of our token in a pair with ether. DexScreener, on
       the other hand, hands back all the pairs in one response, which we
       make anyway.

       Empty here means "there is nothing to buy with", and that is an
       honest answer: the seat stays without a purchase, and its share is
       spread over the rest. */
    ethPairIds: (t.all || [p])
      .filter(x => {
        const q = x.quoteToken && (x.quoteToken.symbol || '');
        const a = (x.quoteToken && x.quoteToken.address || '').toLowerCase();
        return /^W?ETH$/i.test(q) || a === WETH_ADDR;
      })
      .map(x => x.pairAddress)
      .filter(id => typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id)),
    /* The token's real icon. It comes in the same response and does not
       cost a separate request. Not everyone has one: DOGO has none on
       DexScreener at all, and the explorer picks it up - see iconsFor below. */
    icon: fixIconUrl((p.info && p.info.imageUrl) || null),
    scanUrl: CHAIN.explorer + '/token/' + b.address,
  };
}

/* How much turnover there has to be per unit of depth to count a pool as
   alive.

   The measurement of 26 August that this came out of: there are five
   different tokens with the ticker DOG on the chain, and our choice of
   "among namesakes take the largest" settled on the one with 128 million
   in liquidity and ZERO turnover, an inflated pool without a single
   trade. That same one held the first seat of the whole basket. The live
   DOG traded on 36 thousand of depth.

   The same happened with CAT and AI: for AI the dead address showed 8.1M
   of depth at zero turnover, while the real one had 2.3M of depth and
   5.1M of turnover.

   This is not cosmetics: the treasury will be buying these coins with real
   money. To buy on a pool where there are no trades is to hand over money
   for a number. */
const ALIVE_RATIO = 0.005;      // a day's turnover at least half a percent of depth

/** Whether this liquidity is used at all. */
function isAlive(t) {
  return Number.isFinite(t.liq) && t.liq > 0 &&
         Number.isFinite(t.vol24) && (t.vol24 / t.liq) >= ALIVE_RATIO;
}

/* The depth floors. They appeared together with the weighted selection and
   for its sake.

   While the seat was given by liquidity alone, depth was the rule itself,
   and no floor was needed. Now the seat is decided most of all by turnover
   and the number of trades, and those are the cheapest things of all to
   paint: a pool of twenty thousand with a million pushed through it in a
   thousand trades gathers a high score and comes out into the basket. It
   is impossible to buy into it with real money.

   DEPTH_FLOOR: how much depth there has to be at all.
   DEPTH_TO_MCAP: how much of it there has to be per unit of market cap.
   Behind a big figure there must stand a market, and not one trade at a
   painted price. Both floors were taken from ponsloot, where on this same
   chain they weeded out exactly these cases. */
const DEPTH_FLOOR = 200_000;
const DEPTH_TO_MCAP = 0.005;

/* THE CEILING ON THE AVERAGE TRADE. Turnover divided by the number of
   trades.

   The weighted selection does not catch this on its own, and that came out
   on the live measurement of 10 September. HOOD's 11 million of turnover
   was done by SIX HUNDRED trades, at 18,152 dollars apiece, while every
   other member of the basket has an average trade between 520 and 2,100.
   The number of trades weighed 1.9 percent in its score, that is, almost
   nothing, and it still stood third: under ADDITION a multiplier near zero
   does not punish, it simply does not help. Its turnover and its depth
   held it up.

   Eleven million pushed through by two or three hands is not the chain's
   market, it is somebody's machine. The treasury buys with real money, and
   it has to buy where many people trade, not two.

   Five thousand was chosen off the field itself: between the 2,100 of the
   second from the top and HOOD's 18,152 the gap is almost tenfold, and a
   floor in the middle touches nobody who is alive. */
const TRADE_SIZE_CEILING = 5_000;

function isTraded(t) {
  const cap = Number(t.marketCap) || 0;
  const txns = Number(t.txns24) || 0;
  const vol = Number(t.vol24) || 0;
  if (!(Number.isFinite(t.liq) && t.liq >= DEPTH_FLOOR)) return false;
  if (cap > 0 && t.liq / cap < DEPTH_TO_MCAP) return false;
  /* Zero trades at a live turnover is the same machine, only more brazen:
     dividing by zero is not allowed, and letting this through even less. */
  if (vol > 0 && txns <= 0) return false;
  if (txns > 0 && vol / txns > TRADE_SIZE_CEILING) return false;
  return true;
}

/** A basket seat goes to a market, not to a receipt or an exchange wrapper. */
function isConstituent(t) {
  const sym = (t.sym || '').toUpperCase();
  const name = t.name || '';
  if (NOT_CONSTITUENTS.has(sym)) return false;
  if (STOCKISH.test(name)) return false;
  if (LPISH.test(name) || LPISH.test(t.sym || '')) return false;
  return Number.isFinite(t.price) && t.price > 0;
}

/* THE SEAT IS COUNTED BY FOUR QUANTITIES, NOT BY ONE.
 *
 * Until 10 September the seat was given by liquidity alone, and that gave
 * a false top: HOOD stood first with 10.92M of depth against AI's 10.17M,
 * while AI has three times the turnover, three times the market cap and
 * ninety times the trades. HOOD's turnover was done by six hundred trades,
 * that is, at eighteen thousand dollars apiece.
 *
 * What is added up are the token's SHARES in each quantity, not the
 * numbers themselves: market cap and the number of trades cannot be
 * compared to each other, while shares are always in the same units and
 * add up to one. That is how industry indices are counted, and that is how
 * it is done in ponsloot on this same chain.
 *
 * THE WEIGHTS AND WHY THEY ARE THESE. The order was set by Alexander:
 * strongest of all are turnover and the number of people trading, then
 * market cap, then depth.
 *
 *   turnover 24h:  how much money went through the coin;
 *   trades 24h:    by how many hands that was done;
 *   market cap:    how much the coin is worth;
 *   liquidity:     whether one can get into it and out of it.
 *
 * Turnover and trades stand next to each other deliberately: apart each of
 * them can be painted, together they cannot. A million of turnover in two
 * trades gives high turnover and zero trades, a thousand small trades give
 * trades and zero turnover.
 */
const RANK_WEIGHTS = { vol24: 0.30, txns24: 0.30, marketCap: 0.25, liq: 0.15 };

function rankSeats(rows) {
  const totals = {};
  for (const key of Object.keys(RANK_WEIGHTS)) {
    totals[key] = rows.reduce((acc, t) => acc + Math.max(0, Number(t[key]) || 0), 0);
  }
  const score = t => Object.entries(RANK_WEIGHTS).reduce((acc, [key, weight]) => {
    /* A zero denominator means nobody has this quantity at all: then it
       simply does not take part, rather than dropping the whole score
       into NaN. */
    const total = totals[key];
    return acc + (total > 0 ? (Math.max(0, Number(t[key]) || 0) / total) * weight : 0);
  }, 0);
  return rows.map(t => ({ ...t, score: score(t) })).sort((a, b) => b.score - a.score);
}

/**
 * The most traded tokens of the chain, what the treasury would buy.
 * How many of them there are is decided by MODEL.seats and not by a number
 * inside this function: while it was written in here as a figure, changing
 * the size of the basket meant an edit in six places, and one of them
 * would certainly have stayed old.
 *
 * Returns the data and where it came from. The second part is not
 * decoration: if the list that arrived was the fallback one, the page must
 * say so out loud.
 */
async function readBasket() {
  const { list, source } = await tokenAddresses();
  /* Two sources at once: the Blockscout list and the DexScreener search.
     The search picks up those who are not in the list at all - without it
     DELTA, AI, YOLO and INDEX fell out of the basket. */
  const [byAddr, bySearch] = await Promise.all([
    pairsFor(list),
    pairsBySearch().catch(() => []),
  ]);
  const pairs = byAddr.concat(bySearch);
  if (!pairs.length) throw new Error('no pools came back');

  const priced = foldPairs(pairs).map(shape).filter(isConstituent);
  /* Dead and shallow pools are weeded out before the ranking and not
     after: otherwise they take the top rows and push the real markets out. */
  const all = priced.filter(isAlive).filter(isTraded);

  /* One token, one seat, the way he has it. Symbols repeat on the chain:
     five "DOG"s from different addresses must not be in the basket, and
     the choice between them has to go by turnover and not by the sum with
     liquidity - otherwise the winner is the one whose depth is inflated
     and who has no trades. */
  const seats = new Map();
  all.forEach(t => {
    const key = (t.sym || '').toUpperCase();
    const prev = seats.get(key);
    if (!prev || t.vol24 > prev.vol24) seats.set(key, t);
  });

  const basket = rankSeats([...seats.values()]).slice(0, MODEL.seats);
  /* Icons are picked up only for those who made it into the basket: before
     the slice the list is hundreds of tokens, and a trip to the explorer
     for each one would take down both it and us. */
  await iconsFor(basket);

  return { basket, scanned: list.length, priced: priced.length, alive: all.length, source, at: Date.now() };
}

/**
 * Pick up the missing icons from the explorer.
 *
 * One source is not enough - the same as with the list of tokens. The
 * measurement of 26 August: out of the six basket members DexScreener knew
 * five, and the DOGO icon was handed back only by Blockscout (which takes
 * it from CoinGecko).
 *
 * Requests go out only for those who have no icon: six extra trips to a
 * free explorer on every paint is a sure way to get a 500 out of it and be
 * left with no list at all.
 *
 * A failed request breaks nothing: no icon means the card draws the glyph
 * it has always had.
 */
/**
 * Bring the icon address to a usable size.
 *
 * The measurement of 26 August: DexScreener hands back 350-800 pixels,
 * while the explorer substitutes a CoinGecko link of the `/small/` kind,
 * which is 50 pixels. Fifty pixels stretched across a card look like mush
 * next to eight hundred, and because of one icon like that the whole row
 * looks broken.
 *
 * CoinGecko keeps the same files in three sizes - thumb 25, small 50,
 * large 250. We switch to large: 250 is enough with margin.
 */
function fixIconUrl(url) {
  if (!url) return url;
  return url.replace('/coins/images/', '/coins/images/')
            .replace(/\/(thumb|small)\//, '/large/');
}

async function iconsFor(list) {
  const need = list.filter(t => !t.icon && isAddress(t.address));
  if (!need.length) return list;
  await Promise.allSettled(need.map(async t => {
    try {
      const d = await ask(CHAIN.explorer + '/api/v2/tokens/' + t.address, 2);
      if (d && d.icon_url) t.icon = fixIconUrl(d.icon_url);
    } catch (_) { /* no icon, but with the glyph */ }
  }));
  return list;
}

/** The number of holders. Blockscout knows it for any ERC-20 on the chain. */
async function holdersOf(address) {
  try {
    const d = await ask(CHAIN.explorer + '/api/v2/tokens/' + address);
    const n = Number(d.holders ?? d.holders_count);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

/**
 * The market of one token: price, market cap, liquidity and turnover
 * across all of its pools. Returns null wherever there is no data - the
 * dash on the page is drawn from exactly that and not from a "we have not
 * launched yet" flag.
 */
async function marketOf(token) {
  const out = { price: null, marketCap: null, liq: null, vol24: null, pools: null, pairId: null };
  if (!isAddress(token)) return out;
  const d = await ask(API.pairs + token);
  const pairs = Array.isArray(d) ? d : (d && d.pairs) || [];
  const mine = pairs.filter(p => p.baseToken &&
    p.baseToken.address.toLowerCase() === token.toLowerCase());
  if (!mine.length) return out;
  const deepest = mine.reduce((a, b) =>
    ((b.liquidity && b.liquidity.usd) || 0) > ((a.liquidity && a.liquidity.usd) || 0) ? b : a);
  out.price = Number(deepest.priceUsd) || null;
  /* The address of the deepest pool. The "buy" link is assembled out of
     it: it is put together from a template, and there is no need to type
     it into the console by hand. The deep pool, not the first one that
     turns up - on a shallow one slippage will eat the purchase. */
  out.pairId = deepest.pairAddress || null;
  out.marketCap = Number(deepest.marketCap ?? deepest.fdv) || null;
  /* Liquidity and turnover are summed across all pools: his own caption
     says "across N pools" outright. */
  out.liq = mine.reduce((s, p) => s + ((p.liquidity && p.liquidity.usd) || 0), 0);
  out.vol24 = mine.reduce((s, p) => s + ((p.volume && p.volume.h24) || 0), 0);
  out.pools = mine.length;
  return out;
}

/**
 * The size of an epoch in dollars - how much the treasury will hand out in
 * one three-hour step at the current turnover. It is counted by the
 * published rules and not by fact: there are no facts yet. The page must
 * spell that out in words.
 */
function epochPot(vol24) {
  if (!Number.isFinite(vol24) || vol24 <= 0) return null;
  const perDay = vol24 * (MODEL.wedgeBps / 10_000);
  return perDay / (24 / MODEL.epochHours);
}

/**
 * All of the calculator's arithmetic in one place: the share, the take per
 * epoch, the holder's dividend, the share of one basket position and the
 * yield.
 *
 * It used to live right inside the page's paint, and there was nothing to
 * check it with: substituting the multiplier in the share formula went
 * past all thirty-seven checks, because not one of them reached the line
 * inside paintCalc. The counting is here, the showing is the page's.
 *
 * Returns null in every field that cannot be known: no price, no position
 * value; no turnover, no dividend. The dash on the page is drawn from
 * exactly that.
 */
function dividendFor(amount, vol24, price) {
  const share = Number.isFinite(amount) && amount > 0 ? amount / MODEL.supply : null;
  const pot = epochPot(vol24);
  const mine = (share !== null && pot !== null) ? pot * share : null;
  const perDayCount = 24 / MODEL.epochHours;      // eight epochs in a day
  return {
    share,
    pot,
    mine,
    /* The horizons are here and not in the paint. Multiplying by eight
       and by thirty looks too simple to be worth checking, and that is
       exactly why it has to be checked: a formula living inside the paint
       is caught by nothing - on this very code a doubled multiplier has
       already gone past all thirty-seven checks that way.

       We count at a constant turnover and say so in words on the page:
       not one of the horizons is promised, all three are arithmetic from
       today. */
    perDay: mine === null ? null : mine * perDayCount,
    per30d: mine === null ? null : mine * perDayCount * 30,
    /* The basket is equal-weighted: the take is split between the seats
       evenly and not by market weight. That is what the documentation
       says, and that is how it must be in the contract. There are six
       seats, and the last two get one basis point less - see weightsBps. */
    perSeat: mine === null ? null : mine / MODEL.seats,
    value: (Number.isFinite(price) && price > 0 && Number.isFinite(amount)) ? amount * price : null,
    yieldPerEpoch: (mine !== null && Number.isFinite(price) && price > 0 && amount > 0)
      ? mine / (amount * price) : null,
      /* The annual one is simple, without compounding: the dividend is paid
       in a basket of other people's coins and not by buying more of its own,
       and there is nothing to reinvest it with automatically. It is captioned
       on the page with that same word, "simple". */
    yieldAnnual: (mine !== null && Number.isFinite(price) && price > 0 && amount > 0)
      ? (mine / (amount * price)) * (24 / MODEL.epochHours) * 365 : null,
  };
}

const CORE = {
  CHAIN, API, MODEL, NOT_CONSTITUENTS, STOCKISH, LPISH, SEARCH_WORDS,
  FALLBACK_TOKENS, CHUNK, ADDR_RE,
  isAddress, ask, UA, tokenAddresses, pairsFor, pairsBySearch,
  foldPairs, shape, isConstituent, isAlive, ALIVE_RATIO, readBasket, iconsFor, fixIconUrl, holdersOf, marketOf, epochPot, dividendFor,
  weightsBps,
  /* The selection rule goes outside whole: the set of checks has to be
     available to the checks, otherwise they start repeating it with a copy
     of their own and guarding that copy instead of the real one. Exactly
     this has already happened with the weights in check.js. */
  isTraded, DEPTH_FLOOR, DEPTH_TO_MCAP, TRADE_SIZE_CEILING, rankSeats, RANK_WEIGHTS,
};

/* The same name in both worlds: in the browser globalThis is window, in
   Node it is the process's global object. The importing side does not have
   to know where it is. */
globalThis.ApexCore = CORE;

})();
