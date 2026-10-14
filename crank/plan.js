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
/* WHAT AN EPOCH COSTS ON SOLANA.
 *
 * On the previous chain the whole cost was one thing: gas, and it was
 * counted as units of gas times the gas price. On Solana these are two
 * different items, and the second of them is new, large and one-off.
 *
 * 1. THE SIGNATURE FEE. Five thousand lamports per signature, that is,
 *    0.000005 SOL. Transfers are put in batches, about ten transfers to a
 *    transaction: more does not fit into the limit on transaction size.
 *    Swaps go as separate transactions.
 *
 * 2. AN ACCOUNT FOR EVERY COIN FOR EVERY RECIPIENT. If there is no
 *    account, the sender creates it and pays for it, and that is not a fee
 *    but a deposit: it stays on the account and comes back TO THE HOLDER
 *    if he ever closes the account. For ten coins that is up to ten
 *    accounts per person, and the operator pays.
 *
 * The one-off part matters here: from the second epoch the accounts are
 * already there, and the cost falls almost to zero. So the number of
 * MISSING accounts is what goes into the calculation, not the number of
 * recipients times the number of seats. The crank has to count them before
 * the decision, otherwise the first epoch turns out several times more
 * expensive than expected.
 *
 * The deposit figure is live: the rent reduction comes in stages, and
 * before a live settlement it has to be taken with a
 * getMinimumBalanceForRentExemption call, not from here. Here it is for a
 * rough estimate and for the checks. */
/* THE NUMBERS ARE MEASURED, NOT TAKEN WITH A GUESSED MARGIN.
 *
 * Measured on October 14, 2026, live Solana, the coin BONK, transactions
 * assembled by the same code that assembles the crank's and shown to the
 * node:
 *
 *   transfers per transaction 5 → 529 bytes, 10 → 774, 15 → 1019,
 *                             18 → 1166, 20 → 1264. The ceiling is 1232,
 *                             that is, eighteen fit. We take fifteen: the
 *                             margin is needed because Token-2022 and some
 *                             account owners have one address more, and
 *                             hitting the ceiling in the middle of a
 *                             payout is worse than putting in three
 *                             transfers fewer.
 *   creating an account       14 818 compute units apiece
 *                             (six of them gave 88 908)
 *   a transfer                about 1 900 units
 *   the rent deposit          1 488 440 lamports, and the node confirmed
 *                             exactly the number that was sitting here as
 *                             a constant
 *
 * Measured separately, and not what we expected: a transfer to an account
 * that DOES NOT EXIST fails and drags the whole transaction down with it.
 * So the order "accounts first, transfers after" is not a preference but
 * an obligation, and in the crank it is exactly that.
 */
export const COST = {
  signature: 5_000n,            // lamports per signature
  transfersPerTx: 15,           // measured: eighteen fit, we take fifteen with margin
  priorityPerTx: 10_000n,       // the priority fee, at the upper bound of a quiet day
  rentPerAccount: 1_488_440n,   // the rent deposit for a coin account, confirmed by the node
};

/**
 * What an epoch will cost: fees plus deposits for the missing accounts.
 *
 * `missingAccounts` is counted from the chain before the decision. If it is
 * not passed, we count the worst case, an account for every coin for every
 * recipient: erring in that direction means not closing the epoch, erring
 * in the other means breaking off the payout in the middle, and that is
 * the worst outcome possible.
 */
export function costForEpoch(recipients, { seats = C.MODEL.seats, missingAccounts = null } = {}) {
  const n = Math.max(0, Math.floor(recipients));
  const txs = BigInt(seats)                                  // the swaps
            + BigInt(Math.ceil((n * seats) / COST.transfersPerTx))   // transfers in batches
            + 2n;                                            // taking the fee and preparation
  const fees = txs * (COST.signature + COST.priorityPerTx);
  const missing = missingAccounts === null ? n * seats : Math.max(0, Math.floor(missingAccounts));
  const rent = BigInt(missing) * COST.rentPerAccount;
  return { lamports: fees + rent, fees, rent, txs };
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
export function shouldSettle({ potLamports, recipients, missingAccounts = null,
                               operatorLamports = null, margin = 3 }) {
  const c = costForEpoch(recipients, { missingAccounts });

  /* TWO ITEMS, AND THE MARGIN APPLIES TO ONLY ONE OF THEM.
   *
   * At first I applied the threefold margin to the whole cost, the
   * deposits for the accounts included, and here is what came out: a
   * thousand holders would have had to accrue forty-five SOL, about five
   * thousand dollars, before the FIRST epoch closed. At a rate of 0.95%
   * that is half a million of volume in three hours. The first payout
   * would never have happened.
   *
   * The mistake is that this is different money. The signature fees repeat
   * every epoch and depend on the price of the queue, so they need a
   * margin: an epoch that breaks off in the middle of the payout is the
   * worst outcome there is. The deposits for the accounts are a one-off
   * investment by the operator: he pays them once, from the second epoch
   * the accounts are already there, and they come back to the holder, not
   * to him.
   *
   * So: the epoch closes when what has accrued is enough for the FEES with
   * a margin. The deposits are checked separately, against the balance on
   * the operator's wallet, and if there is nothing to pay them with, the
   * epoch does not close for a different reason: this is not "we collected
   * too little", this is "top up the wallet". */
  const need = c.fees * BigInt(margin);
  const enoughPot = potLamports >= need;
  const canAffordRent = operatorLamports === null || BigInt(operatorLamports) >= c.rent;

  let why = null;
  if (!enoughPot) {
    why = 'collected less than the settlement costs with a margin of ×' + margin;
  } else if (!canAffordRent) {
    why = 'the operator wallet cannot cover the accounts for the recipients: '
        + (Number(c.rent) / 1e9).toFixed(3) + ' SOL is needed, one-off, top up the wallet';
  }

  return {
    settle: enoughPot && canAffordRent,
    costLamports: c.lamports,
    feesLamports: c.fees,
    rentLamports: c.rent,
    needLamports: need,
    why,
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
    /* The eligible supply's share of the whole: the very number that
       stands on the site in the "eligible supply" card. Computed here so
       that the site and the crank do not diverge. */
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
  /* THE CASE IS NOT FOLDED, AND HERE THAT MATTERS.
   *
   * On the previous chain folding was right: EVM addresses are case
   * insensitive, and the same address travels in three spellings. On
   * Solana an address is base58 and the case carries meaning: two
   * DIFFERENT coins that differ only in case would become one.
   *
   * The two EVM burn addresses are gone too, the zero one and "dead".
   * Solana has no zero address, and burning is an instruction rather than
   * a transfer. Those two excluded nothing and only made the list look
   * complete. The real exclusions arrive from NOT_HOLDERS in read.js. */
  const skip = new Set([
    ...pools.map(a => String(a)),
    ...extra.map(a => String(a)),
    ...(operator ? [String(operator)] : []),
    ...(token ? [String(token)] : []),
  ]);
  return holders.filter(h => !skip.has(String(h.address)));
}

/**
 * Picking a pool out of several quotes.
 *
 * It lives here rather than next to the network for exactly the same
 * reason the calculator's arithmetic moved here: a rule that cannot be run
 * under a test will one day turn out to be broken, and we will learn about
 * it from other people's money.
 *
 * The rule: first cut off everything far from the market price, then take
 * the best of what is left. In exactly that order. "Whoever gives more"
 * without the first step is an invitation for a pool with a painted price:
 * the measurement on August 26 found eighty-five pools for one token, and
 * the best one by that rule promised sixty times more coins than the
 * market is worth.
 *
 * WHAT THE MOVE TO SOLANA CHANGED. We no longer sweep the pools: the
 * aggregator picks the route, and it picks better than our own sweep. But
 * THE CHECK AGAINST THE MARKET did not become redundant because of that,
 * it became the only check on somebody else's work. The aggregator can
 * take a buy through a pool with a painted price exactly as our own sweep
 * would, and it will report success while doing it.
 *
 * So the function stayed, and it is now called with one quote: the one the
 * aggregator returned. There is nothing to choose from, there is something
 * to check.
 *
 * The decimals arrived as a parameter, and that is not cosmetics. On the
 * previous chain every token had eighteen decimals, and the divisor was
 * baked in as a constant. On Solana they run from zero to nine for
 * different coins, and a baked-in divisor would mean that the check
 * against the market is wrong by a factor of a thousand for a coin with
 * six decimals, that is, it does not work but looks like it works.
 *
 * @param list [{ out: BigInt, … }] what the pools or the aggregator answered
 * @param fair how many coins the market price gives for the same amount
 * @param band how many times over it is allowed to deviate in either direction
 * @param unit how many minimal units there are in one coin (10 to the power
 *             of the decimals); without it the check computes something
 *             other than what it compares
 */
export function pickQuote(list, { fair = null, band = 3, unit = null } = {}) {
  if (!(unit > 0)) {
    return { ok: false, why: 'the decimals of the coin are not set, there is nothing to check against' };
  }
  const alive = (list || []).filter(q => q && q.out > 0n);
  if (!alive.length) return { ok: false, why: 'not one pool gave a quote' };
  if (!(fair > 0)) {
    /* Without a point of reference we refuse to choose. To silently take
       "the best" here is to take the bait: it is always the best. */
    return { ok: false, why: 'no market price, there is nothing to check the quote against' };
  }
  const near = alive.filter(q => {
    const n = Number(q.out) / unit;
    return n >= fair / band && n <= fair * band;
  });
  if (!near.length) return { ok: false, why: 'all the pools are off the market price, nowhere to buy' };

  near.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  const best = near[0];
  return {
    ok: true,
    best,
    considered: alive.length,
    alternatives: near.length - 1,
    /* How much better the best option is than the second: that is the
       price of the mistake, had we chosen without looking. Visible in a dry run. */
    edge: near.length > 1 && near[1].out > 0n
      ? Number((best.out - near[1].out) * 10_000n / near[1].out) / 100
      : 0,
  };
}

/**
 * Split a sum in wei into n parts without losses.
 *
 * The remainder is handed out one wei at a time to the top seats, by the
 * same rule as the weights in basis points (see weightsBps in the core).
 * The difference between the first and the last seat comes out as one wei:
 * a quantity that does not exist in human units, while the sum still adds
 * up exactly, and that can be checked by addition.
 */
export function splitLamports(total, n) {
  const parts = BigInt(Math.max(1, Math.floor(n)));
  const base = total / parts;
  const rem = total - base * parts;        // BigInt has no % for negatives
  return Array.from({ length: Number(parts) },
                    (_, i) => base + (BigInt(i) < rem ? 1n : 0n));
}

/**
 * Split what was bought between the recipients by their real balances.
 *
 * Not by fractional shares: a share is a double, and the balances are
 * eighteen digits long. Multiplying what was bought by such a share loses
 * units, and the losses pile up: with a thousand recipients the last one
 * comes up short of what was handed out earlier. The transaction reverts
 * on the last transfer, when all the previous ones have already gone
 * through. The worst outcome possible: half the payout in the chain, the
 * other half not.
 *
 * So in whole numbers: the share is what was bought × the balance / the sum
 * of the balances, and the remainder of the division is handed out one unit
 * at a time, starting with the largest. The sum adds up with what was
 * bought exactly, and that is checked by a test.
 *
 * @param amount how many coins were bought, as a whole number
 * @param holders the recipients, with a raw field, the exact balance as a string
 */
export function splitByBalance(amount, holders) {
  const total = holders.reduce((a, h) => a + BigInt(h.raw || 0), 0n);
  if (total === 0n || amount === 0n) return holders.map(() => 0n);

  const parts = holders.map(h => (amount * BigInt(h.raw || 0)) / total);
  let left = amount - parts.reduce((a, b) => a + b, 0n);

  /* The remainder is not small change that can be neglected: to neglect it
     is to leave coins on the operator's wallet. There are not many, but
     they are somebody else's. */
  const order = holders
    .map((h, i) => [i, BigInt(h.raw || 0)])
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  for (let k = 0; left > 0n; k++, left--) parts[order[k % order.length][0]] += 1n;

  return parts;
}

/**
 * Redistribute the shares of the seats that found no usable pool.
 *
 * A seat without a pool is not a minor annoyance. Otherwise its share of
 * the epoch simply hangs on the operator's wallet: not handed to holders,
 * not returned, and the basket turns out in fact not to be the one that
 * was promised.
 *
 * The solution: we split the share of the blind seats between the others
 * in THE SAME epoch. Carrying it into the next one was the second option
 * and was rejected: it requires keeping a remainder between runs, and the
 * money sits idle all that time.
 *
 * We split with the same splitLamports: the sum has to stay the same down
 * to the last lamport, otherwise the redistribution itself creates the
 * hole it is being done to close.
 *
 * @param seats the seats of the plan (each with its spendLamports)
 * @param blind the set of symbols with nowhere to buy
 */
export function redistribute(seats, blind) {
  const live = seats.filter(s => !blind.has(s.sym));
  const dead = seats.filter(s => blind.has(s.sym));
  if (!dead.length) return { seats, moved: 0n, live: live.length };
  if (!live.length) return { seats: seats.map(s => ({ ...s, spendLamports: 0n })),
                             moved: 0n, live: 0 };

  const moved = dead.reduce((a, s) => a + s.spendLamports, 0n);
  const extra = splitLamports(moved, live.length);
  let k = 0;
  const out = seats.map(s => blind.has(s.sym)
    ? { ...s, spendLamports: 0n, skipped: true }
    : { ...s, spendLamports: s.spendLamports + extra[k++] });
  return { seats: out, moved, live: live.length };
}

/**
 * The full plan of an epoch: what to buy and who gets how much.
 * Returns what the crank prints in a dry run and executes in a live one.
 */
export function planEpoch({ potLamports, basket, holders, supply, operator, token,
                            missingAccounts = null, exclude = [], reserveLamports = null }) {
  const clean = excludeNonHolders(holders, {
    pools: basket.map(t => t.address), operator, token, extra: exclude,
  });
  const s = shares(clean, supply);
  /* THE OPERATOR'S BALANCE IS PASSED IN, AND WITHOUT IT THE CHECK DID
   * NOTHING.
   *
   * `shouldSettle` can refuse separately because there is not enough to
   * pay the rent deposits for the token accounts, and its comment
   * promises exactly that in words. But that check only runs when it is
   * given `operatorLamports`, and `planEpoch` did not pass it. The crank
   * never calls `shouldSettle` directly: it calls `planEpoch`.
   *
   * So the promise held only in the suites, where the argument was
   * passed by hand. In production `canAffordRent` was always true, the
   * epoch closed, and the shortfall would have been discovered in the
   * MIDDLE of the payout, which is the very thing this refusal exists to
   * avoid.
   *
   * It is the same wallet here: in the crank `potLamports` is the balance
   * on the working wallet, and both the buying and the paying come out of
   * it. */
  const decision = shouldSettle({
    potLamports, recipients: s.eligible.length, missingAccounts,
    operatorLamports: potLamports,
  });

  /* The pot is split between the seats in equal parts, "equal weight", as
     the rules say. No weighting by the size of the market.

     We divide with the remainder, not just potLamports / n. While there were
     ten seats it meant nothing; six does not divide into ten, and BigInt
     integer division would quietly drop the remainder on the floor every
     epoch. The sum of the shares has to equal exactly what was collected,
     otherwise part of the epoch belongs to nobody, and that is discovered
     only by adding things up on the chain. */
  /* What we buy with is NOT everything that lies on the wallet.

     The money for the buys and the money for the settlement are now the
     same money: the working wallet holds both. To spend the whole balance
     on coins is to be left without lamports exactly at the payout: the
     buys would go through and the transfers would not, and six coins would
     be stuck on the operator's wallet until the next top-up.

     So the settlement cost is set aside BEFORE the division, not after. The
     reserve comes from outside, because the same shouldSettle computes it:
     two independent counts of one and the same thing would diverge. */
  const reserve = reserveLamports === null ? decision.needLamports : BigInt(reserveLamports);
  const buyable = potLamports > reserve ? potLamports - reserve : 0n;
  const spend = splitLamports(buyable, basket.length || 1);

  return {
    ...decision,
    /* How much of the balance went into the buys and how much was set
       aside for gas. This is the first thing anyone looks at when an epoch
       closed smaller than expected. */
    buyableLamports: buyable,
    reserveHeld: reserve,
    /* The native price travels with the seat in the basket: by it the
       crank cuts off pools with a painted price when it goes for a quote. */
    seats: basket.map((t, i) => ({ sym: t.sym, address: t.address, spendLamports: spend[i],
                           priceNative: t.priceNative ?? null,
                           pairId: t.pairId ?? null,
                           /* The decimals and the program of the coin
                              arrive together with the ten. The crank needs
                              them for the transfer, and it used to ask the
                              node for them with one request per seat. */
                           decimals: t.decimals ?? null,
                           program: t.program ?? null })),
    recipients: s.eligible.length,
    excluded: s.excluded + (holders.length - clean.length),
    eligibleSupply: s.eligibleSupply,
    eligibleRatio: s.eligibleRatio,
    floor: s.floor,
    transfers: s.eligible.length * basket.length,
    /* The share is for the reports, the exact balance is for the payout.
       Computing a payout from a fractional share means losing units to
       rounding, and the sum of the payouts has to add up with what was
       bought. */
    payout: s.eligible.map(h => ({ address: h.address, share: h.share, raw: h.raw ?? null })),
  };
}
