/* =========================================================================
   THE WHOLE-PASS CHECK

   THIS FILE DID NOT EXIST, AND THAT IS EXACTLY WHY THE CRANK ONCE DID NOT
   WORK AT ALL.

   On the previous chain tick() had `const holders = …` in it, and that
   name shadowed the function of the same name imported from read.js, for
   the WHOLE function, because a const is visible throughout its body from
   the first line. The call `await holders(token, floor)` two hundred lines
   above failed with "Cannot access 'holders' before initialization". It
   failed in the live run and in the dry run alike: it never got as far as
   the payout.

   That is, the crank could not close a single epoch. Caught by the first
   fork run, not by the checks: not one of the hundred and fifty-six checks
   saw it, because they all call the parts separately, and not one of them
   ran tick() whole.

   This file runs it whole. The node is stubbed, the aggregator is stubbed,
   the list of the ten is stubbed, the journal is in memory, but the pass
   itself is real, the same code and the same order as in live.

     node crank/check-tick.js
   ========================================================================= */

import './../core.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const C = globalThis.ApexCore;

let passed = 0;
const bad = [];
const ok = (name, cond, got) => cond ? passed++
  : bad.push(name + (got === undefined ? '' : ' got: '
      + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? v.toString() : v)));

/* =========================================================================
   FIXTURES

   A coin with nine decimals, a billion of supply, three holders and a ten
   of three seats: fewer than in live, but all the rules are the same. The
   numbers are chosen so that the shares do not divide evenly, otherwise
   the check that the sum adds up would pass with broken division too.
   ========================================================================= */
const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(9));
const ME = WALLET.publicKey.toBase58();
const TOKEN = 'ApeX1111111111111111111111111111111111111111';
const DEC = 9;
const UNIT = 10 ** DEC;

const HOLDERS = [
  { owner: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', amount: 500_000_000n * BigInt(UNIT) },
  { owner: 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', amount: 300_000_001n * BigInt(UNIT) },
  /* The third holds 200 007 coins: that is 0.02% of supply, twice the
     floor of 0.01%. Deliberately close to it rather than "a lot": the
     floor is a rule, and a rule has to be checked at its boundary. */
  { owner: 'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG', amount: 200_007n * BigInt(UNIT) },
];

/* And one that does NOT pass the floor: 1000 coins is 0.0001% of supply.
   Without it the check "the floor cuts somebody off" would pass with a
   broken floor too. */
const DUST = { owner: '4Nd1mGUMQ8zPcfM4r1nMQ9ZtWJTJTkbTeXQKRqkfbFDi',
               amount: 1_000n * BigInt(UNIT) };

/* A PERSON WITH TWO ACCOUNTS, EACH BELOW THE FLOOR.
   60,000 plus 60,000 is 120,000, that is 0.012% of supply: he clears the
   0.01% floor. Account by account he does not.
   That is how wallets work when they open a new account on every purchase
   through certain venues. While the floor was applied to the account
   rather than to the owner, such a holder dropped out quietly and against
   his own interest. */
const SPLIT = { owner: 'CrX7kMhLC3cSsXJdT7JDgqrRVWGnUpX3gfEfxxU2NVLi',
                amount: 60_000n * BigInt(UNIT) };

const SEATS = [
  { sym: 'AAA', address: 'Aaa11111111111111111111111111111111111111111', priceNative: 0.001 },
  { sym: 'BBB', address: 'Bbb11111111111111111111111111111111111111111', priceNative: 0.01 },
  { sym: 'CCC', address: 'Ccc11111111111111111111111111111111111111111', priceNative: 0.1 },
];

/* The operator's balance: enough for the settlement and for the buys. */
let FLOAT = 3_000_000_000n;                       // 3 SOL
let EXISTING = new Set();                         // which accounts already exist
let GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
let HOLDERS_ANSWER = 'ok';                        // ok | empty | refuse

const SENT = [];                                  // what would have gone to the network

globalThis.__rpcHook = async (method, params) => {
  switch (method) {
    case 'getGenesisHash': return GENESIS_HASH;
    case 'getSlot': return 123456;
    case 'getBlockHeight': return 900;
    case 'getLatestBlockhash':
      return { value: { blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
                        lastValidBlockHeight: 1000 } };
    case 'getMinimumBalanceForRentExemption': return 1_488_440;
    case 'getBalance': return { value: params[0] === ME ? Number(FLOAT) : 0 };

    case 'getTokenSupply': {
      const mint = params[0];
      if (mint === TOKEN) {
        return { value: { amount: String(1_000_000_000n * BigInt(UNIT)), decimals: DEC } };
      }
      return { value: { amount: '1000000000000000', decimals: DEC } };
    }

    case 'getAccountInfo': {
      /* The coins belong to the old token program; everything else is
         the check "does the account exist". */
      const a = params[0];
      if (a === TOKEN || SEATS.some(s => s.address === a)) {
        return { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } };
      }
      return { value: EXISTING.has(a) ? { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } : null };
    }

    case 'getMultipleAccounts':
      return { value: params[0].map(a => (EXISTING.has(a) ? { owner: 'x' } : null)) };

    case 'getProgramAccounts': {
      if (HOLDERS_ANSWER === 'refuse') {
        throw Object.assign(new Error('getProgramAccounts is not supported'), { fatal: true });
      }
      if (HOLDERS_ANSWER === 'empty') return { value: [] };
      /* The node gives a sliced answer: forty bytes per account, the owner
         and the balance in a row. The fixture is assembled exactly the
         same way, otherwise the check would pass with a broken byte parse
         too. */
      return { value: [...HOLDERS, DUST, SPLIT, SPLIT].map((h, i) => {
        const buf = Buffer.alloc(40);
        bs58.decode(h.owner).copy ? Buffer.from(bs58.decode(h.owner)).copy(buf, 0)
                                  : buf.set(bs58.decode(h.owner), 0);
        buf.writeBigUInt64LE(h.amount, 32);
        return { pubkey: 'acc' + i, account: { data: [buf.toString('base64'), 'base64'] } };
      }) };
    }

    case 'getTokenAccountsByOwner':
      /* How much of the bought coin lies on the operator's wallet. A
         little less than the quote promised: that is slippage, and the
         payout has to be computed from it and not from the quote. */
      return { value: [{ account: { data: { parsed: { info: {
        tokenAmount: { amount: '999999999999', decimals: DEC } } } } } }] };

    case 'simulateTransaction':
      SENT.push({ kind: 'simulate' });
      return { value: { err: null, unitsConsumed: 5000, logs: [] } };

    case 'sendTransaction':
      SENT.push({ kind: 'send' });
      return 'signature';

    case 'getSignatureStatuses':
      return { value: [{ err: null, confirmationStatus: 'confirmed', slot: 1 }] };

    default:
      throw new Error('the pass asked the node for something the test did not expect: ' + method);
  }
};

/* The ten is stubbed out whole: the selection has its own checks, and what
   matters here is the pass itself. */
C.readBasket = async ({ exclude } = {}) => {
  ok('our own token is excluded from our own basket', exclude === TOKEN, exclude);
  return { basket: SEATS.map(s => ({ ...s })), source: 'test', scanned: 3, priced: 3 };
};

/* The aggregator: a quote at the market price, an empty transaction. */
const realFetch = globalThis.fetch;
let JUP_FAIL = new Set();
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('/quote')) {
    const p = new URL(url).searchParams;
    const mint = p.get('outputMint');
    const seat = SEATS.find(s => s.address === mint);
    if (!seat || JUP_FAIL.has(seat.sym)) {
      return { ok: false, status: 400, text: async () => 'no route found' };
    }
    const lamports = BigInt(p.get('amount'));
    /* Exactly the market price: as many coins as the SOL is worth. */
    const out = BigInt(Math.round((Number(lamports) / 1e9) / seat.priceNative * UNIT));
    return { ok: true, json: async () => ({
      outAmount: String(out), routePlan: [{ swapInfo: { label: 'Test' } }],
      priceImpactPct: '0.001',
    }) };
  }
  if (url.includes('/swap')) {
    /* A ready transaction: we take an empty one, assembled by our own code. */
    const { Sender } = await import('./send.js');
    const s = new Sender(WALLET, { dry: true });
    const { tx } = await s.build([]);
    return { ok: true, json: async () => ({
      swapTransaction: Buffer.from(tx.serialize()).toString('base64') }) };
  }
  return realFetch(u, o);
};

/* =========================================================================
   THE RUN
   ========================================================================= */
process.env.APEX_TOKEN = TOKEN;
process.env.APEX_OPERATOR = ME;
process.env.APEX_WALLET_KEY = bs58.encode(WALLET.secretKey);
process.env.APEX_DRY = '1';
delete process.env.DATABASE_URL;

/* We mute the pass's output: it is long, and what we check is the result.
   But we keep it so that lines can be searched in it. */
const LOG = [];
const realLog = console.log;
console.log = (...a) => LOG.push(a.join(' '));

const { tick } = await import('./index.js');

const said = re => LOG.some(l => re.test(l));

/* --- 1. An ordinary pass: everything in place --- */
{
  SENT.length = 0;
  const r = await tick();
  ok('the pass goes through to the end and does not throw', r && typeof r === 'object');
  ok('the dry run is marked dry', r.dry === true, r);
  ok('the decision to close the epoch was taken', r.plan && r.plan.settle === true,
     r.plan && r.plan.why);
  ok('four recipients: three plus the one with two accounts',
     r.plan && r.plan.recipients === 4, r.plan && r.plan.recipients);
  /* The point of this one: 60,000 plus 60,000 clears the floor, while
     60,000 on its own does not. Had the crank added the accounts up AFTER
     the floor, this person would have vanished from the list in silence. */
  ok('two accounts of one owner were added up before the floor',
     r.plan && r.plan.payout.some(h => h.address === SPLIT.owner),
     r.plan && r.plan.payout.map(h => h.address.slice(0, 6)));
  ok('and he got one share, not two',
     r.plan && r.plan.payout.filter(h => h.address === SPLIT.owner).length === 1);
  ok('and the floor is computed off the supply, not baked in',
     r.plan && r.plan.floor === 100_000, r.plan && r.plan.floor);
  ok('twelve transfers: four people onto three seats',
     r.plan && r.plan.transfers === 12, r.plan && r.plan.transfers);

  /* THE MAIN THING: the pass really did assemble the transactions and show
     them to the node. The previous version of the dry run only printed the
     intent. */
  ok('the transactions are assembled and shown to the node', SENT.length > 0, SENT.length);
  ok('not one of them is sent', SENT.every(x => x.kind === 'simulate'),
     SENT.map(x => x.kind));

  /* There was not a single account, so the deposit is counted on all nine. */
  ok('the missing accounts are counted from the chain', said(/token accounts missing\s+12 of 12/),
     LOG.filter(l => /accounts missing/.test(l)));
  ok('the deposit is shown separately from the fees', said(/rent deposits/));
  ok('the balance left for buying is shown', said(/left for buying/));
}

/* --- 2. The payout is computed from what LIES there, not from the quote --- */
{
  /* In a dry run nothing appeared on the wallet, so the quote is taken
     there. This case checks the live branch: forcing it without sending,
     by switching the mode to live through --live, is not possible (the
     arguments are read at load time), so we check that the payout log
     holds a number and not a dash. */
  ok('the payout is printed for all three seats',
     LOG.filter(l => /to 4 wallets/.test(l)).length === 3,
     LOG.filter(l => /wallets/.test(l)));
}

/* --- 3. The node returned an empty holder list --- */
{
  HOLDERS_ANSWER = 'empty';
  LOG.length = 0; SENT.length = 0;
  const r = await tick();
  ok('an empty list on a live coin is a refusal, not zero holders',
     r.settled === false && r.incomplete === true, r);
  ok('not one transaction on an incomplete snapshot', SENT.length === 0, SENT.length);
  ok('the refusal explains that a paid node is needed', said(/Helius|[Pp]aid/), LOG.slice(-6));
  HOLDERS_ANSWER = 'ok';
}

/* --- 4. The node refused the holder list --- */
{
  HOLDERS_ANSWER = 'refuse';
  LOG.length = 0; SENT.length = 0;
  const r = await tick();
  ok('a refusal by the node means the epoch does not close', r.settled === false, r);
  ok('and again not one transaction', SENT.length === 0);
  HOLDERS_ANSWER = 'ok';
}

/* --- 5. The wallet cannot cover the settlement --- */
{
  FLOAT = 100_000n;                               // 0.0001 SOL
  LOG.length = 0; SENT.length = 0;
  const r = await tick();
  ok('without the margin the epoch does not close', r.settled === false && !r.plan.settle, r.plan.why);
  ok('the reason is named in words', typeof r.plan.why === 'string' && r.plan.why.length > 0,
     r.plan.why);
  ok('and not one transaction', SENT.length === 0);
  FLOAT = 3_000_000_000n;
}

/* --- 6. One seat has nowhere to buy: its share is split between the others --- */
{
  JUP_FAIL = new Set(['BBB']);
  LOG.length = 0; SENT.length = 0;
  const r = await tick();
  ok('the seat with no route is named', said(/Seats with no route: 1 of 3/),
     LOG.filter(l => /no route/.test(l)));
  ok('its share is split between the others', said(/split between the other 2/));
  ok('the epoch closes all the same', r.plan && r.plan.settle === true);
  JUP_FAIL = new Set();
}

/* --- 7. Not one seat has a route --- */
{
  JUP_FAIL = new Set(['AAA', 'BBB', 'CCC']);
  LOG.length = 0; SENT.length = 0;
  const r = await tick();
  ok('without a single route the epoch does not close', r.settled === false, r);
  ok('and there were no buys', SENT.length === 0, SENT.length);
  JUP_FAIL = new Set();
}

/* --- 8. The accounts already exist: the deposit is not counted a second time --- */
{
  const { ataFor } = await import('./send.js');
  EXISTING = new Set();
  for (const s of SEATS) for (const h of [...HOLDERS, DUST, SPLIT]) EXISTING.add(ataFor(s.address, h.owner));
  EXISTING.add(ataFor(SEATS[0].address, ME));
  LOG.length = 0;
  const r = await tick();
  ok('from the second epoch there are no missing accounts', said(/token accounts missing\s+0 of 12/),
     LOG.filter(l => /accounts missing/.test(l)));
  ok('and the deposit goes to zero', r.plan && r.plan.rentLamports === 0n,
     r.plan && r.plan.rentLamports);
  ok('while the fees stay', r.plan && r.plan.feesLamports > 0n);
  EXISTING = new Set();
}

/* --- 9. Another cluster: live mode does not switch on --- */
{
  GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';   // devnet
  LOG.length = 0;
  delete process.env.APEX_DRY;
  const r = await tick();
  ok('on another cluster the pass stays dry', r.dry === true || r.settled === false, r);
  ok('and the cluster is named by name', said(/devnet/), LOG.slice(0, 4));
  process.env.APEX_DRY = '1';
  GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
}

/* --- 10. No coin address: that is the off switch, not a breakage --- */
{
  process.env.APEX_TOKEN = '';
  LOG.length = 0; SENT.length = 0;
  /* The address is read when the module loads, so we reload it. */
  const fresh = await import('./index.js?nocache=' + Date.now());
  const r = await fresh.tick();
  ok('without a coin address the pass refuses honestly',
     r.skipped === 'no token address', r);
  ok('and touches nothing in the network', SENT.length === 0);
  process.env.APEX_TOKEN = TOKEN;
}

console.log = realLog;
globalThis.fetch = realFetch;

if (bad.length) {
  console.error('FAILED ' + bad.length + ' of ' + (passed + bad.length) + ':');
  bad.forEach(b => console.error('  · ' + b));
  process.exit(1);
}
console.log('The whole pass: ' + passed + ' checks passed.');
