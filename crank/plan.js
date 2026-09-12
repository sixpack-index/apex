/* =========================================================================
   What the crank is about to do, before it does it.

   There is no network here, no keys, no transactions: only rules and
   arithmetic. That is on purpose. A program that spends other people's
   money eight times a day must be able to show its decision before
   execution, and that decision must be checked by tests, not by watching
   what has already happened.

   The dry run comes from the same place: the same functions, the same
   result, only nothing gets signed.
   ========================================================================= */

import './../core.js';

const C = globalThis.ApexCore;

/* Gas spent per step. The numbers are not invented: the swap was measured
   by the quoter on a live pool (68 200), the rest are ordinary for these
   operations, taken with margin upward. If the chain starts charging more,
   the crank will notice by itself: it checks the estimate against the real
   price before every epoch. */
export const GAS = {
  claim: 150_000,     // take what has accrued off the hook
  wrap: 50_000,       // wrap ETH if it turns out to be needed
  /* Buying one seat. It used to be 120 000 "with margin over 68 200", and
     that was a measurement on V3. The August 29 measurement on V4 through
     UniversalRouter gave 121 669 gas on the live DOGO pool: the old number
     turned out to be BELOW the real spend, so the margin was negative. We
     take 180 000, one and a half times the real spend. */
  swap: 180_000,
  transfer: 45_000,   // one transfer to a recipient
};

/**
 * How much gas a full epoch will eat with this number of recipients.
 * The payout is transfers, and their count is people times coins.
 */
export function gasForEpoch(recipients, seats = C.MODEL.seats) {
  return GAS.claim + GAS.wrap + seats * GAS.swap + recipients * seats * GAS.transfer;
}

/**
 * Whether the epoch is worth closing at all.
 *
 * The rule is the one that was published: three hours is a floor, not a
 * length. The epoch closes only when what has accrued is enough to cover
 * the settlement with a margin. Without this rule, at the start, while
 * there is almost no trading, the crank would burn more on empty epochs
 * than it pays out.
 *
 * The margin is needed because the gas price changes between the decision
 * and the execution, and an epoch that breaks off in the middle of the
 * payout is the worst outcome there is.
 */
export function shouldSettle({ potWei, recipients, gasPriceWei, margin = 3 }) {
  const gas = BigInt(gasForEpoch(recipients));
  const cost = gas * BigInt(gasPriceWei);
  const need = cost * BigInt(margin);
  const enough = potWei >= need;
  return {
    settle: enough,
    costWei: cost,
    needWei: need,
    /* The reason is always in words: a silent refusal cannot be told apart
       from a breakage, and the crank refuses more often than it agrees. */
    why: enough
      ? null
      : 'collected less than the settlement costs with a margin of ×' + margin,
  };
}

/**
 * Who gets the dividend and in what share.
 *
 * Shares are computed off the **eligible supply**, the sum of the balances
 * of those who passed the floor, not off the whole supply. Otherwise part
 * of the basket would stay undistributed and would hang on the operator's
 * wallet.
 *
 * @param holders  [{ address, balance }] balances at the snapshot block
 * @param supply   the supply
 */
export function shares(holders, supply = C.MODEL.supply, floorRatio = 0.0001) {
  const floor = supply * floorRatio;
  const eligible = holders.filter(h => Number(h.balance) >= floor);
  const total = eligible.reduce((s, h) => s + Number(h.balance), 0);
  return {
    floor,
    eligible: eligible
      .map(h => ({ ...h, share: total > 0 ? Number(h.balance) / total : 0 }))
      .sort((a, b) => b.share - a.share),
    excluded: holders.length - eligible.length,
    eligibleSupply: total,
    /* The eligible supply's share of the whole: the very number that stands
       on the site in the "eligible supply" card. Computed here so that the
       site and the crank do not diverge. */
    eligibleRatio: supply > 0 ? total / supply : 0,
  };
}

/**
 * Who must not be included in the payout, even with a large balance.
 *
 * Pools, the distributor itself and burn addresses are not holders. To pay
 * the pool is to make a gift to the exchange, and the payout will report
 * success while doing it. This has happened on a previous project already,
 * so the exclusion list here is strict, not "where possible".
 */
export function excludeNonHolders(holders, { pools = [], operator = '', token = '', extra = [] } = {}) {
  const dead = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
  ]);
  const skip = new Set([
    ...pools.map(a => String(a).toLowerCase()),
    ...extra.map(a => String(a).toLowerCase()),
    ...(operator ? [operator.toLowerCase()] : []),
    ...(token ? [token.toLowerCase()] : []),
    ...dead,
  ]);
  return holders.filter(h => !skip.has(String(h.address).toLowerCase()));
}

/**
 * Picking a pool out of several quotes.
 *
 * It lives here rather than next to the network for exactly the same reason
 * the calculator's arithmetic moved here: a rule that cannot be run under a
 * test will one day turn out to be broken, and we will learn about it from
 * other people's money.
 *
 * The rule: first cut off everything far from the market price, then take
 * the best of what is left. In exactly that order. "Whoever gives more"
 * without the first step is an invitation for a pool with a painted price:
 * the measurement on August 26 found eighty-five pools for one token, and
 * the best one by that rule promised sixty times more coins than the market
 * is worth.
 *
 * @param list [{ out: BigInt, … }] what the pools answered
 * @param fair how many coins the market price gives for the same amount
 * @param band how many times over it is allowed to deviate either way
 */
export function pickQuote(list, { fair = null, band = 3 } = {}) {
  const alive = (list || []).filter(q => q && q.out > 0n);
  if (!alive.length) return { ok: false, why: 'not a single pool gave a quote' };
  if (!(fair > 0)) {
    /* With no reference point we refuse to choose. To silently take "the
       best" here is to take the bait: it is always the best. */
    return { ok: false, why: 'no market price, nothing to check the quote against' };
  }
  const near = alive.filter(q => {
    const n = Number(q.out) / 1e18;
    return n >= fair / band && n <= fair * band;
  });
  if (!near.length) return { ok: false, why: 'all pools are off the market price, nowhere to buy' };

  near.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  const best = near[0];
  return {
    ok: true,
    best,
    considered: alive.length,
    alternatives: near.length - 1,
    /* How much better the best option is than the second: that is the price
       of an error, had we chosen without looking. Visible in the dry run. */
    edge: near.length > 1 && near[1].out > 0n
      ? Number((best.out - near[1].out) * 10_000n / near[1].out) / 100
      : 0,
  };
}

/**
 * Split an amount in wei into n parts with no losses.
 *
 * The remainder is handed out one wei at a time to the top seats, by the
 * same rule as the weights in basis points (see weightsBps in the core).
 * The difference between the first and the last seat comes out as one wei:
 * a quantity that does not exist in human units, while the sum still adds
 * up exactly, and that can be checked by addition.
 */
export function splitWei(total, n) {
  const parts = BigInt(Math.max(1, Math.floor(n)));
  const base = total / parts;
  const rem = total - base * parts;        // BigInt does not know % for negatives
  return Array.from({ length: Number(parts) },
                    (_, i) => base + (BigInt(i) < rem ? 1n : 0n));
}

/**
 * Split what was bought between recipients by their real balances.
 *
 * Not by fractional shares: a share is a double, and balances are eighteen
 * digits long. Multiplying what was bought by such a share loses units, and
 * the losses pile up: on a thousand recipients the last one is short of what
 * was already handed out. The transaction reverts on the final transfer,
 * when every earlier one has already gone through. The worst outcome there
 * is: half the payout on the chain, the other half not.
 *
 * So integers instead: part = bought × balance / sum of balances, and the
 * remainder of the division is handed out one unit at a time, starting with
 * the largest. The total matches what was bought exactly, and a test checks
 * that.
 *
 * @param amount how many coins were bought, as an integer
 * @param holders recipients with a raw field, the exact balance as a string
 */
export function splitByBalance(amount, holders) {
  const total = holders.reduce((a, h) => a + BigInt(h.raw || 0), 0n);
  if (total === 0n || amount === 0n) return holders.map(() => 0n);

  const parts = holders.map(h => (amount * BigInt(h.raw || 0)) / total);
  let left = amount - parts.reduce((a, b) => a + b, 0n);

  /* The remainder is not small change to be neglected: neglecting it means
     leaving coins on the operator's wallet. There are not many of them, but
     they are other people's. */
  const order = holders
    .map((h, i) => [i, BigInt(h.raw || 0)])
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  for (let k = 0; left > 0n; k++, left--) parts[order[k % order.length][0]] += 1n;

  return parts;
}

/**
 * Redistribute the shares of seats that had no usable pool.
 *
 * A seat with no pool is not a small inconvenience. Its share of the epoch
 * would otherwise simply hang on the operator's wallet: not paid out to
 * holders, not returned, and the basket turns out not to be the one that
 * was promised.
 *
 * The answer: split the blind seats' share among the rest, within THE SAME
 * epoch. Carrying it into the next one was the second option and was
 * rejected, because it requires holding a remainder between runs, and the
 * money sits idle the whole time.
 *
 * The split uses the same splitWei: the total has to stay identical down to
 * the last wei, or the redistribution itself opens the hole it exists to
 * close.
 *
 * @param seats the plan's seats (each with spendWei)
 * @param blind the set of symbols with nowhere to buy
 */
export function redistribute(seats, blind) {
  const live = seats.filter(s => !blind.has(s.sym));
  const dead = seats.filter(s => blind.has(s.sym));
  if (!dead.length) return { seats, moved: 0n, live: live.length };
  if (!live.length) return { seats: seats.map(s => ({ ...s, spendWei: 0n })),
                             moved: 0n, live: 0 };

  const moved = dead.reduce((a, s) => a + s.spendWei, 0n);
  const extra = splitWei(moved, live.length);
  let k = 0;
  const out = seats.map(s => blind.has(s.sym)
    ? { ...s, spendWei: 0n, skipped: true }
    : { ...s, spendWei: s.spendWei + extra[k++] });
  return { seats: out, moved, live: live.length };
}

/**
 * The full plan for an epoch: what to buy, who gets how much.
 * Returns what the crank prints in a dry run and executes in a live one.
 */
export function planEpoch({ potWei, basket, holders, gasPriceWei, supply, operator, token,
                            exclude = [], reserveWei = null }) {
  const clean = excludeNonHolders(holders, {
    pools: basket.map(t => t.address), operator, token, extra: exclude,
  });
  const s = shares(clean, supply);
  const decision = shouldSettle({
    potWei, recipients: s.eligible.length, gasPriceWei,
  });

  /* The wedge is split between the seats evenly, "equal weight", as written
     in the rules. No weighting by market size.

     We divide with a remainder, not simply potWei / n. While there were ten
     seats this meant nothing; six does not divide ten, and integer BigInt
     division would silently drop the remainder on the floor every epoch.
     The sum of the parts must equal exactly what was collected, otherwise
     part of the epoch belongs to nobody, and that would only be found out
     by addition on the chain. */
  /* What we buy with is NOT everything sitting on the wallet.

     The money for buying and the money for gas are now the same money: the
     working wallet holds both. Spending the whole balance on coins means
     running out of gas exactly at the payout: the buys go through, the
     transfers do not, and six coins are stuck on the operator's wallet
     until the next top-up.

     So the gas spend is set aside BEFORE the split, not after. The reserve
     comes from outside, because the same shouldSettle computes it: two
     independent counts of one and the same thing would drift apart. */
  const reserve = reserveWei === null ? decision.needWei : BigInt(reserveWei);
  const buyable = potWei > reserve ? potWei - reserve : 0n;
  const spend = splitWei(buyable, basket.length || 1);

  return {
    ...decision,
    /* How much of the balance went into buying and how much was set aside
       for gas. This is the first thing to look at when an epoch closed
       smaller than expected. */
    buyableWei: buyable,
    reserveWei: reserve,
    /* The price in ether travels along with the seat in the basket: the
       crank uses it to filter out pools with a painted price when it goes
       for a quote. */
    seats: basket.map((t, i) => ({ sym: t.sym, address: t.address, spendWei: spend[i],
                           priceNative: t.priceNative ?? null,
                           pairId: t.pairId ?? null,
                           /* Pools that are paid in ether. Without them the
                              crank does not find a native-ether pool at all:
                              walking the chain runs into a node timeout. */
                           ethPairIds: t.ethPairIds ?? [] })),
    recipients: s.eligible.length,
    excluded: s.excluded + (holders.length - clean.length),
    eligibleSupply: s.eligibleSupply,
    eligibleRatio: s.eligibleRatio,
    floor: s.floor,
    transfers: s.eligible.length * basket.length,
    /* The share is for reports, the exact balance is for the payout.
       Computing a payment from a fractional share means losing units to
       rounding, and the sum of the payments has to match what was bought. */
    payout: s.eligible.map(h => ({ address: h.address, share: h.share, raw: h.raw ?? null })),
  };
}
