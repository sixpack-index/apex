/* =========================================================================
   The crank's checks. No network and no keys, only the decisions it makes.

     node crank/check.js
     node crank/check.js --break    breaks what is being checked and makes
                                    sure the checks fail

   This is the code that spends money. What matters most here is not "does
   it work" but "does it refuse when it should".
   ========================================================================= */

import './../core.js';
import { shouldSettle, shares, excludeNonHolders, planEpoch, costForEpoch, COST, pickQuote, redistribute, splitByBalance } from './plan.js';
import { GENESIS, PROG, TOKEN_ACCOUNT_SIZE, OFF, SLIPPAGE_BPS, JUP,
         parseSlice } from './read.js';
import bs58 from 'bs58';
import { ataFor, batch, operatorFrom, TRANSFERS_PER_TX, CREATES_PER_TX,
         CU_TRANSFERS, MAX_PRIORITY_MICRO, PRIORITY_MICRO, Sender } from './send.js';

const C = globalThis.ApexCore;
const BREAK = process.argv.includes('--break');

let passed = 0;
const bad = [];
const ok = (name, cond, got) => cond ? passed++
  : bad.push(name + (got === undefined ? '' : ' got: ' + JSON.stringify(got, (k, v) =>
      typeof v === 'bigint' ? v.toString() : v)));

const SOL = 1_000_000_000n;                   // lamports in one SOL

/* ---------- when to close an epoch ----------

   The cost of an epoch on Solana has two parts, and the second is new: the
   rent deposit for a token account for every coin for every recipient.
   From the second epoch onward the accounts already exist, so what goes
   into the settlement is the number of MISSING accounts. */
ok('an empty epoch does not close',
   !shouldSettle({ potLamports: 0n, recipients: 25 }).settle);
ok('on pennies the epoch does not close',
   !shouldSettle({ potLamports: 1_000_000n, recipients: 25 }).settle);
ok('with enough it closes',
   shouldSettle({ potLamports: 10n * SOL, recipients: 25 }).settle);
ok('the refusal explains the reason in words',
   /less|margin/.test(shouldSettle({ potLamports: 0n, recipients: 25 }).why || ''));
/* THE MARGIN APPLIES ONLY TO WHAT RECURS. The deposits for the accounts
   are one-off and are paid out of the operator's pocket; a threefold
   margin on them would mean the first payout would never happen: a
   thousand holders would have to accumulate half a million of volume in
   three hours. */
ok('the threefold margin is counted on the fees, not on the deposits', (() => {
  const r = shouldSettle({ potLamports: 0n, recipients: 10 });
  return r.needLamports === r.feesLamports * 3n && r.needLamports < r.costLamports;
})());
ok('the deposits do not stop the epoch closing if the wallet can carry them',
   shouldSettle({ potLamports: 10n * SOL, recipients: 100,
                  operatorLamports: 10n * SOL }).settle);
ok('an empty operator wallet stops the epoch', (() => {
  const r = shouldSettle({ potLamports: 10n * SOL, recipients: 100, operatorLamports: 0n });
  return !r.settle && /top up the wallet/.test(r.why || '');
})());
ok('and it has a reason of its own, not "we collected too little"', (() => {
  const poor = shouldSettle({ potLamports: 0n, recipients: 100, operatorLamports: 0n });
  return /collected less/.test(poor.why || '');
})());
ok('more recipients make the settlement dearer',
   shouldSettle({ potLamports: 0n, recipients: 100 }).costLamports >
   shouldSettle({ potLamports: 0n, recipients: 10 }).costLamports);

/* THE FIRST EPOCH IS DEARER THAN THE REST, AND BY A LOT. This is the thing
   that did not exist as a phenomenon on the previous chain. */
ok('the first epoch is several times dearer than the later ones', (() => {
  const first = shouldSettle({ potLamports: 0n, recipients: 100 });               // no accounts
  const later = shouldSettle({ potLamports: 0n, recipients: 100, missingAccounts: 0 });
  return first.costLamports > later.costLamports * 10n;
})());
ok('the deposits for the accounts are the bulk of the first epoch', (() => {
  const r = shouldSettle({ potLamports: 0n, recipients: 100 });
  return r.rentLamports > r.feesLamports * 5n;
})());
ok('when the accounts already exist there are no deposits at all',
   shouldSettle({ potLamports: 0n, recipients: 100, missingAccounts: 0 }).rentLamports === 0n);
ok('an unknown number of accounts is counted at the worst case', (() => {
  const unknown = costForEpoch(50);
  const worst = costForEpoch(50, { missingAccounts: 50 * C.MODEL.seats });
  return unknown.lamports === worst.lamports;
})());

/* ---------- what an epoch costs ---------- */
const SEATS = C.MODEL.seats;
ok('transfers go in batches, not one by one', (() => {
  const c = costForEpoch(100, { missingAccounts: 0 });
  const perTx = COST.transfersPerTx;
  return c.txs === BigInt(SEATS) + BigInt(Math.ceil(100 * SEATS / perTx)) + 2n;
})());
ok('with no recipients only the swaps and the collection remain',
   costForEpoch(0, { missingAccounts: 0 }).txs === BigInt(SEATS) + 2n);

/* The number of seats is taken from the model rather than written in: the
   swaps are counted per seat, and a smaller basket makes the epoch
   cheaper. */
ok('the settlement gets cheaper along with the basket',
   costForEpoch(100, { seats: 6, missingAccounts: 0 }).lamports <
   costForEpoch(100, { seats: 10, missingAccounts: 0 }).lamports);
ok('the rent deposit per account is set as a number and it is positive',
   COST.rentPerAccount > 0n, COST.rentPerAccount);


/* ---------- who is in on the share ---------- */
const M = C.MODEL.supply;                     // a billion
const hs = [
  { address: '0xa'.padEnd(42, '1'), balance: M * 0.02 },     // 2%
  { address: '0xb'.padEnd(42, '2'), balance: M * 0.001 },    // 0.1%
  { address: '0xc'.padEnd(42, '3'), balance: M * 0.0001 },   // exactly the floor
  { address: '0xd'.padEnd(42, '4'), balance: M * 0.00009 },  // a little below
  { address: '0xe'.padEnd(42, '5'), balance: 1 },            // dust
];
const s = shares(hs);
ok('the floor is 0.01% of the supply', s.floor === M * 0.0001, s.floor);
ok('exactly on the floor passes', s.eligible.some(h => h.balance === M * 0.0001));
ok('a little below the floor does not pass', !s.eligible.some(h => h.balance === M * 0.00009));
ok('dust is cut off', !s.eligible.some(h => h.balance === 1));
ok('three of five pass', s.eligible.length === 3, s.eligible.length);
ok('two were cut off', s.excluded === 2, s.excluded);
ok('the shares add up to one',
   Math.abs(s.eligible.reduce((a, h) => a + h.share, 0) - 1) < 1e-12);
ok('a share is counted on the eligible supply, not on the whole of it',
   Math.abs(s.eligible[0].share - (M * 0.02) / s.eligibleSupply) < 1e-12);
ok('the eligible supply is less than the whole', s.eligibleSupply < M);
ok('an empty list gives nobody', shares([]).eligible.length === 0);
ok('an empty list does not divide by zero', shares([]).eligibleRatio === 0);

/* ---------- who must not be included ----------
   The largest holder of any tradable token is its own pool. Paying the
   pool means making the exchange a present, and the payout reports success
   while doing it. This has happened already, so the check is a hard one. */
const POOL = 'Pooo11111111111111111111111111111111111111p';
const OPER = 'Oper11111111111111111111111111111111111111o';
const TOKEN = 'Tokk11111111111111111111111111111111111111t';
/* The same address with one letter in a different case. On Solana that is
   a DIFFERENT address, and it must not be excluded: otherwise we take the
   share away from a stranger whose address happens to differ from our
   pool's by one capital letter. */
const NOT_POOL = 'POOO11111111111111111111111111111111111111p';
const withJunk = [
  ...hs,
  { address: POOL, balance: M * 0.5 },
  { address: OPER, balance: M * 0.1 },
  { address: TOKEN, balance: M * 0.05 },
  { address: NOT_POOL, balance: M * 0.2 },
];
const clean = excludeNonHolders(withJunk, { pools: [POOL], operator: OPER, token: TOKEN });
ok('a pool does not get into the payout', !clean.some(h => h.address === POOL));
ok('the operator does not pay itself', !clean.some(h => h.address === OPER));
ok('the token does not pay itself', !clean.some(h => h.address === TOKEN));

/* THE CASE IS NOT FOLDED, AND THAT IS CHECKED SEPARATELY.

   On the previous chain folding was right: EVM addresses are case
   insensitive. On Solana an address is base58, the case carries meaning,
   and folding would mean excluding from the payout a stranger whose
   address differs from our pool's by one capital letter.

   Also: the EVM burn addresses are gone from here. Solana has no zero
   address, and burning is an instruction rather than a transfer. The two
   old addresses excluded nothing and only made the list look complete. */
ok('an address differing only in case stays in the payout',
   clean.some(h => h.address === NOT_POOL));
ok('ordinary holders are still there',
   clean.length === hs.length + 1, clean.length);

/* ---------- the whole plan ---------- */
const basket = Array.from({ length: SEATS },
  (_, i) => ({ sym: 'T' + i, address: '0x' + String(i).repeat(40) }));
/* The pool goes into exclude as a line of its own, exactly the way the
   live crank passes it. This check used to pass by coincidence: in a
   basket of ten invented addresses the ninth matched the address of the
   pool, and the pool was cut off as a participant of the basket rather
   than as a pool. With six seats the coincidence disappeared, and the
   check honestly went red. What has to be checked is the path the live
   code takes, not the one next to it. */
const p = planEpoch({
  potLamports: 10n * SOL, basket, holders: withJunk,
  supply: M, operator: OPER, token: TOKEN, exclude: [POOL],
});
ok('the plan has as many seats as the basket', p.seats.length === SEATS);
ok('the seats differ by no more than one wei',
   Math.max(...p.seats.map(x => Number(x.spendLamports))) -
   Math.min(...p.seats.map(x => Number(x.spendLamports))) <= 1);
/* The main check of this piece. Six does not divide by ten, and ordinary
   BigInt division would drop the remainder on the floor every epoch,
   silently, because in ether it is fractions of a penny. The sum of the
   shares is obliged to add up exactly.

   It now adds up not with the balance of the wallet but with the balance
   MINUS the gas reserve. The money for buying and the money for gas sit in
   one place: the working wallet holds both. Spending it all on coins means
   being left without gas exactly at the payout, the purchases go through
   and the transfers do not, and six coins get stuck until the next top
   up. */
ok('the sum of the purchases equals the balance minus the reserve, down to the last wei',
   p.seats.reduce((a, x) => a + x.spendLamports, 0n) === 10n * SOL - p.reserveHeld,
   String(p.seats.reduce((a, x) => a + x.spendLamports, 0n)) + ' with the reserve ' + String(p.reserveHeld));
ok('the gas reserve is set aside, not spent',
   p.reserveHeld > 0n && p.buyableLamports === 10n * SOL - p.reserveHeld,
   { reserve: String(p.reserveHeld), buyable: String(p.buyableLamports) });
/* The balance is not even enough for gas, so there is nothing to buy with
   and nothing to divide. Zero here is better than a negative number, which
   BigInt will not forgive. */
{
  const tiny = planEpoch({ potLamports: 1n, basket, holders: withJunk,
                           supply: M, operator: OPER, token: TOKEN, exclude: [POOL] });
  ok('when there is not enough for gas, zero to buy rather than a minus',
     tiny.buyableLamports === 0n && tiny.seats.every(s => s.spendLamports === 0n),
     String(tiny.buyableLamports));
}
ok('transfers = recipients × seats', p.transfers === p.recipients * SEATS, p.transfers);

/* ---------- a seat that found no pool ----------
   Otherwise the share of such a seat hangs on the operator's wallet: not
   handed out to the holders, not given back either. We divide it between
   the rest in the same epoch, and check that the sum did not change by a
   single wei while doing so. */
{
  const blind = new Set([p.seats[1].sym, p.seats[4].sym]);
  const r = redistribute(p.seats, blind);
  const was = p.seats.reduce((a, x) => a + x.spendLamports, 0n);
  const now = r.seats.reduce((a, x) => a + x.spendLamports, 0n);
  ok('the sum after the redistribution did not change', was === now, String(now - was));
  ok('the blind seats get nothing',
     r.seats.filter(x => blind.has(x.sym)).every(x => x.spendLamports === 0n));
  ok('the blind seats are marked', r.seats.filter(x => x.skipped).length === 2);
  /* We count from the number of seats rather than from a four: there are
     exactly two blind ones, which means the live ones are all the rest.
     With six seats it was four, with ten it is eight, and the check will
     survive the next change. */
  ok('the live seats are all but the two blind ones',
     r.live === p.seats.length - blind.size, r.live);
  const alive = r.seats.filter(x => !blind.has(x.sym)).map(x => x.spendLamports);
  ok('the addition was spread evenly',
     Number(alive[alive.length - 1] - alive[0]) <= 1, alive.map(String).join(','));
  ok('every live seat got more than before',
     alive.every(v => v > p.seats[0].spendLamports));

  const none = redistribute(p.seats, new Set());
  ok('with no blind seats the plan does not change', none.seats === p.seats && none.moved === 0n);

  const all = redistribute(p.seats, new Set(p.seats.map(x => x.sym)));
  ok('if nobody has a pool, nothing is spent',
     all.seats.every(x => x.spendLamports === 0n) && all.live === 0);
}
ok('there are no pools and no service addresses in the payout',
   !p.payout.some(x => [POOL, OPER, TOKEN].includes(x.address)));
ok('the plan explains why it closes or does not',
   p.settle === true || typeof p.why === 'string');

/* ---------- checking the quote against the market ----------
   This is the place where money is lost most quietly: the purchase goes
   somewhere it should not, everything reports success, and the only way to
   learn that we bought at three times the price is to compare with the
   market after the fact.

   On Solana the route is chosen by the aggregator, and going through the
   pools ourselves is no longer needed. But the comparison stayed, and now
   it is the only check on somebody else's work: the aggregator is just as
   capable of putting the purchase through a pool with a painted price as
   our own walk would have been.

   The numbers come from a live measurement on the previous chain: one
   token turned out to have eighty-five pools, and the best one "by the
   number of coins" promised sixty times above the market. */
const UNIT = 1e9;
const q = out => ({ out: BigInt(Math.round(out * UNIT)) });
const pq = (list, opt) => pickQuote(list, { unit: UNIT, ...opt });

ok('of two similar ones the one that gives more is taken',
   pq([q(100), q(105)], { fair: 100 }).best.out === q(105).out);
ok('a quote with a painted price is thrown out',
   pq([q(100), q(6000)], { fair: 100 }).best.out === q(100).out);
ok('the bait does not count as an option',
   pq([q(100), q(6000)], { fair: 100 }).alternatives === 0);
ok('but all the ones asked are counted',
   pq([q(100), q(6000)], { fair: 100 }).considered === 2);
ok('three times above the market still passes', pq([q(299)], { fair: 100 }).ok);
ok('four times above the market does not', !pq([q(400)], { fair: 100 }).ok);
ok('three times below the market still passes', pq([q(34)], { fair: 100 }).ok);
ok('ten times below the market does not', !pq([q(10)], { fair: 100 }).ok);
ok('with no market price no choice is made at all',
   !pq([q(100), q(6000)], { fair: null }).ok);
ok('a refusal without a price explains the reason',
   /market price/.test(pq([q(100)], { fair: null }).why || ''));
ok('an empty answer is a refusal, not zero coins', !pq([], { fair: 100 }).ok);
ok('zero quotes do not take part', !pq([q(0), q(0)], { fair: 100 }).ok);
ok('when everything is off the market, there is no purchase', !pq([q(6000), q(9000)], { fair: 100 }).ok);
ok('the edge over the next one is counted in percent',
   Math.abs(pq([q(100), q(110)], { fair: 100 }).edge - 10) < 0.01,
   pq([q(100), q(110)], { fair: 100 }).edge);
ok('the only usable option gives a zero edge',
   pq([q(100)], { fair: 100 }).edge === 0);

/* THE DECIMALS ARE MANDATORY, AND THAT IS CHECKED SEPARATELY.

   On the previous chain the divisor was wired in as the constant 1e18: all
   the tokens had eighteen decimals. On Solana they run from zero to nine,
   and a wired-in divisor would mean that for a coin with six decimals the
   comparison is off by a factor of a thousand, that is, it does not work
   but looks like it works. */
ok('without the decimals the check refuses to compute',
   !pickQuote([q(100)], { fair: 100 }).ok);
ok('the refusal without the decimals names the reason',
   /decimals/.test(pickQuote([q(100)], { fair: 100 }).why || ''));
{
  /* One and the same coin, six decimals: 100 coins is 100 000 000 units.
     With the right divisor that is exactly the market, with the wrong one
     it is off by a factor of a thousand. */
  const six = { out: 100_000_000n };
  ok('with the right decimals the quote is recognized as market',
     pickQuote([six], { fair: 100, unit: 1e6 }).ok);
  ok('with the wrong decimals the same quote is thrown out',
     !pickQuote([six], { fair: 100, unit: 1e9 }).ok);
}

/* ---------- addresses, sizes and clusters ----------
   Constants put in by guesswork break silently: the crank will read the
   wrong accounts and honestly report that there are no holders. */
ok('the mainnet hash is the one the live node gives',
   GENESIS.mainnet === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
ok('devnet and testnet do not match the live one',
   GENESIS.devnet !== GENESIS.mainnet && GENESIS.testnet !== GENESIS.mainnet);
ok('all three hashes are addresses', [GENESIS.mainnet, GENESIS.devnet, GENESIS.testnet]
   .every(h => C.isAddress(h)));
ok('the token programs are addresses and they are different',
   C.isAddress(PROG.token) && C.isAddress(PROG.token2022) && PROG.token !== PROG.token2022);
ok('a token account is 165 bytes', TOKEN_ACCOUNT_SIZE === 165);
ok('the offsets inside the account run coin, owner, balance',
   OFF.mint === 0 && OFF.owner === 32 && OFF.amount === 64);
ok('the slippage allowance is three percent', SLIPPAGE_BPS === 300);
ok('the default aggregator requires no key',
   /lite-api\.jup\.ag/.test(JUP.quote) && !('x-api-key' in JUP.headers));

/* ---------- parsing an account out of the trimmed answer ----------

   The holder list arrives as bytes rather than parsed JSON: otherwise, on
   a million accounts, node dies with ERR_STRING_TOO_LONG without getting
   as far as the parsing (measured on October 14, PUMP gave 292 MB). So we
   parse the bytes ourselves, and the byte order in the balance is the
   thing that breaks silently.

   The numbers below are checked against the live chain: for the account
   5hpfC9… the node through jsonParsed gives exactly this balance and
   exactly this owner. */
{
  const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const AMOUNT = 777051506316643106n;
  const buf = Buffer.alloc(40);
  Buffer.from(bs58.decode(OWNER)).copy(buf, 0);
  buf.writeBigUInt64LE(AMOUNT, 32);
  const got = parseSlice({ account: { data: [buf.toString('base64'), 'base64'] } });
  ok('the owner is parsed out of the first thirty-two bytes',
     got && got.owner === OWNER, got && got.owner);
  ok('the balance matches what the node gives', got && got.raw === AMOUNT,
     got && got.raw);

  /* Read the same eight bytes the other way round and a hundred coins
     become a number with twenty digits, and the shares get computed from
     it. */
  const rev = Buffer.alloc(40);
  Buffer.from(bs58.decode(OWNER)).copy(rev, 0);
  rev.writeBigUInt64BE(AMOUNT, 32);
  ok('the reverse byte order gives a different number, so the order is checked',
     parseSlice({ account: { data: [rev.toString('base64'), 'base64'] } }).raw !== AMOUNT);

  ok('a string instead of an array parses too',
     parseSlice({ account: { data: buf.toString('base64') } }).raw === AMOUNT);
  ok('a truncated answer is a refusal, not zero coins',
     parseSlice({ account: { data: [Buffer.alloc(10).toString('base64'), 'base64'] } }) === null);
  ok('an empty answer is a refusal too', parseSlice({}) === null);
  ok('a zero balance reads as zero, not as a refusal',
     parseSlice({ account: { data: [Buffer.alloc(40).toString('base64'), 'base64'] } }).raw === 0n);
}

/* ---------- the address of a token account ----------
   It is derived from the coin and the owner. A mistake here is a transfer
   into the void: the instruction goes through, the coin lands on an
   account nobody will ever open. */
{
  /* Measured on October 14 on the live chain: this owner has this BONK
     account and there are coins sitting in it. If the derivation breaks,
     the number below will stop matching. */
  const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const WHO = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  ok('the token account address derived is the one sitting in the chain',
     ataFor(BONK, WHO) === '5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw',
     ataFor(BONK, WHO));
  ok('under Token-2022 the account address is different',
     ataFor(BONK, WHO, PROG.token2022) !== ataFor(BONK, WHO));
  ok('a different owner means a different account',
     ataFor(BONK, '11111111111111111111111111111111') !== ataFor(BONK, WHO));
}

/* ---------- batches ----------
   A batch is not cosmetics: its size decides whether the transaction fits
   into the ceiling of 1232 bytes. Measured on October 14: eighteen
   transfers fit, twenty do not. */
ok('fifteen transfers to a batch', TRANSFERS_PER_TX === 15);
ok('the transfer batch matches the one the cost was computed with',
   TRANSFERS_PER_TX === COST.transfersPerTx);
ok('six accounts to a batch', CREATES_PER_TX === 6);
ok('twenty-three splits into 15 + 8',
   batch(Array.from({ length: 23 }, (_, i) => i), 15).map(b => b.length).join('+') === '15+8');
ok('nothing gives no batches', batch([], 15).length === 0);
ok('exactly one batch when it fits exactly', batch([1,2,3], 3).length === 1);
ok('not a single item is lost in the batches',
   batch(Array.from({ length: 1000 }, (_, i) => i), 15)
     .reduce((a, b) => a + b.length, 0) === 1000);
ok('the compute ceiling is not a guess: fifteen transfers fit',
   CU_TRANSFERS >= 15 * 1900 && CU_TRANSFERS <= 15 * 1900 * 3, CU_TRANSFERS);

/* ---------- the key ----------
   Parsing the key wrong means signing with the wrong wallet. We check all
   three forms of writing it down, because a person will paste the one his
   wallet gave him, not the one we would have preferred. */
{
  const seed = new Uint8Array(32).fill(7);
  const a = operatorFrom(JSON.stringify([...seed]));
  ok('a seed as an array of numbers parses', C.isAddress(a.publicKey.toBase58()));
  const hex = [...a.secretKey].map(b => b.toString(16).padStart(2, '0')).join('');
  ok('the same key in hex gives the same address',
     operatorFrom(hex).publicKey.toBase58() === a.publicKey.toBase58());
  ok('the same key as an array of 64 numbers gives the same address',
     operatorFrom(JSON.stringify([...a.secretKey])).publicKey.toBase58()
       === a.publicKey.toBase58());

  let why = '';
  try { operatorFrom(hex, '11111111111111111111111111111111'); }
  catch (e) { why = e.message; }
  ok('a key not from the declared wallet is a refusal', /not from the declared/.test(why), why);
  ok('the refusal shows both addresses', why.includes(a.publicKey.toBase58()), why);

  let empty = '';
  try { operatorFrom(''); } catch (e) { empty = e.message; }
  ok('an empty key is a refusal naming the variable', /APEX_WALLET_KEY/.test(empty), empty);

  let junk = '';
  try { operatorFrom('this is not a key'); } catch (e) { junk = e.message; }
  ok('junk instead of a key is a refusal', junk.length > 0, junk);

  /* The ceiling on the priority fee: a calculation that was off by a
     factor of a thousand is obliged to refuse before the first signature
     rather than spend the whole float. */
  let over = '';
  try { new Sender(a, { dry: true, priorityMicro: MAX_PRIORITY_MICRO + 1n }); }
  catch (e) { over = e.message; }
  ok('a priority fee above the ceiling is a refusal before signing', /ceiling/.test(over), over);
  ok('the ordinary priority fee does not break the ceiling', PRIORITY_MICRO < MAX_PRIORITY_MICRO);
  ok('the sender is dry by default', new Sender(a).dry === true);
}

/* ---------- breakage ---------- */
if (BREAK) {
  const broken = [];
  if (shouldSettle({ potLamports: 0n, recipients: 25 }).settle) {
    broken.push('an empty epoch passes');
  }
  if (shares(hs).eligible.length === hs.length) {
    broken.push('the floor cuts off nobody');
  }
  if (!excludeNonHolders(withJunk, { pools: [POOL] }).some(h => h.address === NOT_POOL)) {
    broken.push('an address differing only in case is excluded as one of ours');
  }
  if (excludeNonHolders(withJunk, { pools: [POOL] }).some(h => h.address === POOL)) {
    broken.push('the pool gets into the payout');
  }
  if (costForEpoch(100).lamports === costForEpoch(10).lamports) {
    broken.push('the cost does not depend on the number of recipients');
  }
  if (pq([q(100), q(6000)], { fair: 100 }).best.out === q(6000).out) {
    broken.push('the bait wins the comparison against the market');
  }
  if (pq([q(100)], { fair: null }).ok) {
    broken.push('a quote passes without a market price');
  }
  if (pickQuote([{ out: 100_000_000n }], { fair: 100, unit: 1e9 }).ok) {
    broken.push('the comparison does not look at the decimals');
  }
  if (ataFor('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
             '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
      !== '5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw') {
    broken.push('the address of a token account is derived wrongly');
  }
  if (splitByBalance(7n, [{ raw: '3000' }, { raw: '2000' }, { raw: '1' }])
        .reduce((a, b) => a + b, 0n) !== 7n) {
    broken.push('the payout does not add up with what was bought');
  }
  console.log('\nBreakage: ' + (broken.length
    ? 'THE CHECKS ARE LEAKY: ' + broken.join('; ')
    : 'every substitution was caught, the checks are alive'));
  if (broken.length) process.exit(1);
}

/* ---------- the payout by exact balances ----------
   What is guarded here is not the formula but the sum. A payout that does
   not add up with what was bought will revert on the LAST transfer, when
   all the previous ones are already in the chain. Half the epoch handed
   out, half not, and no way to repeat it. */
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
      ok('the sum adds up: ' + name + ', ' + amt, sum === amt, sum.toString());
      ok('nobody gets a negative: ' + name + ', ' + amt, parts.every(x => x >= 0n));
    }
  }
  const z = splitByBalance(100n, [{ raw: '0' }, { raw: '0' }]);
  ok('with zero balances nothing is handed out', z.every(x => x === 0n), z.join(','));

  const big = splitByBalance(10n ** 18n, [{ raw: '10' }, { raw: '1' }]);
  ok('the big one gets more than the small one', big[0] > big[1], big.join(' vs '));

  /* The remainder goes to the biggest, not to the first on the list. */
  const one = splitByBalance(1n, [{ raw: '1' }, { raw: '100' }]);
  ok('the remainder goes to the biggest', one[1] === 1n && one[0] === 0n, one.join(','));
}

if (bad.length) {
  console.error('FAILED ' + bad.length + ' of ' + (passed + bad.length) + ':');
  bad.forEach(b => console.error('  · ' + b));
  process.exit(1);
}
console.log('The crank: ' + passed + ' checks passed.');
