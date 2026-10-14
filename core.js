/* =========================================================================
   Shared core: chain addresses, the rules for picking the basket, formulas.

   Two things read this file, the browser and the server on Railway. That is
   exactly why there is one. While only the browser computed the basket there
   was nothing to duplicate; once the collector computed it too, there would be
   two lists of the same thing, and they diverge on the first patch, silently.

   It is written to work in both places without a build:
     - in the browser it is included with a plain <script>, no type="module",
       or the page would stop opening on a double click over file://;
     - in Node it is imported as an ES module via import './core.js': a module
       without exports is allowed, and both times the result lands in globalThis.

   There is not a single reference here to localStorage, to window or to the
   database: everything that depends on the place lives outside.

   It is all wrapped in a function not for beauty: an included <script> puts its
   const into the same lexical scope as the rest of the page's scripts, and
   `const MODEL` here collided with `const MODEL` in app.js. The page died
   entirely on "Identifier has already been declared", before the first paint.
   Exactly one name goes out.
   ========================================================================= */

(function () {

/* Solana. Checked with live requests on 14 October 2026: getVersion returned
   solana-core 4.3.0.

   HERE WAS Robinhood Chain, id 4663, Arbitrum Orbit, gas in ETH. Moving to
   Solana is not a matter of replacing three lines: it has no chain id, no
   0x-style addresses, and no explorer that hands out a holder list.
   Everything that depends on that is worked through in ../SOLANA.md.

   THE NODE IS PUBLIC, AND THAT IS NOT ENOUGH EVERYWHERE. Prices and pools
   come from DexScreener, ordinary calls from the public node. The holder list
   the public node does not give: on a large mint it answers INTERNAL_ERROR,
   on a small one it hands back an EMPTY list with code 200. The second is
   more dangerous, because it looks like success. So holders are read by a
   separate source, see holdersOf below. */
const CHAIN = {
  key: 'solana',                                      // the name DexScreener gives this chain
  rpc: 'https://api.mainnet-beta.solana.com',
  explorer: 'https://solscan.io',
  /* The pair's quote asset. On the previous chain this was WETH. */
  quote: 'So11111111111111111111111111111111111111112',
  quoteSym: 'SOL',
};

const API = {
  /* "All tokens of the chain" makes no sense on Solana: there are millions and
     no walking them. The candidate list is built from volume: what trades is
     what is visible. Hence two sources, as before, but both from DexScreener. */
  /* Pool ranking by volume. The only free source that really is a ranking
     and not paid placement. */
  pools: 'https://api.geckoterminal.com/api/v2/networks/' + CHAIN.key + '/pools',
  boosts: 'https://api.dexscreener.com/token-boosts/top/v1',
  pairs: 'https://api.dexscreener.com/tokens/v1/' + CHAIN.key + '/',
  /* The pool's page on the storefront. One place for the whole project: this
     template used to sit right inside the basket row builder, and the "buy"
     link would be assembled from a second copy of the same thing. */
  dexPage: 'https://dexscreener.com/' + CHAIN.key + '/',
  search: 'https://api.dexscreener.com/latest/dex/search?q=',
  /* Search on the storefront itself, not in its API: the fallback address for
     the "Buy" button in the first minutes after launch, while the pool is not
     indexed yet and there is no particular pair to link to. */
  dexSearch: 'https://dexscreener.com/search?q=',
  /* The coin's page on the launchpad. The address follows from the coin's
     address, without asking anyone: checked in the browser on 14 October, the
     path opens for any Solana coin. This is the fallback purchase link for the
     first minutes after launch, while DexScreener has not indexed the pool
     yet. */
  pumpPage: 'https://pump.fun/coin/',
};

/* Payout rules. One place for the whole project: the page runs the
   calculator off them, the server the size of an epoch, the documentation
   describes them in words. If they drift apart, the buyer sees it, not us.

   WHERE THE MONEY COMES FROM, AND WHY THERE IS NO LONGER A SINGLE RATE HERE

   The launch runs on pump.fun, and the income is the creator fee. Its size is
   not ours to set: the venue takes it by its own table, and the table is tied
   to market cap. The bigger the project, the SMALLER the fee.

   Taken off the official pump.fun fee page on 8 October 2026, pair against
   SOL. On the curve the creator fee is 0.300%. After graduating to PumpSwap:

       market cap, SOL         creator fee
       0 to 420                0.300%
       420 to 1470             0.950%
       1470 to 2460            0.900%
       ...                     steps of roughly 0.05%
       49120 to 54030          0.300%
       98240 and above         0.050%

   So on success the rate falls nineteenfold against the top shelf. The old
   0.7% constant does not carry over here, and writing it on the site is not
   allowed: it would be a promise the venue will cancel by itself, without us
   and without warning.

   So what sits here is a TABLE, not a number, and the rate is computed from
   the live market cap. The calculator on the storefront has to show the rate
   that is in force now, and say that it floats.

   Everything that arrives goes to holders in full. The operator keeps nothing
   for himself and pays the cost of settlement out of his own pocket. On
   Solana a new line item joined those, one the previous chain did not have:
   an account per coin for every recipient, see RENT below. */
const CREATOR_FEE = [
  /* up to what market cap in SOL, the creator fee as a fraction of one */
  [420, 0.00300], [1470, 0.00950], [2460, 0.00900], [3440, 0.00850],
  [4420, 0.00800], [9820, 0.00750], [14740, 0.00700], [19650, 0.00650],
  [24560, 0.00600], [29470, 0.00550], [34380, 0.00500], [39300, 0.00450],
  [44210, 0.00400], [49120, 0.00350], [54030, 0.00300], [58940, 0.00275],
  [63860, 0.00250], [68770, 0.00225], [73681, 0.00200], [78590, 0.00175],
  [83500, 0.00150], [88400, 0.00125], [93330, 0.00100], [98240, 0.00075],
  [Infinity, 0.00050],
];

/** The creator fee at this market cap in SOL. */
function creatorFeeAt(mcapSol) {
  const m = Number(mcapSol);
  if (!Number.isFinite(m) || m < 0) return null;
  for (const [upto, rate] of CREATOR_FEE) if (m < upto) return rate;
  return CREATOR_FEE[CREATOR_FEE.length - 1][1];
}

/* THE FEE FOR THE RECIPIENT'S ACCOUNT. To send someone a token, they must
   have an account for that token; no account, and the sender creates it and
   pays for it. Ten coins means up to ten accounts per holder.

   0.00148844 SOL per account, measured September 2026. The rent reduction is
   coming in stages, the next one is expected in November and takes the figure
   roughly sevenfold down. So the number here is good for a rough estimate,
   and before computing a live budget it has to be taken with a live
   getMinimumBalanceForRentExemption call. */
const RENT_PER_ACCOUNT_SOL = 0.00148844;

const MODEL = {
  supply: 1_000_000_000,
  epochHours: 3,        // "checked every three hours"
  seats: 10,            // a basket of ten, equal weight
  /* The rate is no longer a number here: it depends on market cap, see
     creatorFeeAt. The fields poolFeeBps, venueShare and wedgeBps were removed
     on purpose, so they cannot be read out of habit and yield an untruth. */
};

/**
 * Seat weights in basis points.
 *
 * There are ten seats again, and 10000 / 10 = 1000 exactly, so shares are equal.
 * The remainder handout stays: the number of seats has been changed twice.
 * The old note about six is left below as an explanation of why the
 * remainder is handed out at all.
 *
 * While there were ten seats the question did not arise: 10000 / 10 = 1000.
 * Six does not divide: 10000 / 6 = 1666.67, and six times 1666 gives 9996.
 * Those four basis points can neither be thrown away nor left dangling:
 * the contract adds the weights up and has to get exactly 10000, otherwise
 * part of an epoch will simply belong to nobody.
 *
 * So the remainder is handed out one point at a time to the top seats. The
 * difference between the first and the last seat is six hundredths of a
 * percent of their share, invisible to a person, and the sum adds up exactly.
 *
 * Computed by a function rather than written out as numbers: numbers written
 * by hand outlive a change in the number of seats and diverge from it silently.
 */
function weightsBps(seats = MODEL.seats) {
  const n = Math.max(1, Math.floor(seats));
  const base = Math.floor(10_000 / n);
  const extra = 10_000 - base * n;          // how many points are left to hand out
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/* What does not go into the basket.

   Stablecoins and base assets: otherwise "the most liquid" means USDG, WETH
   and eight more ways of saying "dollar".

   Tokenized stocks: NVDA, SPY, Caterpillar and other wrappers from the
   exchanges. Formally they are the deepest things on the chain, but these
   are not its own markets, and the original does not have them in its
   basket. They differ by name: "• Robinhood Token", "Inc.", "Class A", "ETF".

   LP and rebase tokens: these are receipts on a pool, not a market. */
const NOT_CONSTITUENTS = new Set([
  'WETH', 'ETH', 'USDG', 'USDE', 'USDC', 'USDT', 'USDS', 'USR', 'DAI',
  'SYRUPUSDG', 'WSTETH', 'WBTC',
  /* Solana's dollars, measured 14 October: PYUSD stood first among the
     eligible and would have taken a seat in the ten. Behaviour catches it
     anyway, price 1.00013 at almost zero daily movement, but the name is
     safer: a stablecoin has a day when it gets shaken, and that day it slips in. */
  'PYUSD', 'USDY', 'FDUSD', 'USD1', 'UXD', 'PAI', 'USDH', 'USDR',
  /* U, "United Stables". A dollar that is not called USD, and exactly for
     that reason the list of names did not catch it. On 28 September it stood
     as the EIGHTH SEAT IN THE LIVE TEN: price 0.9994, daily movement 0.01%,
     market cap a billion and a half on its own chain. The treasury would have
     bought a dollar with a tenth of an epoch and handed it to holders as "one
     of the most traded coins of the chain". */
  'U',
]);

/* A DOLLAR IS CAUGHT BY BEHAVIOUR, NOT BY A LIST OF NAMES.

   The list above has to exist, but it is always behind: a stablecoin can be
   called anything, and a new one appears on the chain more often than someone
   edits this file. U showed exactly that.

   The behaviour of a dollar, though, is the same for all of them: the price
   stands at one and barely moves over a day. The thresholds are taken from
   the live field of 28 September, and the gap there is wide, not fitted: U is
   0.06% off one and moves 0.01%, while the nearest live participant moves
   3.18%, three times further than the threshold. The other eight move between
   5 and 16 percent.

   TWO CONDITIONS AT ONCE, NOT ONE. A coin can honestly cost about a dollar and
   still be alive: then it gets shaken over the day. And the reverse, a quiet
   day happens to anyone, but not right at one. Together it is a dollar. */
const PEG_BAND = 0.02;      // how far the price may stray from one
const PEG_MOVE = 1.0;       // and by how many percent over a day

function looksPegged(t) {
  const p = Number(t.price);
  const ch = Number(t.chg24);
  if (!Number.isFinite(p) || !Number.isFinite(ch)) return false;
  return Math.abs(p - 1) <= PEG_BAND && Math.abs(ch) < PEG_MOVE;
}

/* FOREIGN MARKETS: THE BASE ASSET AND BRIDGE WRAPPERS.
 *
 * The index collects coins of THIS chain. Bitcoin, ether and the rest arrive
 * here over a bridge, and the market behind them is not here: their price is
 * set by Binance, not by Solana. A holder can get them anywhere anyway, and
 * paying in them means paying nothing new.
 *
 * The same goes for SOL itself. The creator fee arrives in SOL, and buying
 * SOL with it means handing the person back what was taken. That is exactly
 * what pump.fun's Holder Rewards mode does, and exactly how we differ from it.
 *
 * WHY A LIST AND NOT A TEST. An honest test would be this: the share of this
 * chain's volume in the coin's worldwide volume. For bridged bitcoin it is
 * negligible, for a local coin it is one. But a token address is per chain,
 * and there is nowhere to add up one coin's volume across all chains: a search
 * by ticker returns namesakes too. The list is short and changes rarely, so
 * it is more honest than a test that guesses.
 *
 * THIS USED TO WORK BY ACCIDENT. The rule "depth to market cap at least half
 * a percent" was written on a small chain and was harmless there, but on
 * Solana it threw out the large assets by itself: for bridged bitcoin that
 * ratio is 0.0018. The composition came out right for the wrong reason, and
 * the first asset with a deep pool would have broken it. */
const MAJORS = new Set([
  'SOL', 'WSOL', 'BTC', 'WBTC', 'CBBTC', 'TBTC', 'ETH', 'WETH', 'CBETH',
  'WSTETH', 'STETH', 'MSOL', 'JITOSOL', 'BSOL', 'JUPSOL', 'INF',
  'BNB', 'XRP', 'ADA', 'AVAX', 'MATIC', 'DOT', 'LINK', 'LTC', 'BCH',
  'ZEC', 'XMR', 'TRX', 'TON', 'NEAR', 'ATOM', 'APT', 'SUI', 'SEI',
  /* Coins of other chains, which can only have a bridge or a namesake here.
     Neither is a Solana market: a bridge gets its price from the original, a
     namesake has borrowed someone's ticker. Caught on a live measurement,
     DOGE took the tenth seat with two hundred and eighty thousand of depth. */
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'XLM', 'ALGO', 'FIL', 'ICP', 'HBAR',
]);

/* The words that mark a wrapper: "Wrapped BTC", "BTC (Portal)", "Ether
   (Wormhole)", "Sollet", "bridged". Catches what is not in the list above:
   a bridge starts a new coin with a new ticker, but the name gives it away. */
const WRAPPED = /(\bwrapped\b|\(portal\)|\bwormhole\b|\bsollet\b|\bbridged\b|\ballbridge\b|\bliquid stak|\bstaked\b)/i;

/* TOKENIZED STOCKS. The market behind them is Nasdaq, not Solana, and a
   holder can reach them anyway. On the previous chain they were called
   "• Robinhood Token", here "xStock": the measurement on 14 October caught
   NVDAx ("NVIDIA xStock") and GOOGLx ("Alphabet xStock") right inside the
   ten. Their ticker ends in a lowercase x after capitals, we catch that too. */
const STOCKISH = /(•\s*Robinhood Token|\bxStocks?\b|\bInc\.|\bCorp\.|\bCorporation\b|\bClass [A-C]\b|\bETF\b|\bTrust\b|\bplc\b|\bN\.V\.|\bS\.A\.|\bCo\.|\bHoldings?\b|\bGroup\b|\bLtd\b)/i;
const STOCK_TICKER = /^[A-Z]{2,6}x$/;
const LPISH = /(\bLP\b|rLP|Liquidity Token|Rebasing)/i;

/* Words to search DexScreener with.

   Blockscout sorts its list by market cap and hands back the first three
   hundred, and DELTA, AI, YOLO and INDEX do not make it in at all, even
   though they have millions of liquidity. Because of that our basket
   diverged from the original by four positions. The word search picks up the
   missing ones: together the two sources cover everything that trades. */
/* Search words for Solana. The main source of candidates is a different one
   now, see tokenAddresses, and the search stayed as the second: it picks up
   those that did not make the top two hundred pools by volume but do trade. */
const SEARCH_WORDS = ['pump', 'bonk', 'sol', 'cat', 'dog', 'ai', 'meme', 'fun'];

/**
 * The fallback list. Blockscout is a free service, and when it goes down the
 * page must show at least something, not emptiness. Addresses are in the
 * code, not an environment variable: a variable gets forgotten and nothing
 * notices. The list goes stale; it exists only to have something to show.
 */
const FALLBACK_TOKENS = [
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',   // PUMP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  // WIF
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // RAY
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',   // KMNO
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   // JUP
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',   // MEW
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',  // AI16Z
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',  // TRUMP
  'CATSjs9TNyNvbvMDXFLfLsHpcuuShvUZxYSUP9atpump',  // CATS
];

/* DexScreener on thirty addresses silently hands back zero pairs: not an
   error, not an empty list with a note, just zero, as if there were nothing
   on the chain. On ten it answers honestly. Hence the chunk size. */
const CHUNK = 10;

const TIMEOUT_MS = 12000;

/* The explorer answers 403 to a request without a User-Agent.
   
   Measurement on 29 August: `curl` without headers gets 403 on every api/v2
   route, the same request with an ordinary browser string gets 200. It used
   to hand back 500 every other time, now it quietly shuts out anything that
   looks like a robot.
   
   Because of that the site lived on the fallback list, and the crank could
   not read holders at all, which means epochs would never have closed, and
   it would have looked like "the explorer is down".
   
   In the browser this header cannot be set, it is on the forbidden list, and
   fetch silently ignores it: the real one goes in instead. The value is needed
   only by the server and the crank, where User-Agent defaults to `node`. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/* THE REFERER HEADER, WITHOUT WHICH THE EXPLORER HANDS BACK 403.

   On 23 September the explorer moved behind Cloudflare, and requests from the
   server started getting a "Just a moment..." page instead of JSON. Measured
   by walking headers: exactly one decides it, Referer with the explorer's own
   address. Neither User-Agent, nor Accept, nor Accept-Language help, alone or
   together; with Referer everything passes, the holder list included.

       UA only                      403 403 403
       UA + accept-language         403 403 403
       UA + referer                 200 200 200

   What it threatened: the storefront lived on a fallback list of eighteen
   addresses (on the page that shows up as the "partial list" caption), and
   the crank could not read holders at all and would not have closed A SINGLE
   epoch, because an incomplete snapshot stops an epoch. It would have looked
   like "the explorer is down", though it was down only for us.

   In the browser the Referer is substituted by the browser and cannot be set,
   it is on the forbidden list. So the header is put only on explorer
   addresses: at DexScreener it decides nothing, and a surplus header is a
   surplus reason to refuse. */
function refererFor(url) {
  const h = { accept: 'application/json', 'user-agent': UA };
  if (String(url).startsWith(CHAIN.explorer)) h.referer = CHAIN.explorer + '/';
  return h;
}

/* AN ADDRESS ON SOLANA IS BASE58, NOT 0x AND FORTY CHARACTERS.

   It was `/^0x[0-9a-fA-F]{40}$/`. Now it is thirty two bytes written in
   base58, that is 32 to 44 characters from an alphabet without zero, capital
   O, capital I and lowercase l: those were dropped precisely to avoid mixups.

   We do not check the length with a single number: 32 bytes give 43 or 44
   characters almost always, but an address with leading zeros has fewer, and
   such addresses are real. The lower bound of 32 is taken with slack.

   THIS BREAKS MORE THAN THIS ONE LINE. The console check, the guard against
   typing in a private key and the rules on the server all depend on it. A
   Solana private key is not 64 hexadecimal characters but 64 bytes, and in
   writing it looks either like base58 about 88 characters long or like an
   array of numbers in square brackets. The old check would have caught
   neither, see server/rules.js. */
/* =========================================================================
   WHERE THE CANDIDATE FIELD COMES FROM

   IT WAS: a page by page walk of GeckoTerminal's pool ranking. Ten pages,
   two sort orders, a five second pause between requests, that is about two
   minutes for one collection. And a 429 refusal at around the third page.

   HOW THAT ENDED ON THE LIVE SERVER. I checked the live API response on 14
   October: `source: fallback`, eight rows instead of ten, data five hours
   old. That is, "the ten most traded coins of the chain" on the storefront
   were not the ten but whatever could be scraped before the refusal. The
   project's main promise rested on a fallback list.

   IT IS NOW: the most traded list from the aggregator Jupiter, in one request.
   Measured 14 October: a hundred coins in 890 ms, asks for no key, no refusals.

   And the same response holds what used to need a separate trip:

     24h volume and trade count         was computed from DexScreener pairs
     liquidity, market cap, price       from there too
     the coin's DECIMALS                the crank asked the node, one request
                                        per seat
     the coin's PROGRAM                 also the node, also per request
     icon                               a separate trip to the explorer
     mint and freeze authority          WAS NOWHERE, see below

   Three lists, not one. The most traded is the base, but the aggregator also
   has a ranking by "organic" volume and a ranking of coins gaining volume.
   They pick up a coin that has only just started trading and has not reached
   the daily top yet. Three requests instead of ten with pauses. */
const JUP_TOKENS = 'https://lite-api.jup.ag/tokens/v2/';
const JUP_LISTS = ['toptraded/24h', 'toporganicscore/24h', 'toptrending/24h'];
/* A hundred is the ceiling: limit=200 and limit=500 give the same hundred. Measured. */
const JUP_LIMIT = 100;
/* The volume ranking does not change in a minute, and the collector refreshes
   the basket once a minute. Without a cache we would hammer someone else's
   free service for nothing. Two minutes, not ten as with GeckoTerminal: the
   request is cheap now, and keeping the ten ten minutes stale is pointless. */
const JUP_TTL_MS = 2 * 60_000;

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** An address on Solana: thirty two bytes in base58. The rest is not an address. */
function isAddress(a) {
  return ADDR_RE.test(a || '');
}

/**
 * fetch with a ceiling on time and with retries.
 * A hanging request is worse than a failed one, hence the timeout. Retries
 * because Blockscout here is free and hands back 500 about every other time:
 * without a retry the page fell to the fallback list for nothing.
 */
async function ask(url, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: stop.signal,
        headers: refererFor(url),
      });
      /* 429 means "too often", and a retry a second later only makes it
         worse: their counter is a sliding one. We throw at once and mark it,
         so the caller can tell busy apart from broken. */
      if (res.status === 429) {
        const e = new Error('response 429');
        e.tooMany = true;
        throw e;
      }
      if (!res.ok) throw new Error('response ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (e.tooMany) throw e;
      if (k === tries - 1) throw new Error(url.slice(0, 60) + ': ' + e.message);
      await new Promise(r => setTimeout(r, 700 * (k + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/**
 * Candidates for the ten: Solana pools sorted by 24h volume.
 *
 * WHY NOT "ALL THE TOKENS OF THE CHAIN", AS IT WAS. On the previous chain the
 * explorer handed back the full ERC-20 list, and that was enough: there were
 * hundreds of tokens there. On Solana there are millions, you cannot walk
 * them, and the only sensible entry point is a ranking by volume.
 *
 * WHY GECKOTERMINAL. Measurement on 14 October: for Solana DexScreener hands
 * back only boost lists of thirty positions, and those are paid placements,
 * so not a ranking. The word search gives five to sixteen tokens per word.
 * Neither of those is a ranking. GeckoTerminal hands back exactly a list of
 * pools sorted by volume, and that is exactly what is needed.
 *
 * A CEILING OF TWO HUNDRED POOLS. Free access hands back ten pages of twenty,
 * the eleventh returns 401. Out of two hundred pools about thirteen eligible
 * ones are left after all the rules, which is enough for ten seats with a
 * little slack. The word search goes as the second source and picks up those
 * that did not make the top two hundred.
 *
 * A PAUSE BETWEEN PAGES IS MANDATORY. Without it a 429 arrives as early as
 * the sixth page in a row, and the list comes back truncated, and a truncated
 * list is not an error but a quietly wrong ten.
 */
let JUP_CACHE = { rows: [], source: '', at: 0 };

/**
 * The candidate field: what trades on the chain at all right now.
 *
 * Returns rows that are already PARSED, not addresses. The previous version
 * handed back addresses, and the numbers took a second trip to DexScreener,
 * in chunks of thirty, with the risk that a chunk would not arrive. Now it is
 * all in one response, and there is no second trip at all.
 */
async function universe() {
  if (JUP_CACHE.rows.length && Date.now() - JUP_CACHE.at < JUP_TTL_MS) {
    return { rows: JUP_CACHE.rows.slice(), source: JUP_CACHE.source, cached: true };
  }

  const got = await Promise.allSettled(JUP_LISTS.map(
    name => ask(JUP_TOKENS + name + '?limit=' + JUP_LIMIT, 2)));

  const raw = [];
  for (const r of got) if (r.status === 'fulfilled' && Array.isArray(r.value)) raw.push(...r.value);

  if (!raw.length) {
    /* Not one list arrived. We hand back the fallback and say so out loud:
       the page has to caption it "partial list" and not pretend that this is
       the chain's ten. */
    return { rows: [], source: 'fallback', why: 'the aggregator answered with no list at all' };
  }

  /* The SOL price is taken from the same response, not a separate request: it
     is always there, because SOL trades more than anything. It is needed to
     compute a seat's price IN SOL, which is what the crank checks a quote
     against the market with, and without it that check does not work at all. */
  const solRow = raw.find(t => t && t.id === CHAIN.quote);
  const solUsd = Number(solRow && solRow.usdPrice) || null;

  /* One address, one row. The lists overlap, and the first encounter wins:
     the order of the lists is fixed, and 24h volume comes first. */
  const seen = new Set();
  const rows = [];
  for (const t of raw) {
    const addr = t && t.id;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    const row = shapeJup(t, solUsd);
    if (row) rows.push(row);
  }

  const source = got.every(r => r.status === 'fulfilled') ? 'jupiter' : 'jupiter-partial';
  JUP_CACHE = { rows: rows.slice(), source, at: Date.now() };
  return { rows, source };
}

/* THE RIGHT TO MINT MORE SUPPLY OR TO FREEZE AN ACCOUNT.
 *
 * THIS RULE DID NOT EXIST, AND IT CAUGHT A REAL MISTAKE.
 *
 * In the live basket on 14 October the second seat was SPCX, a tokenized
 * SpaceX share from Backpack Securities, and the eighth was HYPE, a wrapper
 * of a coin from another chain. The docs promise the direct opposite:
 * "tokenized stocks never hold seats", "wrapped majors are excluded". The old
 * rules looked for them by name and by a ticker ending in the letter x, and
 * both slipped past: SPCX does not end in x, and HYPE is simply called HYPE.
 *
 * The difference you cannot fool with a name: such a coin has a LIVE owner.
 * He can mint more supply and can freeze someone's account, otherwise a
 * wrapper would not work as a wrapper, nor a share receipt as a receipt. The
 * chain's native markets do not have these rights: pump.fun strips them at
 * launch, and PUMP, JUP, RAY, STONK, KMNO, WIF, CARDS, arc do not have them.
 *
 * Measured over the hundred most traded: the rule removed HYPE, MU, JLP,
 * tOpenAI, BP, SKHY, SNDK, AMD, INJ, ORE, TTWO, DKNG. That is four classes,
 * each of which slipped past the name based rules: stocks without a trailing
 * x (SNDK, AMD, TTWO, DKNG), wrappers from another chain (HYPE, INJ, ORE),
 * receipts on a pool (JLP) and coins whose supply the owner can add to at
 * will.
 *
 * WHAT IT COSTS. A native token whose owner deliberately kept the mint right
 * will fly out too. That is a defensible trade: the index should not hold a
 * coin whose supply someone can expand at any moment. The rule is checkable
 * on the chain by anyone, in one line.
 *
 * An empty field means "we do not know", not "there is no right": such a coin
 * is not filtered out. The source may not hand back this field, and throwing
 * out everyone it stayed silent about would mean ending up without a ten. */
function hasLiveAuthority(t) {
  return Boolean(t && (t.mintAuthority || t.freezeAuthority));
}

/** A basket row from the aggregator's response. */
function shapeJup(t, solUsd) {
  if (!t || !isAddress(t.id)) return null;
  const s = t.stats24h || {};
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const vol24 = num(s.buyVolume) + num(s.sellVolume);
  const txns24 = num(s.numBuys) + num(s.numSells);
  const price = Number(t.usdPrice);

  return {
    sym: t.symbol || '',
    name: t.name || '',
    address: t.id,
    price: Number.isFinite(price) ? price : null,
    /* The seat's price IN SOL. The crank badly needs it: with it he checks
       the aggregator's quote against the market and refuses the seat if the
       quote has run off threefold. Without the SOL price there is nothing to
       compute it from, and then null is more honest than an invention. */
    priceNative: (solUsd > 0 && Number.isFinite(price)) ? price / solUsd : null,
    chg24: num(s.priceChange),
    /* The 5m/1h/6h changes are the only price history we have. The sparkline
       is built from them, not from an invented curve. */
    chg6: num(t.stats6h && t.stats6h.priceChange),
    chg1: num(t.stats1h && t.stats1h.priceChange),
    chg5: num(t.stats5m && t.stats5m.priceChange),
    liq: num(t.liquidity),
    vol24,
    txns24,
    marketCap: num(t.mcap) || num(t.fdv),
    /* How many pools, the aggregator does not say, and there is nothing to
       invent. The basket row shows this number, so there will be a dash
       there, not a zero: a zero would mean "no pools", which is untrue. */
    pools: null,
    dex: null,
    url: API.dexPage + t.id,
    pairId: null,
    icon: t.icon || '',
    /* The coin's decimals and program. The crank needs them for a transfer,
       and used to ask the node for them one request per seat: ten surplus
       calls per epoch, each of which might not arrive. */
    decimals: Number.isFinite(Number(t.decimals)) ? Number(t.decimals) : null,
    program: t.tokenProgram || null,
    /* The coin owner's rights. See hasLiveAuthority above. */
    mintAuthority: t.mintAuthority || null,
    freezeAuthority: t.freezeAuthority || null,
    /* The aggregator's own estimate of how live the volume is. It does NOT go
       into the selection: measurement showed the "organic" share of every coin
       on the chain lies between zero and fourteen percent, and a threshold on
       it would have cut off the whole field. We keep it as a caption in the
       console: seeing someone else's opinion is useful, obeying it is not. */
    organic: t.organicScoreLabel || null,
    holders: Number.isFinite(Number(t.holderCount)) ? Number(t.holderCount) : null,
  };
}

/** Pairs by address, in chunks. A failed chunk does not take the rest down. */
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

/** The second source: a word search. Picks up what Blockscout does not have. */
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
 * Folding pairs into tokens. Liquidity and volume are summed across all
 * pools, which is how the original captions it: "one token, one seat ·
 * pools summed". The price comes from the deepest pool: that is the market.
 */
function foldPairs(pairs) {
  const by = new Map();
  pairs.forEach(p => {
    const b = p && p.baseToken;
    if (!b || !b.address || !p.priceUsd) return;
    /* The key without case folding. On the previous chain folding was
       right: EVM addresses are case insensitive. On Solana an address is
       base58 and the case carries meaning: two DIFFERENT coins that
       differ only in case would collapse into one row, and one of them
       would carry off the other's volume. */
    const key = b.address;
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const vol = (p.volume && p.volume.h24) || 0;
    /* The 24h trade count. The selection rule needs it: a million of volume
       done in six hundred trades and the same million done in fifty thousand
       are different markets, and the first is far easier for two people to
       paint than the second. */
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

       It used to be one that went out, the one DexScreener computes the
       price from. That is not enough for the crank: it can only buy where
       they pay in ether, and the deepest pool is sometimes not one of those.
       For AI on 29 August the only pair turned out to be AI/NVDA, and "the
       deepest" was at once the only one and unusable. */
    prev.all.push(p);
    if (liq > prev.deepest) { prev.deepest = liq; prev.pair = p; }
  });
  return [...by.values()];
}


function shape(t) {
  const p = t.pair;
  const b = p.baseToken;
  return {
    sym: b.symbol,
    name: b.name,
    address: b.address,
    price: Number(p.priceUsd),
    /* The price in ether, not in dollars. The page does not need it, the
       crank badly does: with it he filters out pools with a painted price.
       There are dozens of those on this chain: one token turned out to have
       eighty six pools, and the best quote came from a dummy where the same
       money "buys" six hundred times more coins. */
    priceNative: Number(p.priceNative) || null,
    chg24: Number((p.priceChange && p.priceChange.h24) ?? 0),
    /* The 5m/1h/6h changes are the only price history we have. The sparkline
       is built from them, not from an invented curve. */
    chg6: Number((p.priceChange && p.priceChange.h6) ?? 0),
    chg1: Number((p.priceChange && p.priceChange.h1) ?? 0),
    chg5: Number((p.priceChange && p.priceChange.m5) ?? 0),
    liq: t.liq,          // summed across all pools
    vol24: t.vol24,
    txns24: t.txns24,
    /* Market cap is taken from the deepest pool: DexScreener computes it
       from the price there. It used not to reach the basket row at all,
       because it did not affect the seat. */
    marketCap: Number(p.marketCap ?? p.fdv) || 0,
    pools: t.pools,
    dex: p.dexId,
    /* The link goes to DexScreener, not to the explorer: from a card people
       look at the market (price, depth, the book), not at contract bytecode.
       pairAddress here is 32 bytes: the chain runs Uniswap v4. */
    url: p.url || (API.dexPage + p.pairAddress),
    /* That deepest pool, the one price and volume were computed from. The
       crank needs it by address: walking a token's pools and hoping the right
       one turns up is a bad plan when there are eighty six of them. */
    pairId: p.pairAddress || null,
    /* The pools that pay in ether, native or wrapped.

       A separate list, because they cannot be searched for on the chain: a
       query for events by the second currency the node cuts off on timeout
       (measured 29 August), and the second currency is exactly the usual
       place of our token in a pair with ether. DexScreener, meanwhile, hands
       back all the pairs in one response, which we make anyway.

       Empty here means "nothing to buy with", and that is an honest answer:
       the seat will stay without a purchase, and its share goes to the rest. */
    /* The token's real icon. Arrives in the same response, does not cost a
       separate request. Not everyone has one: DOGO has none on DexScreener
       at all, and the explorer picks it up, see iconsFor below. */
    icon: fixIconUrl((p.info && p.info.imageUrl) || null),
    scanUrl: CHAIN.explorer + '/token/' + b.address,
  };
}

/* How much volume there has to be per unit of depth to call a pool alive.

   The measurement of 26 August that brought this about: the chain has five
   different tokens with the ticker DOG, and our choice of "among namesakes
   take the largest" settled on the one with 128 million of liquidity and ZERO
   volume, a wash traded pool without a single trade. It also held the first
   seat of the whole basket. The live DOG traded on 36 thousand of depth.

   The same happened with CAT and AI: for AI the dead address showed 8.1M of
   depth at zero volume, and the real one 2.3M of depth and 5.1M of volume.

   This is not cosmetics: the treasury will be buying these coins with real
   money. Buying on a pool with no trades means paying money for a figure. */
const ALIVE_RATIO = 0.005;      // 24h volume at least half a percent of depth

/** Whether this liquidity is used at all. */
function isAlive(t) {
  return Number.isFinite(t.liq) && t.liq > 0 &&
         Number.isFinite(t.vol24) && (t.vol24 / t.liq) >= ALIVE_RATIO;
}

/* Depth floors. They came with the weighted selection and for its sake.

   While a seat was given by liquidity alone, depth was the rule itself, and
   no floor was needed. Now a seat is driven most by volume and trade count,
   and those are the cheapest to paint: a pool of twenty thousand through
   which a million was run in a thousand trades scores high and comes out
   into the basket. You cannot buy into it with real money.

   DEPTH_FLOOR: how much depth there has to be at all.
   DEPTH_TO_MCAP: how much of it there has to be per unit of market cap:
   behind a big figure there must be a market, not one trade at a painted
   price. Both floors are taken from ponsloot, where on this same chain they
   filtered out exactly these cases. */
const DEPTH_FLOOR = 200_000;
const DEPTH_TO_MCAP = 0.005;

/* A CEILING ON THE AVERAGE TRADE. Volume divided by the trade count.

   The weighted selection does not catch this by itself, which came out on
   the live measurement of 10 September. HOOD's 11 million of volume was done
   in SIX HUNDRED trades, at 18,152 dollars apiece, while every other
   participant in the basket had an average trade between 520 and 2,100. The
   trade count weighed 1.9 percent of its score, that is almost nothing, and
   it still stood third: when things are ADDED UP, a near zero multiplier
   does not punish, it simply does not help. Its volume and depth held it up.

   Eleven million run through two or three pairs of hands is not the chain's
   market but someone's machine. The treasury buys with real money, and it
   must buy where many people trade, not two.

   Five thousand was chosen from the field itself: between 2,100 for the
   second from the top and 18,152 for HOOD the gap is almost tenfold, and a
   threshold in the middle touches none of the live ones. */
const TRADE_SIZE_CEILING = 5_000;

/* A TURNOVER FLOOR: HOW MUCH OF ITS OWN DEPTH A POOL TURNS OVER IN A DAY.

   The ceiling on the average trade above guards against painted VOLUME. The
   very same trouble comes mirrored, and there was no guard against that one:
   the depth is there, the trades are not. A seat is still won, because depth
   weighs 15 percent and market cap another 25, and together they outweigh the
   near zero shares in volume and trade count.

   Measurement on 29 September, the whole live deck, 26 candidates:

       AI        1.89   30,548 trades   depth    $7.9M
       MEME      2.29    3,921          $1.1M
       BUN       2.01    3,520          $0.95M
       PONS      0.18    1,579          $3.7M
       STANDARD  0.052     403          $13.9M
       PIPEDOG   0.046     677          $7.9M
       HOOD      0.038     266          $6.1M
       STATICS   0.012     254          $10.5M

   For STATICS eighty two percent of the seat came from depth alone, for
   STANDARD seventy three. Meanwhile STATICS did 254 trades for 129 thousand
   over a day on a pool of ten and a half million. That is not a market, it is
   parked money, and the site promises "the ten most traded coins of the chain".

   A tenth was chosen from the field itself: between STANDARD and the nearest
   live one, PONS, the gap is three and a half times, and a threshold in the
   middle touches none of those whose trading is real. It also cuts off
   PIPEDOG and HOOD, which show the same picture, except they stood eleventh
   and twelfth anyway.

   VOLUME WITHOUT DEPTH THIS FLOOR DOES NOT CATCH, and should not: that is what
   DEPTH_FLOOR is for. The two rules look in different directions, both needed. */
const TURNOVER_FLOOR = 0.10;

/* A TURNOVER CEILING. ON SOLANA IT MATTERS MORE THAN THE FLOOR.
 *
 * On the previous chain the trouble was one: depth is there, trades are not.
 * On Solana the top of the volume list is taken by the reverse, taken densely.
 *
 * Measured 14 October 2026, a hundred Solana pools by 24h volume, folded by
 * token. The distribution split by itself, without fitting:
 *
 *     cbBTC    1.0      real markets
 *     RAY      1.4
 *     WETH     1.5
 *     ZEC      1.9
 *     SOL      5.0      the most traded asset of the chain
 *     HYPE     7.8
 *     ----------------  the break is here
 *     ALLOX   14.6      wash trading starts beyond this
 *     VEIL    20.8
 *     Altai   26.1
 *     swordcat 78.7
 *     RSGP   288.5
 *     PULT   438.9
 *
 * PULT turns over four hundred and thirty nine of its own depths in a day.
 * That means every dollar of liquidity changed hands four hundred times,
 * which does not happen on a live market. For comparison SOL, the most traded
 * asset of the chain with forty seven million of depth and three hundred and
 * eighty thousand trades, does five.
 *
 * Twelve was chosen between HYPE and ALLOX and tied to SOL: nothing can turn
 * over more than twice as fast as the chain's base asset. The number is fixed
 * rather than computed from SOL on the fly, on purpose: a rule that depends
 * on another market will one day drift away with it, and there would be
 * nothing to explain that with.
 *
 * THE FLOOR AND THE CEILING CATCH DIFFERENT THINGS. The floor, parked money.
 * The ceiling, wash trading. The average trade ceiling next to them catches a
 * third: large trades, few of them. All three are needed, none replaces another. */
const TURNOVER_CEILING = 12;

function isTraded(t) {
  const cap = Number(t.marketCap) || 0;
  const txns = Number(t.txns24) || 0;
  const vol = Number(t.vol24) || 0;
  if (!(Number.isFinite(t.liq) && t.liq >= DEPTH_FLOOR)) return false;
  if (cap > 0 && t.liq / cap < DEPTH_TO_MCAP) return false;
  /* Zero trades with live volume is the same machine, only bolder: you
     cannot divide by zero, and you certainly cannot let this through. */
  if (vol > 0 && txns <= 0) return false;
  if (txns > 0 && vol / txns > TRADE_SIZE_CEILING) return false;
  if (t.liq > 0 && vol / t.liq < TURNOVER_FLOOR) return false;
  if (t.liq > 0 && vol / t.liq > TURNOVER_CEILING) return false;
  return true;
}

/* THE TICKER IS NORMALISED BEFORE ANY COMPARISON.

   The exclusion list was compared against `sym.toUpperCase()`, and it could
   be walked around with a space. Checked on live data: `"USDG "`, with a
   trailing space, already exists on the chain and stood in the candidate list
   next to sixteen other fakes of Global Dollar ("Upside Down Gorilla",
   "Gelobal Dollar", "Global Dollar United Only"). What threw it out was not
   the name but a small pool, which is to say luck.

   There were five ways around: a leading space, a trailing space, a
   non-breaking space, a tab and an invisible separator inside the word.

   LOOKALIKE LETTERS ARE FOLDED TOO. A Cyrillic capital A and a Greek capital
   alpha look like the Latin one, and to code they are different letters. On a
   chain that already holds fourteen HOOD fakes this is a matter of time, not
   fantasy. Only the capitals, the ones that confuse, are folded. */
const LOOKALIKE = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
  'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'І': 'I',
  'Ј': 'J', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I',
  'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y',
  'Χ': 'X',
  /* Armenian and Cherokee. Not an invention: on 14 October the top coin by
     volume on Solana was a USDT lookalike whose four letters came from
     Armenian, Cyrillic, Cherokee and Cyrillic again. Volume 170 million,
     52 trades, that is over three million per trade. */
  'Ս': 'U', 'Տ': 'S', 'Ա': 'A', 'Օ': 'O', 'Ո': 'N', 'Լ': 'L',
  'Ꭰ': 'D', 'Ꭱ': 'R', 'Ꭲ': 'I', 'Ꭺ': 'A', 'Ꭼ': 'E', 'Ꮇ': 'M',
  'Ꮃ': 'W', 'Ꮒ': 'H', 'Ꮓ': 'Z', 'Ꮶ': 'K', 'Ꮲ': 'P', 'Ꮯ': 'C',
};

function normSym(s) {
  return String(s || '')
    .toUpperCase()
    /* everything whitespace and every invisible formatting mark */
    .replace(/[\s ​-‏‪-‮⁠﻿]/g, '')
    .replace(/[^\x00-\x7F]/g, ch => LOOKALIKE[ch] || ch);
}

/** A seat in the basket goes to a market, not a receipt or an exchange wrapper. */
function isConstituent(t) {
  const sym = normSym(t.sym);
  const name = t.name || '';
  if (NOT_CONSTITUENTS.has(sym)) return false;
  if (MAJORS.has(sym)) return false;
  if (WRAPPED.test(name)) return false;
  if (looksPegged(t)) return false;
  if (STOCKISH.test(name) || STOCK_TICKER.test(t.sym || '')) return false;
  if (LPISH.test(name) || LPISH.test(t.sym || '')) return false;
  /* A live owner on a coin means no seat in the index. The rule caught SPCX
     and HYPE, standing in the live basket against the docs: hasLiveAuthority. */
  if (hasLiveAuthority(t)) return false;
  return Number.isFinite(t.price) && t.price > 0;
}

/* A SEAT IS COMPUTED FROM FOUR QUANTITIES, NOT FROM ONE.
 *
 * Until 10 September a seat was given by liquidity alone, and that produced a
 * false top: HOOD stood first with 10.92M of depth against 10.17M for AI,
 * while AI had three times the volume, three times the market cap and ninety
 * times the trades. HOOD's volume was done in six hundred trades, that is
 * eighteen thousand dollars apiece.
 *
 * What is added up is the token's SHARES in each quantity, not the numbers
 * themselves: market cap and trade count cannot be compared with each other,
 * while shares are always in the same units and add up to one. That is how
 * industry indices compute it, and how ponsloot does it on this same chain.
 *
 * THE WEIGHTS AND WHY THESE. The order was set by Alexander: volume and the
 * number of people trading matter most, then market cap, then depth.
 *
 *   24h volume:  how much money went through the coin;
 *   24h trades:  how many hands did it;
 *   market cap:  what the coin is worth;
 *   liquidity:   whether you can get in and out of it.
 *
 * Volume and trades stand side by side on purpose: separately each is
 * paintable, together they are not. A million of volume in two trades gives
 * high volume and zero trades; a thousand small trades, trades and no volume.
 */
const RANK_WEIGHTS = { vol24: 0.30, txns24: 0.30, marketCap: 0.25, liq: 0.15 };

function rankSeats(rows) {
  const totals = {};
  for (const key of Object.keys(RANK_WEIGHTS)) {
    totals[key] = rows.reduce((acc, t) => acc + Math.max(0, Number(t[key]) || 0), 0);
  }
  const score = t => Object.entries(RANK_WEIGHTS).reduce((acc, [key, weight]) => {
    /* A zero denominator means nobody has this quantity at all: then it
       simply does not take part, instead of dropping the whole score to NaN. */
    const total = totals[key];
    return acc + (total > 0 ? (Math.max(0, Number(t[key]) || 0) / total) * weight : 0);
  }, 0);
  return rows.map(t => ({ ...t, score: score(t) })).sort((a, b) => b.score - a.score);
}

/**
 * The most traded tokens of the chain, what the treasury would buy.
 * How many there are is decided by MODEL.seats, not by a number inside this
 * function: while it was written in here as a figure, changing the basket
 * size meant edits in six places, and one of them would surely stay old.
 *
 * Returns the data and where it came from. The second is not decoration: if
 * the list came back as the fallback, the page has to say so out loud.
 */
/* OUR OWN TOKEN DOES NOT GO INTO OUR OWN BASKET.
 *
 * The docs promise it in words: "APEX excludes itself. Buying your own token
 * with your own tax is a buyback, not an index". In the code this existed
 * NOWHERE: not here, not in the crank. Checks do not read prose, and the
 * promise held only on the fact that the token does not exist yet.
 *
 * It would have fired on the very first day. A seat is 60 percent given by
 * volume and trade count, and a fresh launch with a locked pool has more of
 * both than anything on the chain on its starting day. APEX would have taken
 * a seat in its own index, and a tenth of every epoch would have gone on
 * buying itself back with a fee charged on itself.
 *
 * The address arrives as an argument rather than from settings inside: the
 * core is one for the storefront, the server and the crank, and it must not
 * reach into the database. The caller passes it, each with its own source. */
async function readBasket({ exclude = '' } = {}) {
  const self = String(exclude || '').trim();
  const { rows, source, why } = await universe();

  /* Not one list arrived: we hand back the fallback ten and caption it as
     the fallback. Passing it off as the real one is the worst thing to do
     here: the project's main promise is "the ten most traded", and a silent
     substitution breaks exactly that. Which is what happened on the live
     server on 14 October, while the source was GeckoTerminal. */
  if (!rows.length) {
    const fb = FALLBACK_TOKENS.slice(0, MODEL.seats).map(a => ({
      sym: '', name: '', address: a, price: null, priceNative: null,
      liq: null, vol24: null, txns24: null, marketCap: null, pools: null,
      chg24: 0, chg6: 0, chg1: 0, chg5: 0, icon: '', decimals: null,
      program: null, url: API.dexPage + a,
    }));
    return { basket: fb, scanned: 0, priced: 0, alive: 0,
             source: 'fallback', why, at: Date.now() };
  }

  /* Our own token does not go into our own basket. Promised in the docs:
     buying your own coin with your own fee is a buyback, not an index. The
     comparison is case sensitive on purpose: on Solana addresses are case
     sensitive, and lowercasing them, as was done on the previous chain,
     would make the comparison wrong, and so the exclusion would silently
     stop working. */
  const priced = rows
    .filter(t => !self || t.address !== self)
    .filter(isConstituent);

  /* Dead and small pools are filtered out before ranking, not after:
     otherwise they take the top rows and push out the real markets. */
  const all = priced.filter(isAlive).filter(isTraded);

  /* One token, one seat. Symbols repeat on the chain: five "DOG"s from
     different addresses must not be in the basket, and the choice between
     them has to go by volume, not by a sum with liquidity, or the winner is
     the one whose depth is wash traded and who has no trades. */
  const seats = new Map();
  all.forEach(t => {
    /* The same normaliser as in the selection: otherwise "CAT" and "CAT "
       take two of the ten seats with one and the same coin. */
    const key = normSym(t.sym);
    const prev = seats.get(key);
    if (!prev || t.vol24 > prev.vol24) seats.set(key, t);
  });

  const basket = rankSeats([...seats.values()]).slice(0, MODEL.seats);

  /* The icons arrive in the same response as the numbers. The previous
     version picked them up with a separate trip to the explorer, one request
     per seat: ten surplus calls, each of which might not arrive, and once
     that took down the whole collection on an unforeseen kind of link. */

  return { basket, scanned: rows.length, priced: priced.length,
           alive: all.length, source, at: Date.now() };
}

/**
 * Pick up the missing icons from the explorer.
 *
 * One source is not enough, the same as with the token list. Measurement on
 * 26 August: of the six participants in the basket DexScreener knew five,
 * and the DOGO icon came only from Blockscout (it takes it from CoinGecko).
 *
 * Requests go only for those that have no icon: six surplus trips to a free
 * explorer on every paint is a sure way to get a 500 out of it and end up
 * with no list at all.
 *
 * A failed request breaks nothing: no icon, and the card draws the mark it
 * has always had.
 */
/**
 * Bring an icon's address to a usable size.
 *
 * Measurement on 26 August: DexScreener hands back 350 to 800 pixels, while
 * the explorer substitutes a CoinGecko link of the `/small/` kind, which is
 * 50 pixels. Fifty pixels stretched across a card look like mush next to
 * eight hundred, and one such icon makes the whole row look broken.
 *
 * At CoinGecko the same files sit in three sizes: thumb 25, small 50, large
 * 250. We switch to large: 250 is enough with slack.
 */
function fixIconUrl(url) {
  if (!url) return url;
  return url
            .replace(/\/(thumb|small)\//, '/large/');
}

async function iconsFor(list) {
  const need = list.filter(t => !t.icon && isAddress(t.address));
  if (!need.length) return list;
  await Promise.allSettled(need.map(async t => {
    try {
      const d = await ask(CHAIN.explorer + '/api/v2/tokens/' + t.address, 2);
      if (d && d.icon_url) t.icon = fixIconUrl(d.icon_url);
    } catch (_) { /* no icon, but with the mark */ }
  }));
  return list;
}

/* THE HOLDER COUNT IS ASKED OF THE NODE, NOT OF THE EXPLORER.

   On the previous chain Blockscout handed it over in one field:
   `/api/v2/tokens/...` returned holders_count, and nothing else was needed.
   On Solana nobody has such a field for free: Solscan asks for a key,
   DexScreener does not know about holders at all.

   The node itself is there, though. The request is the same as the crank's:
   all the accounts of this coin. We only need to COUNT them, so we take zero
   bytes of data from each, and the response comes out many times shorter than
   even the crank's, which needs the owner and the balance.

   Measurement 14 October, the public node: for the coins of our own basket it
   hands back a hundred thousand accounts, and a million, in seconds. Sometimes
   it answers 413, which is load shedding, not a ceiling. Then null is returned
   and the storefront shows a dash: an honest dash beats an invented number.

   Accounts with a zero balance are not filtered out here, and that is a
   deliberate trade. Filtering them would mean dragging the balances along,
   that is the very gigabytes. The number comes out slightly high: whoever
   sold everything but did not close the account still counts. The crank,
   which HANDS OUT, counts differently and exactly: it needs balances anyway. */
async function holdersOf(address) {
  if (!isAddress(address)) return null;
  const rpcUrl = (typeof process !== 'undefined' && process.env && process.env.APEX_RPC)
    || CHAIN.rpc;
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

  const call = async (body) => {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error('the node answered ' + r.status);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || 'node error');
    return d.result && d.result.value !== undefined ? d.result.value : d.result;
  };

  try {
    /* Which program owns the coin: the filter on account size depends on
       that too. Token-2022 has a variable size, and a hard number would cut
       off real accounts. */
    const info = await call({ method: 'getAccountInfo',
                              params: [address, { encoding: 'base64' }] });
    const program = info && info.owner;
    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022) return null;

    const filters = [{ memcmp: { offset: 0, bytes: address } }];
    if (program === TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });

    const list = await call({ method: 'getProgramAccounts',
      params: [program, { encoding: 'base64',
                          dataSlice: { offset: 0, length: 0 }, filters }] });
    return Array.isArray(list) ? list.length : null;
  } catch (_) {
    return null;
  }
}

/**
 * One token's market: price, market cap, liquidity and volume across all of
 * its pools. Returns null where there is no data, and the dash on the page is
 * drawn by exactly that, not by a "we have not launched yet" flag.
 */
async function marketOf(token) {
  const out = { price: null, marketCap: null, liq: null, vol24: null, pools: null, pairId: null };
  if (!isAddress(token)) return out;
  const d = await ask(API.pairs + token);
  const pairs = Array.isArray(d) ? d : (d && d.pairs) || [];
  /* Compared without folding the case: see foldPairs. Folding here would
     mean claiming as ours a coin that differs from ours by one capital
     letter, and showing its market as our own. */
  const mine = pairs.filter(p => p.baseToken && p.baseToken.address === token);
  if (!mine.length) return out;
  const deepest = mine.reduce((a, b) =>
    ((b.liquidity && b.liquidity.usd) || 0) > ((a.liquidity && a.liquidity.usd) || 0) ? b : a);
  out.price = Number(deepest.priceUsd) || null;
  /* The address of the deepest pool. The "buy" link is assembled from it:
     it goes together by template, and there is no need to type it into the
     console by hand. The deep pool, not the first one that turns up: on a
     small one slippage eats the purchase. */
  out.pairId = deepest.pairAddress || null;
  out.marketCap = Number(deepest.marketCap ?? deepest.fdv) || null;
  /* Liquidity and volume are summed across all pools: its caption says
     "across N pools" outright. */
  out.liq = mine.reduce((s, p) => s + ((p.liquidity && p.liquidity.usd) || 0), 0);
  out.vol24 = mine.reduce((s, p) => s + ((p.volume && p.volume.h24) || 0), 0);
  out.pools = mine.length;
  return out;
}

/**
 * The size of an epoch in dollars: how much the treasury will hand out in
 * one three hour step at the current volume. Computed by the published rules,
 * not by fact: there are no facts yet. The page has to say so in words.
 */
/* THE RATE ARRIVES AS AN ARGUMENT, IT IS NOT TAKEN FROM MODEL.
 *
 * On the previous chain it was a 0.7% constant and could be read from
 * anywhere. On pump.fun the rate depends on market cap and changes in steps
 * by itself, without us. So whoever computes has to say at what rate he
 * computes: otherwise one day the page will show yesterday's.
 *
 * Without a rate null is returned, not "I will compute with a default". A
 * default here is precisely the way to show an untruth. */
function epochPot(vol24, rate) {
  if (!Number.isFinite(vol24) || vol24 <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const perDay = vol24 * rate;
  return perDay / (24 / MODEL.epochHours);
}

/* What a handout to this many holders will cost: accounts for each of the
   ten coins. The fee is one time and comes back to the holder, not to us. */
function rentFor(holders, seats = MODEL.seats, perAccount = RENT_PER_ACCOUNT_SOL) {
  const n = Math.max(0, Math.floor(Number(holders) || 0));
  return n * seats * perAccount;
}

/**
 * All of the calculator's arithmetic in one place: the share, the take per
 * epoch, a holder's dividend, the share of one basket position and the yield.
 *
 * It used to live right inside the page's painting, and there was nothing to
 * check it with: swapping a multiplier in the share formula went past all
 * thirty seven checks, because not one of them reached a line inside
 * paintCalc. Computing happens here, showing happens on the page.
 *
 * Returns null in every field that cannot be known: no price, no position
 * value; no volume, no dividend. The dash on the page is drawn by exactly
 * that.
 */
function dividendFor(amount, vol24, price, rate) {
  const share = Number.isFinite(amount) && amount > 0 ? amount / MODEL.supply : null;
  /* The rate is mandatory and arrives from outside: on pump.fun it depends
     on market cap and changes by itself. No rate, no dividend, and the page
     draws a dash. Putting something "by default" in here means showing a
     number that does not exist in life. */
  const pot = epochPot(vol24, rate);
  const mine = (share !== null && pot !== null) ? pot * share : null;
  const perDayCount = 24 / MODEL.epochHours;      // eight epochs in a day
  return {
    share,
    pot,
    mine,
    /* The horizons live here, not in the painting. Multiplying by eight and
       by thirty looks too simple to check, and that is exactly why it has to
       be checked: a formula living inside the painting is caught by nothing,
       and on this very code a doubled multiplier already went past all
       thirty seven checks.

       We compute at constant volume and say so in words on the page: not one
       of the horizons is promised, all three are arithmetic from today. */
    perDay: mine === null ? null : mine * perDayCount,
    per30d: mine === null ? null : mine * perDayCount * 30,
    /* The basket is equal weight: the take is split between the seats
       evenly, not by market weight. That is what the documentation says and
       what the contract must do. There are six seats, and the last two get
       one basis point less, see weightsBps. */
    perSeat: mine === null ? null : mine / MODEL.seats,
    value: (Number.isFinite(price) && price > 0 && Number.isFinite(amount)) ? amount * price : null,
    yieldPerEpoch: (mine !== null && Number.isFinite(price) && price > 0 && amount > 0)
      ? mine / (amount * price) : null,
      /* The annual one is simple, no compounding: the dividend is paid as a
       basket of other coins, not by buying more of our own, and there is
       nothing to reinvest it with automatically. The page says the same, "simple". */
    yieldAnnual: (mine !== null && Number.isFinite(price) && price > 0 && amount > 0)
      ? (mine / (amount * price)) * (24 / MODEL.epochHours) * 365 : null,
  };
}

const CORE = {
  CHAIN, API, MODEL, NOT_CONSTITUENTS, STOCKISH, LPISH, SEARCH_WORDS,
  FALLBACK_TOKENS, CHUNK, ADDR_RE,
  creatorFeeAt, CREATOR_FEE, RENT_PER_ACCOUNT_SOL, rentFor,
  isAddress, ask, UA, universe, shapeJup, hasLiveAuthority, pairsFor, pairsBySearch,
  foldPairs, shape, isConstituent, isAlive, ALIVE_RATIO, readBasket, iconsFor, fixIconUrl, holdersOf, marketOf, epochPot, dividendFor,
  weightsBps,
  /* The selection rule goes out whole: the set of checks has to be reachable
     by the tests, or they start repeating it with their own copy and guarding
     that, not the real one. This already happened with the weights in check.js. */
  isTraded, DEPTH_FLOOR, DEPTH_TO_MCAP, TRADE_SIZE_CEILING,
  TURNOVER_FLOOR, TURNOVER_CEILING, rankSeats, RANK_WEIGHTS,
  isConstituent, looksPegged, PEG_BAND, PEG_MOVE, NOT_CONSTITUENTS, normSym,
  MAJORS, WRAPPED, STOCKISH, STOCK_TICKER,
};

/* The same name in both worlds: in the browser globalThis is window, in Node
   it is the process's global object. The importing side does not have to know
   where it is. */
globalThis.ApexCore = CORE;

})();
