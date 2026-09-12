/* =========================================================================
   Reading the chain for the crank. Read-only: nothing gets signed and
   nothing gets sent, this file needs no key.

   THE LAUNCH IS ON PONS, AND THAT IS UNISWAP V3

   There used to be a letscash hook on Uniswap V4 here: it held the 5% tax
   in plain ETH, and the crank took what had accrued by calling claim. On
   Pons there is no such thing and there cannot be: V3 has no hooks. The
   only income is the pool's own fee, 1%, and it accrues on the liquidity
   position that Pons locked away in its locker forever.

   Three differences follow from that, and each one changes the code:

     1. Collection goes through `PonsLaunchLocker.collectFees(token)`, not
        through `hook.claim(poolId)`. It can be taken by the locker owner,
        by whoever launched the token, or by the address the fees are
        redirected to.

     2. The fee arrives **in two tokens at once**. In V3 the fee is taken
        from the input of the trade: a buy pays in WETH, a sell pays in
        the token itself. So the epoch gets both ether and APEX. The
        ether goes to buying the ten; our own token we burn rather than
        sell, otherwise the dividend would be funded by pressure on our
        own market.

     3. Quotes come from QuoterV2 by pair and fee tier, not by a pool key
        with a hook. That also fixes an old breakage: in V4 quotes for
        other people's tokens reverted, because every pool has its own
        hook and its own tick spacing, and we were passing the letscash
        pool's parameters. V3 has no such parameters at all, only the
        pair and the fee.

   Every address below was read off the chain, not taken from the docs.
   There are several copies of each contract on this network: seven
   quoters named QuoterV2 turned up, and the two that fit are the ones
   whose `factory()` matches the factory from the Pons config. Both gave
   the same quote on a live pool, and the first one was taken. Re-check
   this if the launchpad moves.
   ========================================================================= */

import './../core.js';
import { pickQuote } from './plan.js';

const C = globalThis.ApexCore;

export const ADDR = {
  launchFactory:   '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',  // PonsLaunchFactory
  locker:          '0x736d76699c26d0d966744cae304c000d471f7f35',  // PonsLaunchLocker
  v3Factory:       '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
  swapRouter:      '0xcaf681a66d020601342297493863e78c959e5cb2',
  quoter:          '0x5dEdB1F91F5F56177BB4D193aD281b33e4f13098',  // QuoterV2, for V3
  weth:            '0x0bd7d308f8e1639fab988df18a8011f41eacad73',

  /* Half the basket trades on Uniswap V4, not on V3. That is just how it
     turned out on this chain. We will have to buy there anyway, so we have
     to quote there too. These two addresses are left over from the
     previous version of the crank and are still correct. */
  poolManager:     '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  quoter4:         '0x08A50911bac753b7e11a7e5631afA19F14C1Af55',  // V4Quoter

  /* Swapping on V4 from an ordinary wallet is impossible: all the pools sit
     in one PoolManager, and it does not exchange coins on a direct call. It
     unlocks and calls back into the code of whoever called it. A wallet has
     no code. So an intermediary contract is needed, and that is the
     standard UniversalRouter.

     Found not by name (searching the explorer for the word Router gives
     only meme tokens) but by deed: PoolManager's Swap events were taken and
     the sender field read, that is, whoever called the swap. Measured on
     August 29: over 2000 blocks, 5510 swaps from 95 contracts, the largest
     being this one with 47% of all swaps. The contract was checked in the
     explorer. */
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  permit2:         '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

/* The fee tier of our launch pool, from the Pons config read off the
   chain: poolFee = 10000 points = 1%, tick spacing 200. */
export const POOL_FEE = 10_000;

/* Which fee tiers are enabled at all on this Uniswap V3. Checked by
   calling `feeAmountTickSpacing`: 0.01%, 0.05%, 0.3% and 1%. Two, three
   and five percent are not there, so a five percent pool cannot exist,
   neither ours nor anyone else's on this chain. Ordered from common to
   rare: basket members almost always trade in the one percent tier. */
export const FEE_TIERS = [10_000, 3_000, 500, 100];

/* Selectors computed ahead of time so we do not pull in a library for ten
   lines. Next to each one is the signature it can be re-checked against. */
export const SEL = {
  collectFees:       '0xa480ca79',  // collectFees(address)
  getLaunchedToken:  '0x3cf28b5a',  // getLaunchedToken(address)
  feeRedirects:      '0xdce780c2',  // feeRedirects(address)
  protocolFeeShares: '0xf1c8f3c0',  // tokenProtocolFeeShares(address)
  getPool:           '0x1698ee82',  // getPool(address,address,uint24)
  liquidity:         '0x1a686502',  // liquidity()
  balanceOf:         '0x70a08231',  // balanceOf(address)
  decimals:          '0x313ce567',  // decimals()
  totalSupply:       '0x18160ddd',  // totalSupply()
  quoteIn:           '0xc6a5026a',  // quoteExactInputSingle((address,address,uint256,uint24,uint160))
  quoteV4:           '0xaa9d21cb',  // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
};

/* The node comes from an environment variable, defaulting to the live one.

   This is what it is all for: a full epoch is rehearsed against a fork, a
   local copy of the live chain (`anvil --fork-url`) where anything can be
   signed and nothing leaves the machine. While the address was a hardcoded
   constant, such a rehearsal meant editing code right before launch, which
   is the most dangerous edit there is.

   Sending transactions (send.js) goes through the same `rpc`, so one
   variable covers the whole crank. */
const RPC = process.env.APEX_RPC || C.CHAIN.rpc;
export const RPC_URL = RPC;
export const IS_DEFAULT_RPC = RPC === C.CHAIN.rpc;

/* Event history is asked of the live node even on a fork.

   A fork copies the STATE of the chain, not the event log: `anvil
   --fork-url` comes up with empty logs, and a history query returns zero.
   And V4 pool keys are read precisely from Initialize events, which means
   on a fork the crank would find no pool at all and report there was
   nowhere to buy. Checked right here on August 29: the dry run against the
   fork said exactly that about DOGO, whose pool exists and works.

   Reading history from the live node is safe and correct: a pool key is
   five immutable fields, it does not depend on where we later send the
   transaction. Balances and prices change, and those arrive through
   ordinary calls and are taken from the fork, as they should be.

   The variable lets you point at your own archive node; the default is the
   live one. */
const LOGS_RPC = process.env.APEX_LOGS_RPC || C.CHAIN.rpc;
const HISTORICAL = new Set(['eth_getLogs']);
export const LOGS_URL = LOGS_RPC;

let id = 0;

/* Retries are mandatory: the node is free and shared, and a "fetch failed"
   out of nowhere is routine here. One dropped request must not bring down
   the whole calculation, which is exactly what happened on the first run. */
export async function rpc(method, params = [], tries = 4) {
  /* The only seam for substituting the node in checks.

     It is needed because the sending layer has to be checked where there is
     no node: caps, nonces and the behaviour on a vanished transaction are
     our rules, not the network's behaviour, and running a live chain for
     their sake means not checking them at all.
     The hook is installed only by a test; in production globalThis.__rpcHook
     does not exist, and the branch never runs. */
  if (typeof globalThis.__rpcHook === 'function') {
    return globalThis.__rpcHook(method, params);
  }

  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 20_000);
      try {
        const res = await fetch(HISTORICAL.has(method) ? LOGS_RPC : RPC, {
          method: 'POST',
          signal: stop.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        const d = await res.json();
        if (d.error) {
          const msg = d.error.message || 'node error';
          /* A fork on its first block cannot answer eth_call.

             Anvil takes the block header straight from the chain, and
             Robinhood Chain does not fill in the blob gas fields, which
             appeared after it. While the fork stands on that inherited
             block, any eth_call fails with "Excess blob gas not set", and
             there is nothing to understand from that.

             One command cures it: make the fork mine a block of its own,
             whose header it composes itself. Checked on August 29: after
             `anvil_mine` everything reads.

             Transactions go through even before that mining: only reading
             breaks. That is why the hint belongs here. */
          if (/blob gas/i.test(msg) && !IS_DEFAULT_RPC) {
            throw new Error(
              'the fork stands on an inherited block and cannot answer reads.\n'
              + '  Mine one block of its own and retry:\n'
              + '    curl -s -X POST ' + RPC + " -H 'content-type: application/json' \\\n"
              + '      -d \'{"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["0x1"]}\'');
          }
          throw new Error(msg);
        }
        return d.result;
      } finally { clearTimeout(timer); }
    } catch (e) {
      last = e;
      /* Retrying a contract revert is pointless: the answer will not change. */
      if (/revert/i.test(e.message || '')) break;
      await new Promise(r => setTimeout(r, 700 * (k + 1)));
    }
  }
  throw new Error(method + ': ' + (last && last.message ? last.message : 'node did not answer'));
}

export const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

const pad = x => {
  let v = typeof x === 'string' && x.startsWith('0x') ? BigInt(x) : BigInt(x);
  if (v < 0n) v += 1n << 256n;
  return v.toString(16).padStart(64, '0');
};
const bare = a => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * What Pons knows about our launch: who launched it, which liquidity
 * position belongs to it, what fee tier the pool has and where the fees go.
 *
 * The venue's share is read by a separate call, because it is the most
 * important number in the whole scheme and because it is **frozen at
 * launch**: the locker writes `tokenProtocolFeeShares[token]` once, when it
 * locks the position, and reads the stored value from then on. Pons can
 * change the global setting as much as it likes, and that will not affect
 * an already locked token. We read exactly the stored value, not the global
 * one: otherwise the crank will one day compute our income at someone
 * else's rate.
 */
export async function launchInfo(token) {
  const arg = bare(token);
  const [r, share, redirect] = await Promise.all([
    call(ADDR.launchFactory, SEL.getLaunchedToken + arg),
    call(ADDR.locker, SEL.protocolFeeShares + arg),
    call(ADDR.locker, SEL.feeRedirects + arg),
  ]);
  const w = (r || '0x').slice(2).match(/.{1,64}/g) || [];
  /* A struct of thirteen fields, all static, so they lie one after another
     with no offset. The order was checked against the factory source:
     token, deployer, pairedToken, positionManager, positionId, dexId,
     launchConfigId, restrictionsEndBlock, supply, isToken0, poolFee,
     exists, initialBuyAmount. */
  if (w.length < 13) throw new Error('token was not launched through Pons');
  const exists = BigInt('0x' + w[11]) === 1n;
  if (!exists) throw new Error('token was not launched through Pons');

  const venueShare = Number(BigInt(share || '0x0'));
  const to = '0x' + (redirect || '').slice(-40);
  const deployer = '0x' + w[1].slice(24);
  return {
    token:      '0x' + w[0].slice(24),
    deployer,
    pairToken:  '0x' + w[2].slice(24),
    positionId: BigInt('0x' + w[4]),
    poolFee:    Number(BigInt('0x' + w[10])),
    isToken0:   BigInt('0x' + w[9]) === 1n,
    supplyWei:  BigInt('0x' + w[8]),
    venueShare,                          // percent to the venue, 0..50
    /* An empty redirect means "pay whoever launched it", which is exactly
       how the locker itself decides. We repeat its rule here so the crank
       does not ask twice and does not diverge from it. */
    feeTo: /^0x0{40}$/.test(to) ? deployer : to,
  };
}

/**
 * How much fee has accrued on the locked position right now.
 *
 * The trick: the locker has no function of its own for "show me how much
 * is in there". But it does have `collectFees`, and it can be **called
 * dry** through eth_call: the node computes the result, returns both
 * amounts and writes nothing. It is the same code that will later run for
 * real, which means the number shown is the number that will arrive.
 *
 * Returns two amounts: ether and our own token. In V3 the fee is taken
 * from the input of the trade (a buy pays in WETH, a sell in the token),
 * so the epoch almost always gets both.
 */
export async function poolPot(token, info) {
  const nfo = info || await launchInfo(token);
  let r;
  try {
    r = await rpc('eth_call', [{ to: ADDR.locker, from: nfo.feeTo,
                                data: SEL.collectFees + bare(token) }, 'latest'], 2);
  } catch (e) {
    /* The locker reverts with `NoFeesToCollect` when there is nothing to
       collect. That is not a breakage but the ordinary state of a quiet
       epoch, and it should go upward as zeros, not as an exception. */
    if (/NoFees|revert/i.test(e.message || '')) {
      return { ethWei: 0n, tokenWei: 0n, total: 0n, venueShare: nfo.venueShare, empty: true };
    }
    throw e;
  }
  const w = (r || '0x').slice(2).match(/.{1,64}/g) || ['0', '0'];
  const a0 = BigInt('0x' + (w[0] || '0'));
  const a1 = BigInt('0x' + (w[1] || '0'));
  /* Which of the two is ours the address order in the pool decides, not a guess. */
  const tokenWei = nfo.isToken0 ? a0 : a1;
  const gross = nfo.isToken0 ? a1 : a0;
  /* The locker does not hand over everything: it deducts its own share in
     the same transaction. We count it honestly right away, otherwise the
     crank decides there is enough money while less arrives on the account,
     and the payout breaks off halfway. */
  const ethWei = gross - (gross * BigInt(nfo.venueShare)) / 100n;
  const mineToken = tokenWei - (tokenWei * BigInt(nfo.venueShare)) / 100n;
  return { ethWei, tokenWei: mineToken, gross, total: ethWei,
           venueShare: nfo.venueShare, empty: gross === 0n && mineToken === 0n };
}

/**
 * Which pool this token trades in and at what fee tier.
 *
 * We walk the enabled fee tiers and take the pool with more liquidity.
 * Guessing is impossible: basket members launched wherever they liked, not
 * only on Pons, and their fee tier is their own. This is exactly where the
 * previous crank tripped: it passed the launchpad pool's parameters to
 * everything, and quotes for other people's tokens reverted.
 */
export async function poolFor(token, pair = ADDR.weth) {
  const [a, b] = token.toLowerCase() < pair.toLowerCase() ? [token, pair] : [pair, token];
  const found = [];
  for (const fee of FEE_TIERS) {
    let addr;
    try {
      const r = await call(ADDR.v3Factory, SEL.getPool + bare(a) + bare(b) + pad(fee));
      addr = '0x' + (r || '').slice(-40);
    } catch (_) { continue; }
    if (/^0x0{40}$/.test(addr)) continue;
    try {
      const l = BigInt(await call(addr, SEL.liquidity) || '0x0');
      if (l > 0n) found.push({ pool: addr, fee, liquidity: l });
    } catch (_) { /* the pool exists but does not answer, not our case */ }
  }
  if (!found.length) throw new Error('no pool with liquidity found: ' + token);
  found.sort((x, y) => (y.liquidity > x.liquidity ? 1 : -1));
  return found[0];
}

/* =========================================================================
   The basket does not live on one exchange.

   Measured on August 26 across the ten: four tokens trade in Uniswap V3
   pools of the Pons factory, one on a different V3 factory, and **five on
   Uniswap V4**. One quoter is not enough for all of them, and this is no
   small thing: buying in a shallow pool when a deep one is right there
   means losing holders' money to slippage on every epoch.

   This is where the previous crank tripped. It called the V4 quoter,
   passing everything the letscash pool's parameters, its own hook and its
   own tick spacing, and for other people's tokens the call reverted. Now
   the pool's parameters are not guessed but **read from the PoolManager's
   own Initialize event**: it holds both currencies, the fee, the tick
   spacing and the hook address. A topic filter finds them across the whole
   chain history in half a second.

   It also turned out that half of these pools have no hook at all, the
   address is zero. So passing someone else's hook was not merely
   imprecise but plainly wrong.
   ========================================================================= */

/* Initialize(bytes32,address,address,uint24,int24,address,uint160,int24) */
const TOPIC_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const NATIVE = '0x0000000000000000000000000000000000000000';

/* How many V4 pools it makes any sense to poll. Asking all of them is
   eighty calls per token and eight hundred per epoch; the node is free and
   does not hold that pace. We take the twelve most recent: trading happens
   in the recently created one, and the old ones are almost always
   abandoned shells. */
const MAX_V4_POOLS = 12;

/* In V4 the fee can be dynamic: instead of a number the field holds the
   flag 0x800000, and the real fee is decided by the hook on every trade.
   Dividing that flag by a hundred like an ordinary fee gives "838.86%",
   which is what got printed on the first run. */
export const DYNAMIC_FEE = 0x800000;
export const feeLabel = f =>
  (f === DYNAMIC_FEE ? 'dynamic' : (f / 10_000) + '%');

/** Parsing the Initialize event into pool parameters. */
function keyFromLog(lg) {
  const w = ((lg.data || '0x').slice(2).match(/.{1,64}/g)) || [];
  if (w.length < 3) return null;
  const int24 = h => { const v = BigInt('0x' + h); return Number(v >= 1n << 255n ? v - (1n << 256n) : v); };
  return {
    currency0: '0x' + lg.topics[2].slice(26),
    currency1: '0x' + lg.topics[3].slice(26),
    fee: Number(BigInt('0x' + w[0])),
    tickSpacing: int24(w[1]),
    hooks: '0x' + w[2].slice(24),
  };
}

/**
 * The parameters of a V4 pool by its identifier.
 *
 * The identifier is a hash of the five fields, and nothing can be got back
 * out of it. But the pool was born once, and at birth the PoolManager
 * wrote all five into an event. A topic filter finds it across the whole
 * chain history in half a second, cheaper than walking eighty foreign
 * pools and hoping the right one turns up.
 */
export async function v4KeyById(poolId) {
  const logs = await rpc('eth_getLogs', [{
    address: ADDR.poolManager, fromBlock: '0x0', toBlock: 'latest',
    topics: [TOPIC_INIT, poolId],
  }], 2);
  if (!logs || !logs.length) return null;
  return keyFromLog(logs[0]);
}

/**
 * What this pool is paid in, and whether we can pay in it.
 *
 * All we have is ether: native or wrapped. A "token against someone else's
 * token" pool is not a pool for us, however much liquidity is in it.
 *
 * This is not nitpicking. On August 29 the measurement showed: AI has
 * **one single** pair on the whole chain, AI/NVDA on V4, with $3.36m of
 * liquidity. The quoter answered it with an honest number, only it was
 * answering a different question: "how much AI for so much NVDA". The
 * crank read that as an answer about ether, put the seat into the plan and
 * would have gone off to buy with something it does not have.
 *
 * A silent currency substitution is worse than a refusal: a refusal is
 * visible, a substitution is not.
 */
/** The same pool or different ones. A pool is defined by all five fields. */
const sameKey = (a, b) =>
  a.fee === b.fee && a.tickSpacing === b.tickSpacing &&
  a.hooks.toLowerCase() === b.hooks.toLowerCase() &&
  a.currency0.toLowerCase() === b.currency0.toLowerCase() &&
  a.currency1.toLowerCase() === b.currency1.toLowerCase();

export function paysInEth(key, token) {
  const t = String(token).toLowerCase();
  const other = key.currency0.toLowerCase() === t ? key.currency1 : key.currency0;
  const o = other.toLowerCase();
  return o === NATIVE.toLowerCase() || o === ADDR.weth.toLowerCase();
}

/** Every V4 pool this token appears in, with their real parameters. */
export async function v4PoolsFor(token) {
  const t = '0x' + bare(token);
  /* Both sides are asked separately, and both can fail to answer.

     Measured on August 29: a query by currency1 over the whole history gets
     cut off by the node with "log query timed out". And currency1 is
     precisely the normal case for a pair with ether: native ether is the
     zero address, it always sorts first, so our token is always second.

     Both errors used to be swallowed through `.catch(() => [])`, and the
     pool search returned empty: not "found nothing" but "did not ask". The
     crank was left with the single pool DexScreener points at and bought
     through it blind. Now the failure is visible: it is recorded and goes
     upward as a line in the report. */
  const failed = [];
  const askSide = (topics, side) =>
    rpc('eth_getLogs', [{ address: ADDR.poolManager, fromBlock: '0x0',
                          toBlock: 'latest', topics }], 2)
      .catch(e => { failed.push(side + ': ' + (e.message || e)); return []; });

  const both = await Promise.all([
    askSide([TOPIC_INIT, null, t], 'currency0'),
    askSide([TOPIC_INIT, null, null, t], 'currency1'),
  ]);
  v4PoolsFor.lastFailures = failed;
  const out = [];
  const seen = new Set();
  /* From newest to oldest: for a token with eighty-six pools almost all the
     old ones are abandoned shells, and trading happens in the one created
     last. */
  const logs = [...(both[0] || []), ...(both[1] || [])]
    .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)));

  for (const lg of logs) {
    const key = keyFromLog(lg);
    if (!key) continue;
    /* A pool is defined by the five fields in full: identical fives are the
       same pool, and there is no point asking about it twice. */
    const id = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks].join('|').toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    /* The pair must be with ether, native or wrapped. We are going to pay
       in ether, and a "token against someone else's token" pool has nothing
       to do with it. Wrapped counts equally: WTH's real pool is exactly
       that, and the "native only" rule threw it out silently. */
    if (!paysInEth(key, token)) continue;
    out.push(key);
    if (out.length >= MAX_V4_POOLS) break;
  }
  return out;
}

/**
 * A quote in one V4 pool by its real key.
 *
 * The swap direction is taken from the **token being bought**, not from
 * whether native ether sits in the first currency. The difference is not
 * theoretical: WTH's real pool is paired with WETH, not with native ether,
 * and the rule "currency zero means ether" turned the trade back to front.
 * The quoter honestly answered "zero", since it thought we were selling
 * WTH, which we do not have, and the crank decided there was nowhere to buy
 * while standing next to a million dollars of liquidity.
 */
export async function quoteV4(key, amountWei, token) {
  const zeroForOne = key.currency0.toLowerCase() !== String(token).toLowerCase();
  const data = SEL.quoteV4
    + pad(0x20)
    + bare(key.currency0) + bare(key.currency1)
    + pad(key.fee) + pad(key.tickSpacing) + bare(key.hooks)
    + pad(zeroForOne ? 1 : 0)
    + pad(amountWei)
    + pad(0x100)   // offset to hookData
    + pad(0);      // hookData is empty
  const r = await call(ADDR.quoter4, data);
  const w = (r || '0x').slice(2).match(/.{1,64}/g) || [];
  if (!w.length) throw new Error('the V4 quoter said nothing');
  return { out: BigInt('0x' + w[0]), gas: w[1] ? BigInt('0x' + w[1]) : 0n };
}

/** A quote in one V3 pool by pair and fee tier. */
export async function quoteV3({ token, amountWei, fee, pair = ADDR.weth }) {
  const data = SEL.quoteIn + bare(pair) + bare(token) + pad(amountWei) + pad(fee) + pad(0);
  const r = await call(ADDR.quoter, data);
  const w = (r || '0x').slice(2).match(/.{1,64}/g) || [];
  if (!w.length) throw new Error('the V3 quoter said nothing');
  return { out: BigInt('0x' + w[0]), gas: w[3] ? BigInt('0x' + w[3]) : 0n };
}

/**
 * How many coins the ether will buy, and where they are cheaper.
 *
 * We ask every pool that exists at all and take the one that gives more
 * coins for the same money. The criterion is self-checking: there is no
 * need to guess correctly "where the real liquidity is", comparing the
 * answers is enough. A pool that reverts or gives back zero simply drops
 * out, and its silence brings nobody down.
 *
 * Computing from reserves works in neither place: in both V3 and V4
 * liquidity is spread unevenly across ranges, and to "estimate" is to be
 * wrong, the more so the larger the buy.
 */
export async function quote({ token, amountWei, pair = ADDR.weth, priceNative = null,
                              pairId = null, ethPairIds = [], band = 3 }) {
  const tries = [];

  for (const fee of FEE_TIERS) {
    tries.push(quoteV3({ token, amountWei, fee, pair })
      .then(q => ({ ...q, venue: 'v3', fee }))
      .catch(() => null));
  }

  const keys = await v4PoolsFor(token).catch(() => []);

  /* The pool DexScreener uses to compute the price is added by address.
     Without this it got lost: for AI and WTH the real pool made neither
     the first dozen by recency nor the sweep of V3 fee tiers, and the
     crank reported there was nowhere to buy while standing next to a
     million dollars of liquidity. */
  /* Pools known from outside to be paid in ether.

     Walking the chain does not find them: a query for events by the second
     currency gets cut off by the node on timeout, and the second currency
     is the usual place for our token in a pair with native ether (the zero
     address always sorts first). So the list comes from the basket, where
     it is assembled from DexScreener's answer, and here it is only resolved
     into real pool keys.

     A query by pool identifier is the only one of the three the node holds:
     it hits a single indexed topic instead of scanning the history. */
  for (const id of ethPairIds) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) continue;
    const k = await v4KeyById(id).catch(() => null);
    if (!k || !paysInEth(k, token)) continue;
    if (!keys.some(x => sameKey(x, k))) keys.push(k);
  }

  if (pairId && /^0x[0-9a-fA-F]{64}$/.test(pairId)) {
    const k = await v4KeyById(pairId).catch(() => null);
    /* This pool is checked by the same rule as the ones found by walking.
       It used to be added as is: "DexScreener shows the price through it,
       so it is real". Real it is, only for AI that is the AI/NVDA pair, and
       paying in it means paying with claims on NVIDIA stock. A seat with
       such a pool has nothing to buy with, and the honest answer is
       "nowhere", not a made-up number of coins. */
    if (k && !paysInEth(k, token)) {
      /* Skipping it silently is not allowed: from outside that looks like
         "there is no pool", while the pool exists and holds millions, just
         not our money. */
      quote.lastSkipped = (quote.lastSkipped || []).concat(
        [{ token, why: 'the pool does not pay in ether', currency0: k.currency0, currency1: k.currency1 }]);
    } else if (k && !keys.some(x => sameKey(x, k))) {
      keys.unshift(k);
    }
  }

  for (const k of keys) {
    tries.push(quoteV4(k, amountWei, token)
      .then(q => ({ ...q, venue: 'v4', fee: k.fee, hooks: k.hooks, key: k }))
      .catch(() => null));
  }

  /* Filtering out pools with a painted price and picking the best of the
     survivors happens in plan.js: there it is a pure function that can be
     run under a test, while here it would be a line inside a network call
     that no check would ever reach. The reference point is the token's
     price in ether from DexScreener: it is aggregated across all pools and
     weighted by volume. */
  const fair = priceNative > 0 ? Number(amountWei) / 1e18 / priceNative : null;
  const pick = pickQuote(await Promise.all(tries), { fair, band });
  if (!pick.ok) throw new Error(pick.why + ': ' + token);

  return { ...pick.best, alternatives: pick.alternatives,
           considered: pick.considered, edge: pick.edge };
}

/** The gas price right now. */
export const gasPrice = async () => BigInt(await rpc('eth_gasPrice'));

/**
 * How much of such a token sits on an address, as an integer.
 *
 * Needed after a buy: what gets paid out is what actually arrived, not what
 * the quote promised. The difference between them is slippage, and paying
 * out by the quote means promising more than was bought.
 */
export async function erc20Balance(token, who) {
  const r = await call(token, SEL.balanceOf + bare(who));
  return r && r !== '0x' ? BigInt(r) : 0n;
}

/** The ether balance of an address. The size of an epoch is now computed from it. */
export const ethBalance = async addr =>
  BigInt(await rpc('eth_getBalance', [addr, 'latest']));

/** The number of the latest block. */
export const head = async () => Number(BigInt(await rpc('eth_blockNumber')));

/**
 * Token holders at the snapshot block.
 *
 * The list of addresses comes from the explorer: it has a ready index,
 * while walking events across the whole history on every epoch is minutes
 * of work and thousands of requests.
 *
 * The **balances, though, are read from the contract**, and that is not
 * over-caution. Measured on August 26: the sum of the balances the
 * explorer handed back came to 107.5% of supply, since its index lags
 * behind for actively trading addresses. A payout on such numbers drifts
 * apart: someone gets more than their share, someone less, and in total
 * more goes out than was bought.
 *
 * We read at one fixed block, not at "latest": seconds pass between the
 * first read and the last, and balances change in them. A snapshot
 * assembled from different moments is not a snapshot.
 */
export async function holders(token, floor, opts = {}) {
  const { maxPages = 60, blockTag = null, batch = 20 } = opts;
  const block = blockTag || ('0x' + (await head()).toString(16));

  /* 1. Who holds at all, from the explorer's index. */
  const dec = await decimalsOf(token);
  const seen = new Set();
  const addrs = [];
  let url = C.CHAIN.explorer + '/api/v2/tokens/' + token + '/holders';

  for (let page = 0; page < maxPages && url; page++) {
    /* Five attempts, not three: this explorer returns a 500 about every
       other time, and on a list of twenty-three pages a miss is almost
       inevitable. Breaking the read off halfway is worse than waiting. */
    let d;
    try {
      d = await C.ask(url, 5);
    } catch (e) {
      /* The list is incomplete, so say so upward rather than pretend there
         are simply fewer holders. */
      return {
        block: Number(BigInt(block)), decimals: dec, holders: [],
        listed: addrs.length, failed: addrs.length || 1, complete: false,
        why: 'the explorer did not return the list: ' + (e.message || e),
      };
    }
    let stop = false;
    for (const it of (d.items || [])) {
      const rough = Number(it.value) / Math.pow(10, dec);
      /* The floor here has a twofold margin: the explorer can understate,
         and cutting by its number means losing someone who actually does
         pass the floor. The precise selection is below, on real balances. */
      if (rough < floor / 2) { stop = true; break; }
      const key = String(it.address.hash).toLowerCase();
      /* Between pages the list shifts, and one address arrives twice. The
         measurement caught exactly one such, and in a payout that is a
         double payment. */
      if (seen.has(key)) continue;
      seen.add(key);
      addrs.push({
        address: it.address.hash,
        isContract: Boolean(it.address.is_contract),
        name: it.address.name || null,
      });
    }
    const np = d.next_page_params;
    if (stop || !np) break;
    url = C.CHAIN.explorer + '/api/v2/tokens/' + token + '/holders?' +
      Object.entries(np).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  }

  /* 2. How much each one actually has, from the contract, in batches.

     A batch of twenty, not a hundred: the measurement showed that the
     public node accepts a packet of up to twenty-five calls, and at fifty
     answers with a single "429 Too Many Requests" for the whole packet.
     The first version did not notice this: the error arrived instead of
     the results, each one was silently skipped, and nine holders came out
     instead of one thousand one hundred and twenty.

     Hence the second rule as well: **failures are counted out loud**. A
     payout on an incomplete list means other people's shares computed off
     the wrong total. Better not to close an epoch than to close it wrong. */
  const out = [];
  let failed = 0;

  for (let i = 0; i < addrs.length; i += batch) {
    const slice = addrs.slice(i, i + batch);
    const req = slice.map((h, j) => ({
      jsonrpc: '2.0', id: i + j + 1, method: 'eth_call',
      params: [{ to: token, data: SEL.balanceOf + bare(h.address) }, block],
    }));

    let arr = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(RPC, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        }).then(r => r.json());
        arr = Array.isArray(res) ? res : [res];
        /* The node answers with one error for the whole packet, which
           means the packet did not go through as a whole, and that is not
           "part of the data" but nothing at all. */
        if (arr.length === slice.length) break;
        arr = [];
      } catch (_) { arr = []; }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }

    if (!arr.length) { failed += slice.length; continue; }

    const byId = new Map(arr.map(r => [r.id, r]));
    slice.forEach((h, j) => {
      const r = byId.get(i + j + 1);
      if (!r || r.error || !r.result) { failed++; return; }
      const raw = BigInt(r.result);
      const bal = Number(raw) / Math.pow(10, dec);
      /* The exact balance is kept next to the rounded one, as a string.

         The rounded one is for selection and reports: it is convenient to
         compare and to print. It must not be paid out by. An eighteen-digit
         balance does not fit into a double, and shares computed from it
         will drift apart from the total, while a payout has to add up to
         the last unit, or the final recipient comes up short. */
      if (bal > 0) out.push({ ...h, balance: bal, raw: raw.toString() });
    });

    /* A pause between packets: the node is free, and abusing it means
       getting refused exactly when the calculation is running. */
    if (i + batch < addrs.length) await new Promise(r => setTimeout(r, 120));
  }

  return {
    block: Number(BigInt(block)),
    decimals: dec,
    holders: out,
    listed: addrs.length,
    failed,
    /* Whether the snapshot is full. The crank must look at this before paying. */
    complete: failed === 0,
  };
}

/** The token's decimals: we ask the contract instead of guessing. */
export async function decimalsOf(token) {
  try {
    const r = await call(token, SEL.decimals);
    const n = Number(BigInt(r || '0x12'));
    return Number.isFinite(n) && n >= 0 && n <= 36 ? n : 18;
  } catch (_) { return 18; }
}

/** Supply from the contract. A constant in code will one day diverge from the chain. */
export async function supplyOf(token) {
  const [r, dec] = await Promise.all([call(token, SEL.totalSupply), decimalsOf(token)]);
  return Number(BigInt(r || '0x0')) / Math.pow(10, dec);
}

/* Addresses that hold the token but are not holders: the exchange, our own
   contracts and burn addresses. To pay the pool is to make a gift to the
   exchange, and the payout will report success while doing it. */
export const NOT_HOLDERS = [
  ADDR.launchFactory, ADDR.locker, ADDR.v3Factory, ADDR.positionManager,
  ADDR.swapRouter, ADDR.quoter, ADDR.weth,
];
