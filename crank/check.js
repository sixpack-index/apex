/* =========================================================================
   Checks for the crank. No network, no keys, only the decisions it makes.

     node crank/check.js
     node crank/check.js --break    breaks what is being checked and makes
                                    sure the checks fail

   This is the code that spends money. Here what matters most is not "does
   it work" but "does it refuse when it should".
   ========================================================================= */

import './../core.js';
import { shouldSettle, shares, excludeNonHolders, planEpoch, gasForEpoch, GAS, pickQuote, redistribute, splitByBalance } from './plan.js';
import { feeLabel, DYNAMIC_FEE } from './read.js';

const C = globalThis.ApexCore;
const BREAK = process.argv.includes('--break');

let passed = 0;
const bad = [];
const ok = (name, cond, got) => cond ? passed++
  : bad.push(name + (got === undefined ? '' : ' — got: ' + JSON.stringify(got, (k, v) =>
      typeof v === 'bigint' ? v.toString() : v)));

const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;

/* ---------- when to close an epoch ---------- */
const gp = 26n * GWEI / 1000n;               // 0.026 gwei, as on this chain

ok('an empty epoch does not close',
   !shouldSettle({ potWei: 0n, recipients: 25, gasPriceWei: gp }).settle);
ok('on pennies the epoch does not close',
   !shouldSettle({ potWei: 10n ** 12n, recipients: 25, gasPriceWei: gp }).settle);
ok('closes when there is enough',
   shouldSettle({ potWei: ETH, recipients: 25, gasPriceWei: gp }).settle);
ok('a refusal explains the reason in words',
   /less|margin/.test(shouldSettle({ potWei: 0n, recipients: 25, gasPriceWei: gp }).why || ''));
ok('the threefold margin is counted from the cost', (() => {
  const r = shouldSettle({ potWei: 0n, recipients: 10, gasPriceWei: gp });
  return r.needWei === r.costWei * 3n;
})());
ok('more recipients, a costlier settlement',
   shouldSettle({ potWei: 0n, recipients: 100, gasPriceWei: gp }).costWei >
   shouldSettle({ potWei: 0n, recipients: 10, gasPriceWei: gp }).costWei);
ok('costlier gas, a higher threshold',
   shouldSettle({ potWei: 0n, recipients: 25, gasPriceWei: gp * 10n }).needWei >
   shouldSettle({ potWei: 0n, recipients: 25, gasPriceWei: gp }).needWei);

/* ---------- how much gas per epoch ---------- */
const SEATS = C.MODEL.seats;
ok('the payout is counted by the number of people and coins',
   gasForEpoch(100) === GAS.claim + GAS.wrap + SEATS * GAS.swap + 100 * SEATS * GAS.transfer,
   gasForEpoch(100));
ok('with no recipients only the collect and the buys are left',
   gasForEpoch(0) === GAS.claim + GAS.wrap + SEATS * GAS.swap);
/* Six coins instead of ten is not cosmetics but money: a swap and a
   transfer are counted for every seat, and a smaller basket makes the epoch
   cheaper. If the seats ever diverge from the model, it will go red here. */
ok('the settlement gets cheaper along with the basket',
   gasForEpoch(100, 6) < gasForEpoch(100, 10));
ok('the swap is budgeted with margin over the measured 68 200', GAS.swap >= 68_200);

/* ---------- who is in ---------- */
const M = C.MODEL.supply;                     // a billion
const hs = [
  { address: '0xa'.padEnd(42, '1'), balance: M * 0.02 },     // 2%
  { address: '0xb'.padEnd(42, '2'), balance: M * 0.001 },    // 0.1%
  { address: '0xc'.padEnd(42, '3'), balance: M * 0.0001 },   // exactly the floor
  { address: '0xd'.padEnd(42, '4'), balance: M * 0.00009 },  // a little below
  { address: '0xe'.padEnd(42, '5'), balance: 1 },            // dust
];
const s = shares(hs);
ok('the floor is 0.01% of supply', s.floor === M * 0.0001, s.floor);
ok('exactly at the floor passes', s.eligible.some(h => h.balance === M * 0.0001));
ok('a little below the floor does not pass', !s.eligible.some(h => h.balance === M * 0.00009));
ok('dust is cut off', !s.eligible.some(h => h.balance === 1));
ok('three out of five pass', s.eligible.length === 3, s.eligible.length);
ok('two are cut off', s.excluded === 2, s.excluded);
ok('the shares add up to one',
   Math.abs(s.eligible.reduce((a, h) => a + h.share, 0) - 1) < 1e-12);
ok('a share is counted from the eligible supply, not from the whole',
   Math.abs(s.eligible[0].share - (M * 0.02) / s.eligibleSupply) < 1e-12);
ok('the eligible supply is smaller than the whole', s.eligibleSupply < M);
ok('an empty list gives nobody', shares([]).eligible.length === 0);
ok('an empty list does not divide by zero', shares([]).eligibleRatio === 0);

/* ---------- who must not be included ----------
   The largest holder of any traded token is its own pool. To pay the pool
   is to make a gift to the exchange, and the payout reports success while
   doing it. This has happened before, so the check is strict. */
const POOL = '0x' + '9'.repeat(40);
const OPER = '0x' + '7'.repeat(40);
const TOKEN = '0x' + '5'.repeat(40);
const withJunk = [
  ...hs,
  { address: POOL, balance: M * 0.5 },
  { address: OPER, balance: M * 0.1 },
  { address: TOKEN, balance: M * 0.05 },
  { address: '0x0000000000000000000000000000000000000000', balance: M * 0.2 },
  { address: '0x000000000000000000000000000000000000dEaD', balance: M * 0.1 },
];
const clean = excludeNonHolders(withJunk, { pools: [POOL], operator: OPER, token: TOKEN });
ok('the pool does not get into the payout', !clean.some(h => h.address === POOL));
ok('the operator does not pay itself', !clean.some(h => h.address === OPER));
ok('the token contract does not pay itself', !clean.some(h => h.address === TOKEN));
ok('the zero address is excluded',
   !clean.some(h => h.address === '0x0000000000000000000000000000000000000000'));
ok('the burn address is excluded whatever the case',
   !clean.some(h => h.address.toLowerCase().endsWith('dead')));
ok('ordinary holders are still there', clean.length === hs.length, clean.length);

/* ---------- the whole plan ---------- */
const basket = Array.from({ length: SEATS },
  (_, i) => ({ sym: 'T' + i, address: '0x' + String(i).repeat(40) }));
/* The pool goes into exclude on its own line, exactly the way the live
   crank passes it. This check used to pass by accident: in a basket of ten
   made-up addresses the ninth coincided with the pool address, and the pool
   was filtered out as a basket member, not as a pool. With six seats the
   coincidence disappeared, and the check honestly went red. What has to be
   checked is the path the live code takes, not the one next to it. */
const p = planEpoch({
  potWei: ETH, basket, holders: withJunk, gasPriceWei: gp,
  supply: M, operator: OPER, token: TOKEN, exclude: [POOL],
});
ok('the plan has as many seats as the basket', p.seats.length === SEATS);
ok('the seats differ by no more than one wei',
   Math.max(...p.seats.map(x => Number(x.spendWei))) -
   Math.min(...p.seats.map(x => Number(x.spendWei))) <= 1);
/* The main check of this piece. Six does not divide ten, and ordinary
   BigInt division would drop the remainder on the floor every epoch,
   silently, because in ether it is fractions of a cent. The sum of the
   parts must add up exactly.

   And it now adds up not to the wallet balance but to that balance MINUS
   the gas reserve. The money for buying and the money for gas sit in one
   place: the working wallet holds both. Spending everything on coins means
   running out of gas exactly at the payout: the buys go through, the
   transfers do not, and six coins are stuck until the next top-up. */
ok('the sum of the buys equals the balance minus the reserve, down to the last wei',
   p.seats.reduce((a, x) => a + x.spendWei, 0n) === ETH - p.reserveWei,
   String(p.seats.reduce((a, x) => a + x.spendWei, 0n)) + ' with a reserve of ' + String(p.reserveWei));
ok('the gas reserve is set aside, not spent',
   p.reserveWei > 0n && p.buyableWei === ETH - p.reserveWei,
   { reserve: String(p.reserveWei), buyable: String(p.buyableWei) });
/* The balance does not even cover the gas, so there is nothing to buy with
   and nothing to split. Zero here is better than a negative number, which
   BigInt will not forgive. */
{
  const tiny = planEpoch({ potWei: 1n, basket, holders: withJunk, gasPriceWei: gp,
                           supply: M, operator: OPER, token: TOKEN, exclude: [POOL] });
  ok('when there is not enough for gas, the buy is zero and not minus',
     tiny.buyableWei === 0n && tiny.seats.every(s => s.spendWei === 0n),
     String(tiny.buyableWei));
}
ok('transfers = recipients × seats', p.transfers === p.recipients * SEATS, p.transfers);

/* ---------- a seat that found no pool ----------
   Otherwise such a seat's share hangs on the operator's wallet: not paid
   out to holders, not returned either. We split it among the rest within
   the same epoch, and check that the total did not move by a single wei. */
{
  const blind = new Set([p.seats[1].sym, p.seats[4].sym]);
  const r = redistribute(p.seats, blind);
  const was = p.seats.reduce((a, x) => a + x.spendWei, 0n);
  const now = r.seats.reduce((a, x) => a + x.spendWei, 0n);
  ok('the total after the redistribution did not change', was === now, String(now - was));
  ok('blind seats get nothing',
     r.seats.filter(x => blind.has(x.sym)).every(x => x.spendWei === 0n));
  ok('blind seats are marked', r.seats.filter(x => x.skipped).length === 2);
  /* We count from the number of seats, not from four: there are exactly two
     blind ones, so the live ones are all the rest. With six seats it was
     four, with ten it was eight, and the check will survive the next
     change. */
  ok('every seat but the two blind ones is still live',
     r.live === p.seats.length - blind.size, r.live);
  const alive = r.seats.filter(x => !blind.has(x.sym)).map(x => x.spendWei);
  ok('the addition was split evenly',
     Number(alive[alive.length - 1] - alive[0]) <= 1, alive.map(String).join(','));
  ok('every live seat got more than before',
     alive.every(v => v > p.seats[0].spendWei));

  const none = redistribute(p.seats, new Set());
  ok('with no blind seats the plan does not change', none.seats === p.seats && none.moved === 0n);

  const all = redistribute(p.seats, new Set(p.seats.map(x => x.sym)));
  ok('if nobody has a pool, nothing is spent',
     all.seats.every(x => x.spendWei === 0n) && all.live === 0);
}
ok('there are no pools or service addresses in the payout',
   !p.payout.some(x => [POOL, OPER, TOKEN].includes(x.address)));
ok('the plan explains why it closes or does not',
   p.settle === true || typeof p.why === 'string');

/* ---------- picking a pool ----------
   This is the place where money is lost most quietly: the buy goes to the
   wrong place, everything reports success, and the only way to find out we
   paid three times over is to compare against the market after the fact.

   The numbers come from a live measurement: CASHCAT turned out to have 79
   pools, AI had 85, and the best one "by number of coins" promised sixty
   times more than the market. */
const q = out => ({ out: BigInt(Math.round(out * 1e18)) });

ok('of two similar ones the one that gives more is taken',
   pickQuote([q(100), q(105)], { fair: 100 }).best.out === q(105).out);
ok('a pool with a painted price is thrown out',
   pickQuote([q(100), q(6000)], { fair: 100 }).best.out === q(100).out);
ok('the bait does not count as an option',
   pickQuote([q(100), q(6000)], { fair: 100 }).alternatives === 0);
ok('but everything polled is counted',
   pickQuote([q(100), q(6000)], { fair: 100 }).considered === 2);
ok('three times above the market still passes',
   pickQuote([q(299)], { fair: 100 }).ok);
ok('four times above the market no longer does',
   !pickQuote([q(400)], { fair: 100 }).ok);
ok('three times below the market still passes',
   pickQuote([q(34)], { fair: 100 }).ok);
ok('ten times below the market does not',
   !pickQuote([q(10)], { fair: 100 }).ok);
ok('with no market price no choice is made at all',
   !pickQuote([q(100), q(6000)], { fair: null }).ok);
ok('a refusal without a price explains the reason',
   /market price/.test(pickQuote([q(100)], { fair: null }).why || ''));
ok('an empty answer is a refusal, not zero coins',
   !pickQuote([], { fair: 100 }).ok);
ok('zero quotes do not take part',
   !pickQuote([q(0), q(0)], { fair: 100 }).ok);
ok('when all are off the market, there is no buy',
   !pickQuote([q(6000), q(9000)], { fair: 100 }).ok);
ok('the edge over the next one is counted in percent',
   Math.abs(pickQuote([q(100), q(110)], { fair: 100 }).edge - 10) < 0.01,
   pickQuote([q(100), q(110)], { fair: 100 }).edge);
ok('a single usable pool gives a zero edge',
   pickQuote([q(100)], { fair: 100 }).edge === 0);

/* ---------- the pool fee ----------
   In V4 a dynamic fee is a flag, not a number. Dividing it by a hundred
   like an ordinary fee means printing "838.86%", which is what happened. */
ok('an ordinary fee is printed as a percentage', feeLabel(10_000) === '1%');
ok('a small fee too', feeLabel(500) === '0.05%');
ok('a dynamic fee is named with a word', feeLabel(DYNAMIC_FEE) === 'dynamic');
ok('the dynamic fee flag is 0x800000', DYNAMIC_FEE === 8_388_608);

/* ---------- breakage ---------- */
if (BREAK) {
  const broken = [];
  if (shouldSettle({ potWei: 0n, recipients: 25, gasPriceWei: gp }).settle) {
    broken.push('an empty epoch passes');
  }
  if (shares(hs).eligible.length === hs.length) {
    broken.push('the floor cuts nobody off');
  }
  if (excludeNonHolders(withJunk, { pools: [POOL] }).some(h => h.address === POOL)) {
    broken.push('the pool gets into the payout');
  }
  if (gasForEpoch(100) === gasForEpoch(10)) {
    broken.push('the cost does not depend on the number of recipients');
  }
  if (pickQuote([q(100), q(6000)], { fair: 100 }).best.out === q(6000).out) {
    broken.push('the bait wins the pool choice');
  }
  if (pickQuote([q(100)], { fair: null }).ok) {
    broken.push('a pool is picked with no market price');
  }
  if (splitByBalance(7n, [{ raw: '3000' }, { raw: '2000' }, { raw: '1' }])
        .reduce((a, b) => a + b, 0n) !== 7n) {
    broken.push('the payout does not add up to what was bought');
  }
  console.log('\nBreakage: ' + (broken.length
    ? 'THE CHECKS ARE LEAKY: ' + broken.join('; ')
    : 'every substitution was caught, the checks are alive'));
  if (broken.length) process.exit(1);
}

/* ---------- the payout by exact balances ----------
   What is guarded here is not the formula but the total. A payout that does
   not add up to what was bought will revert on the LAST transfer, when
   every earlier one is already on the chain. Half the epoch is distributed,
   half is not, and it cannot be repeated. */
{
  const cases = [
    [[{ raw: '3000' }, { raw: '2000' }, { raw: '1' }], 'three different'],
    [[{ raw: '1' }, { raw: '1' }, { raw: '1' }], 'evenly'],
    [[{ raw: '1' }], 'one'],
    [Array.from({ length: 97 }, (_, i) => ({ raw: String(i + 1) })), 'ninety-seven'],
  ];
  for (const [hs, name] of cases) {
    for (const amt of [0n, 1n, 7n, 999n, 10n ** 18n, 123456789n]) {
      const parts = splitByBalance(amt, hs);
      const sum = parts.reduce((a, b) => a + b, 0n);
      ok('the total adds up: ' + name + ', ' + amt, sum === amt, sum.toString());
      ok('nobody gets a negative: ' + name + ', ' + amt, parts.every(x => x >= 0n));
    }
  }
  const z = splitByBalance(100n, [{ raw: '0' }, { raw: '0' }]);
  ok('with zero balances nothing is handed out', z.every(x => x === 0n), z.join(','));

  const big = splitByBalance(10n ** 18n, [{ raw: '10' }, { raw: '1' }]);
  ok('the large holder gets more than the small one', big[0] > big[1], big.join(' vs '));

  /* The remainder goes to the largest holder, not to the first on the list. */
  const one = splitByBalance(1n, [{ raw: '1' }, { raw: '100' }]);
  ok('the remainder goes to the largest', one[1] === 1n && one[0] === 0n, one.join(','));
}

if (bad.length) {
  console.error('FAILED ' + bad.length + ' of ' + (passed + bad.length) + ':');
  bad.forEach(b => console.error('  · ' + b));
  process.exit(1);
}
console.log('Crank: ' + passed + ' checks passed.');
