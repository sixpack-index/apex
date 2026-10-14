/* =========================================================================
   The crank.

   Wakes up every three hours, looks at how much the fee has accrued, and
   if what has accrued is enough to cover the settlement, takes it, buys
   the basket and sends it out to holders.

   RUNNING

     node crank/index.js              one pass
     node crank/index.js --watch      the same thing on a schedule
     node crank/index.js --live       force live mode (needed on a fork)
     APEX_DRY=1 node crank/…       force dry mode, the kill switch

   Live mode switches itself ON when three things line up: the key in
   APEX_WALLET_KEY, a token address entered in the console, and the real
   network. While one of them is missing it is a dry run, and the crank
   writes into the log which one. Details at the declaration of FORCE_LIVE
   below.

   ENVIRONMENT VARIABLES

     APEX_TOKEN     the token address
     The addresses of the coin and of the working wallet are entered in the
     CONSOLE and live in the database: one place for the whole project. The
     variables below override them for a single pass, which is what a fork
     run needs, where the coin is somebody else's.

     APEX_OPERATOR  the address of the WORKING wallet, the one the crank
                       buys and hands out from
     APEX_WALLET_KEY  the private key of the working wallet, THE MONEY
                         ITSELF. It is also the switch for live mode. It
                         lives in the crank service's variable and nowhere
                         else: it never reaches the database.
     APEX_RPC       the node. Live by default; for a fork run put
                       http://127.0.0.1:8899 here

   TWO WALLETS

   One wallet receives the fee from the pool, and the crank works from
   another. The owner collects the fee himself and decides himself how much
   to move to the working one; the size of an epoch is computed from the
   balance ON THE WORKING WALLET.

   The point is that the crank's key controls only a small float. A leak
   costs the float, not the whole accrued fee. The details are at the
   place where the balance is computed.

   The pool identifier is no longer needed: on Pons everything the pool key
   knew is asked of the factory by the token address, and the pool itself
   is found by sweeping the enabled fee tiers. One setting fewer that can
   be entered wrong.

   The dry run is the default, and that is not caution for caution's sake.
   The program spends other people's money eight times a day; it must be
   able to show its decision before it executes it, and to show it with the
   same code that executes it afterwards.
   ========================================================================= */

import './../core.js';
import { NOT_HOLDERS, PROG, GENESIS, quote, slot, holders, supplyOf,
         ownerProgramOf, solBalance, tokenBalance, rentExempt, whichMissing,
         vaultPot, rpc, RPC_URL, IS_DEFAULT_RPC } from './read.js';
/* The signing layer is loaded at the top rather than on demand, and that
   is a change from the previous version.

   Before, send.js was pulled in only by the live part: it dragged in
   ethers, and the dry run had to work on bare node. Now the dry run
   SIMULATES every transaction against the node, that is, it assembles the
   transaction for real and signs it formally. It needs the library exactly
   as much as the live run does, and hiding it makes no sense any more.

   The journal (pg) stayed on demand: the dry run gets by without a database. */
import { Sender, operatorFrom, ixCreateAta, ixTransfer, swapTx, ataFor,
         batch, PER_TX, CU_TRANSFERS, CU_CREATES, CREATES_PER_TX } from './send.js';
import { planEpoch, COST, redistribute, splitByBalance, pickQuote } from './plan.js';

const C = globalThis.ApexCore;

const ARG = new Set(process.argv.slice(2));
const WATCH = ARG.has('--watch');

/* =========================================================================
   LIVE MODE SWITCHES ITSELF ON

   It used to be switched on by the `--live` flag in the start command.
   That meant that on launch day someone had to remember to go to Railway
   and add four letters to the command, by hand, in the very hour they were
   busy with something else entirely. Forgetting breaks nothing, but the
   epochs would quietly stop closing, and it would look exactly like a
   working crank.

   Now the mode is derived from the state, and all three conditions are
   deliberate acts that do not happen by accident:

     1. the private key is in APEX_WALLET_KEY, a service variable, set by
        hand and once;
     2. the token address is entered in the console (or in the variable),
        the very act this whole question arose for;
     3. the node answers with the genesis hash of Solana mainnet and
        not of some other cluster. Solana has no network id at all, and
        the hash is stricter than an id: an id is set by whoever starts
        the node, a hash is computed from the contents.

   Any of the three missing means a dry run, and the crank prints which one
   is missing. No "it switched itself on and I did not understand why".

   Both switches are still there and they work in both directions:
     `--live`         turn it on by force (needed on a fork: there the key
                      is fake, but the pass is live);
     APEX_DRY=1    turn it off by force, whatever is configured.
                      This is the kill switch: one variable puts out every
                      payout without touching the site, the database or the key.
   ========================================================================= */
const FORCE_LIVE = ARG.has('--live');
/* Variable names are read through one helper: APEX_TOKEN, APEX_OPERATOR,
   APEX_WALLET_KEY, APEX_DRY.

   The former prefix is gone entirely. It survived as a fallback while the
   variables in Railway still carried the old names; they carry the new ones
   now, and keeping the second half of every line would say only one thing:
   that the old name still lives somewhere. It does not. */
const env = (name) => process.env['APEX_' + name] || '';

const FORCE_DRY = ARG.has('--dry') || env('DRY') === '1';

/* =========================================================================
   WHERE THE CRANK GETS ITS ADDRESSES

   The address of the coin and the address of the working wallet are
   entered IN ONE PLACE, in the console. From there they reach the
   database, and from there both the storefront and the crank read them.

   It was made this way after a direct remark: the coin address used to
   live in two places, in the database (which the site reads) and in an
   environment variable on Railway (which the crank read). Two places for
   one fact diverge without fail, and they diverge at the most awkward
   moment: on launch day, when the address is entered in a hurry. The site
   would show one coin, the crank would hand out by another, and it would
   be noticed through complaints.

   Environment variables remain as an OVERRIDE and are needed for a fork
   run: the coin there is somebody else's, and reaching into the live
   database for that is not allowed. A variable that is set always beats
   the database.

   THE KEY NEVER REACHES THE DATABASE. It is only in the environment
   variable of the crank service. The database sits next to the server that
   faces outward; a key to money must not appear in it under any
   circumstances.
   ========================================================================= */
const CFG = {
  token: env('TOKEN'),
  operator: env('OPERATOR'),
  /* The account where pump.fun puts the creator fee. It is needed only to
     show in the log how much has accrued: the owner collects it. */
  vault: env('VAULT'),
  /* The name says what this is: the key TO THE WALLET, the money itself. */
  key: env('WALLET_KEY'),
};

/** What in the settings did not come from the environment, for an honest report. */
const fromDb = new Set();

/**
 * Read the addresses out of the database if they are not in the environment.
 *
 * The database can be unreachable, and that is no reason to fall over:
 * with the variables set the crank works perfectly well without it. Saying
 * nothing about it is not allowed: otherwise "the address is not set"
 * would mean two different things at once.
 */
async function loadConfig() {
  if (CFG.token && CFG.operator && CFG.vault) return;
  if (!process.env.DATABASE_URL) return;
  try {
    const { settings } = await import('./../server/db.js');
    const s = await settings();
    if (!CFG.token && s.token) { CFG.token = s.token; fromDb.add('token'); }
    if (!CFG.operator && s.operator) { CFG.operator = s.operator; fromDb.add('operator'); }
    if (!CFG.vault && s.vault) { CFG.vault = s.vault; fromDb.add('vault'); }
  } catch (e) {
    console.log('  ⚠ The settings did not read out of the database: ' + (e.message || e));
    console.log('    Working off the environment variables, if they are set.');
  }
}

const EVERY_MS = C.MODEL.epochHours * 3600 * 1000;

/* ---------- output ---------- */

/* Lamports into SOL. Nine decimal places, not eighteen: this is a
   different chain, and showing it at the old precision means showing noise. */
const sol = (lamports, d = 6) => (Number(lamports) / 1e9).toFixed(d);
const nf = (v, d = 0) => Number(v).toLocaleString('en-US',
  { minimumFractionDigits: d, maximumFractionDigits: d });

function line(k, v) { console.log('  ' + String(k).padEnd(26) + v); }
function head2(t) { console.log('\n' + t); console.log('  ' + '─'.repeat(58)); }

/**
 * Is this pass live or dry, and above all, WHY.
 *
 * The reason is returned together with the decision and printed always, in
 * both cases. A mode that cannot be explained in one line of the log is a
 * mode you will one day find yourself in without being who you thought.
 *
 * Called after loadConfig(): the token address comes from the database,
 * and the database is read inside the pass. So a contract entered in the
 * console is picked up by the very next epoch, without a redeploy and
 * without editing the start command.
 */
function decideLive(genesis) {
  if (FORCE_DRY) return { live: false, why: 'switched off by hand (APEX_DRY=1)' };
  if (FORCE_LIVE) return { live: true, why: 'started with --live' };
  if (!CFG.key) {
    return { live: false, why: 'no key: APEX_WALLET_KEY is not set on the service' };
  }
  if (!C.isAddress(CFG.token)) {
    return { live: false, why: 'the token address is not set, it is entered in the console' };
  }
  if (!C.isAddress(CFG.operator)) {
    return { live: false, why: 'the working wallet address is not set, it is entered in the console' };
  }
  /* The network is checked last and strictly: the key is real, the
     addresses are real, and the only thing separating us from another
     chain is this hash. The automation has no right to get it wrong
     silently.

     Solana has no network number at all, and at first that looks like the
     absence of protection. But every cluster has its own hash of the first
     block, and that is stricter than a number: a number can be set by
     starting a node, a hash cannot, it is computed from the contents. So
     we check it. */
  if (genesis !== GENESIS.mainnet) {
    const named = Object.entries(GENESIS).find(([, v]) => v === genesis);
    return { live: false,
             why: 'the node answers with hash ' + (named ? named[0] : String(genesis).slice(0, 12) + '…')
                + ', and mainnet is needed. For your own node start with --live' };
  }
  return { live: true, why: 'the key is in place, the token address is entered, the cluster is the right one' };
}

/* ---------- one pass ---------- */

export async function tick() {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log('\n' + '═'.repeat(62));
  console.log(stamp + '   pass');
  console.log('═'.repeat(62));

  /* Which node we connected to, on the first line and always.

     On your own node everything looks exactly like live: the same
     programs, the same balances, the same answers. The one way to tell
     them apart is the node address and the cluster hash, and if they are
     not written down then the most dangerous question, "is this definitely
     not real money?", has no answer. */
  let genesis = null;
  try { genesis = await rpc('getGenesisHash'); } catch (_) {}
  const where = IS_DEFAULT_RPC ? 'the live node' : 'OWN NODE · ' + RPC_URL;
  const cluster = genesis === GENESIS.mainnet ? 'mainnet'
    : (Object.entries(GENESIS).find(([, v]) => v === genesis) || [null])[0];
  console.log('  ' + where + (cluster ? '  · ' + cluster : genesis ? '  · another cluster' : ''));

  await loadConfig();
  if (fromDb.size) {
    console.log('  from the database: ' + [...fromDb].join(', ') + ', entered in the console');
  }

  /* The mode is decided HERE, after the database: the token address comes
     from there, which means a contract entered in the console switches
     live mode on by itself, on the very next epoch. */
  const { live: LIVE, why: whyMode } = decideLive(genesis);
  console.log('  ' + (LIVE ? 'LIVE MODE' : 'dry run, nothing gets sent')
              + ': ' + whyMode);
  if (LIVE && IS_DEFAULT_RPC) {
    console.log('  ⚠ The transactions will go out for real, on real money.');
  }

  if (!C.isAddress(CFG.token)) {
    console.log('\n  The coin address is not set. While it is missing there is');
    console.log('  nothing to compute: that is the off switch.');
    console.log('  It is entered in the console, where the site sees it too.');
    console.log('  To override for one pass: APEX_TOKEN=…');
    return { skipped: 'no token address' };
  }

  /* 1. What the chain knows about the coin.

     The decimals and the supply come from the chain, not from a constant:
     a constant will one day diverge from the coin, and the shares will
     drift silently. The coin's program comes from the chain too: it
     decides which program does the transfer, and a mistake here is a
     refusal in the middle of the payout. */
  const sup = await supplyOf(CFG.token);
  const program = await ownerProgramOf(CFG.token);
  const at = await slot();

  head2('the coin');
  line('address', CFG.token);
  line('supply', nf(sup.supply) + '  (' + sup.decimals + ' decimals)');
  line('program', program === PROG.token2022 ? 'Token-2022' : 'SPL Token');
  line('slot', nf(at));

  /* 2. How much the creator fee has accrued, for reference.

     The owner collects it with his own wallet; the crank does not reach
     that far and must not. The line is there so that the log shows when it
     is time to move money to the working wallet. */
  if (C.isAddress(CFG.vault)) {
    try {
      const v = await vaultPot(CFG.vault);
      line('accruing on the account', sol(v.free) + ' SOL  (' + CFG.vault + ')');
    } catch (e) {
      line('accruing on the account', 'did not read: ' + (e.message || e));
    }
  }

  /* =======================================================================
     TWO WALLETS, AND THAT IS ON PURPOSE

       the creator wallet  receives the fee from trading. Only the owner
                           has the key; the crank does not see it and
                           cannot touch it.
       the working wallet  holds a small float for buys and for the
                           settlement. The crank has its key.

     The owner collects the fee himself and decides himself how much to
     move to the working wallet. The epoch is computed from THE BALANCE ON
     THE WORKING WALLET.

     What this buys: a leak of the crank's key costs exactly what lies on
     the working wallet, not the whole accrued fee. The loss is capped by
     the size of the float, and it is capped not by an agreement but by the
     fact that the crank has no second key. On pump.fun the program itself
     holds this up: only the creator can take the creator fee.
     ======================================================================= */
  if (!C.isAddress(CFG.operator)) {
    console.log('\n  The working wallet address is not set.');
    console.log('  This is the wallet the crank buys the basket from and hands');
    console.log('  it out to holders from: it has to hold a supply of SOL.');
    console.log('\n  It is entered in the console, section "working wallet".');
    console.log('  The console will also show how many epochs the balance covers.');
    console.log('  To override for one pass: APEX_OPERATOR=…');
    return { skipped: 'no operator address' };
  }

  const float = await solBalance(CFG.operator);

  head2('working wallet');
  line('address', CFG.operator);
  line('balance', sol(float) + ' SOL');

  if (float === 0n) {
    console.log('\n  ⚠ The working wallet is empty. The crank will be able neither');
    console.log('    to buy the basket nor to hand it out: the fee will pile up on the');
    console.log('    creator account, but the epochs will not close. Top it up before launch.');
  }

  /* 3. Who is in.

     The floor is a hundredth of a percent of supply, as it was. The
     snapshot has to be complete: shares are computed off the sum of the
     balances, and an incomplete sum means wrong shares for EVERYONE, not
     only for the ones that did not read. */
  const floor = sup.supply * 0.0001;
  const snap = await holders(CFG.token, floor, { slot: at, supply: sup, program });
  const hs = snap.holders;

  /* 4. What to buy */
  const basket = await C.readBasket({ exclude: CFG.token });

  /* 5. The rent deposit for an account, live, from the node.

     The same figure sits in plan.js as a constant, and it is there for a
     rough estimate and for the checks. The rent reduction comes in stages,
     and those two numbers can diverge at any moment. Once they do, the
     crank computes the wrong cost, and that gets noticed in the middle of
     the payout. */
  let rent = null;
  try { rent = await rentExempt(); } catch (_) {}
  if (rent !== null && rent !== COST.rentPerAccount) {
    console.log('\n  The rent deposit per account at the node is ' + sol(rent, 8) + ' SOL, in the code '
                + sol(COST.rentPerAccount, 8) + ': going by the node.');
  }

  /* 6. The first decision: by the worst case.

     How many accounts are missing we do not know yet, and we have to know
     it before the decision, otherwise the first epoch turns out several
     times more expensive than expected. So the plan is computed twice:
     first to learn WHO the recipients are, then to learn how many accounts
     they are missing. The second computation is the decision. */
  const draft = planEpoch({
    potLamports: float, basket: basket.basket, holders: hs, supply: sup.supply,
    operator: CFG.operator, token: CFG.token,
    exclude: [...NOT_HOLDERS, CFG.vault || ''].filter(Boolean),
  });

  head2('who is in');
  line('snapshot at slot', nf(snap.slot));
  line('accounts for the coin', nf(snap.listed) + (snap.failed ? '  · NOT READ ' + nf(snap.failed) : ''));
  line('holders', nf(hs.length));
  line('sum of their balances', nf(Math.round(hs.reduce((a, h) => a + h.balance, 0))) +
       (sup.supply ? '  (' + (hs.reduce((a, h) => a + h.balance, 0) / sup.supply * 100).toFixed(2) + '% of supply)' : ''));
  line('floor', nf(draft.floor) + ' coins (0.01% of supply)');
  line('pass the floor', nf(draft.recipients));
  line('excluded', nf(draft.excluded) + '  (the operator, the coin itself, the incinerator)');
  line('eligible supply', nf(draft.eligibleSupply) + '  (' + (draft.eligibleRatio * 100).toFixed(2) + '% of the whole)');

  /* The snapshot has to be complete. This is checked BEFORE the cost is
     computed: there is no point in costing a payout off a list that is not
     there. */
  if (!snap.complete) {
    console.log('\n  The epoch is NOT closing: the holder snapshot is incomplete.');
    console.log('  ' + (snap.why || 'the reason is unknown'));
    return { settled: false, incomplete: true, why: snap.why };
  }

  if (!draft.recipients) {
    console.log('\n  The epoch is NOT closing: nobody passes the floor.');
    console.log('  That is normal until the coin is first bought.');
    return { settled: false, plan: draft };
  }

  /* 7. How many accounts are missing, from the chain, in batches of a hundred.

     Account addresses are derived from the coin and the owner, without
     going to the network; the only thing the network is asked is "does it
     exist". For a thousand recipients and ten coins that is a hundred
     calls. Computed once per epoch. */
  /* The coin's program arrives together with the ten: the aggregator gives
     it in the same answer as the numbers. The crank used to ask the node
     for it with one request per seat, ten extra calls per epoch, any of
     which could fail to arrive, and then the seat quietly dropped out of
     the basket.

     We ask the node only where the source said nothing. */
  const mints = [];
  for (const t of basket.basket) {
    let p = t.program || null;
    if (p !== PROG.token && p !== PROG.token2022) {
      try { p = await ownerProgramOf(t.address); }
      catch (_) { continue; }   // a coin that is not in the chain drops out at the quote too
    }
    mints.push({ ...t, program: p });
  }

  const wanted = [];
  for (const m of mints) {
    for (const h of draft.payout) wanted.push(ataFor(m.address, h.address, m.program));
  }
  const missing = await whichMissing(wanted);
  const missingSet = new Set(missing);

  /* 8. The decision. Now with the real number of missing accounts. */
  const plan = planEpoch({
    potLamports: float, basket: mints, holders: hs, supply: sup.supply,
    operator: CFG.operator, token: CFG.token,
    missingAccounts: missing.length,
    exclude: [...NOT_HOLDERS, CFG.vault || ''].filter(Boolean),
  });

  head2('what the settlement will cost');
  line('transfers', nf(plan.transfers) + '  (' + nf(plan.recipients) + ' × ' + mints.length + ')');
  line('transactions', nf(Math.ceil(plan.transfers / PER_TX) + mints.length));
  line('token accounts missing', nf(missing.length) + ' of ' + nf(wanted.length));
  line('fees', sol(plan.feesLamports) + ' SOL');
  line('rent deposits', sol(plan.rentLamports) + ' SOL  (one-off, comes back to the holder)');
  line('total', sol(plan.costLamports) + ' SOL');
  line('needed with margin', sol(plan.needLamports) + ' SOL');
  line('left for buying', sol(plan.buyableLamports) + ' SOL');

  if (!plan.settle) {
    console.log('\n  The epoch is NOT closing: ' + plan.why + '.');
    console.log('  Three hours is a floor, not a length: we keep accruing.');
    return { settled: false, plan };
  }

  /* 9. The quotes. All at once: each of them climbs to the aggregator, and
        one after another that is minutes.

     AND EVERY ONE IS CHECKED AGAINST THE MARKET. The aggregator picks the
     route, and it picks better than our own sweep of the pools. But that
     is somebody else's work, and it has to be checked: the aggregator is
     capable of taking a buy through a pool with a painted price exactly as
     our own sweep would, and it will report success while doing it. The
     measurement on the previous chain: one token had eighty-five pools,
     and the best one "by the number of coins" promised sixty times more
     than the market is worth.

     The point of reference is the seat's price in SOL from the same list
     the ten was assembled by. A deviation of more than threefold in either
     direction means refusing the seat, not buying it. */
  head2('what it will buy');
  const quotes = await Promise.all(plan.seats.map(async s => {
    try {
      const q = await quote({ mint: s.address, lamports: s.spendLamports });
      const dec = await decimalsFor(s.address, mints.find(x => x.address === s.address));
      const unit = Math.pow(10, dec);
      /* How many coins the market price gives for the same amount. */
      const fair = s.priceNative > 0
        ? (Number(s.spendLamports) / 1e9) / s.priceNative
        : null;
      const sane = pickQuote([q], { fair, unit });
      if (!sane.ok) return { s, dec, err: 'the quote is off the market: ' + sane.why, q };
      return { s, q, dec };
    } catch (e) {
      return { s, err: e.message || String(e) };
    }
  }));

  for (const { s, q, err, dec } of quotes) {
    const got = err
      ? '→ nowhere to buy: ' + err
      : '→ ' + nf(Number(q.out) / Math.pow(10, dec), 2) + ' ' + s.sym
        + '   ' + q.venue
        + (q.impact !== null ? ', impact ' + q.impact.toFixed(2) + '%' : '');
    console.log('  ' + s.sym.padEnd(14) + sol(s.spendLamports) + ' SOL  ' + got);
  }

  /* A seat with nowhere to buy: its share is split between the other seats
     of the same epoch. Otherwise it hangs on the operator's wallet, not
     handed to holders and not returned. */
  const blind = quotes.filter(x => x.err);
  if (blind.length) {
    const names = new Set(blind.map(x => x.s.sym));
    const r = redistribute(plan.seats, names);
    plan.seats = r.seats;
    console.log('\n  ⚠ Seats with no route: ' + blind.length + ' of ' + plan.seats.length +
                ': ' + blind.map(x => x.s.sym).join(', ') + '.');
    if (r.live) {
      console.log('    Their share (' + sol(r.moved) + ' SOL) is split between the other ' +
                  r.live + '.');
      /* The shares changed, so the quotes went stale: taken again. */
      const again = await Promise.all(plan.seats.filter(s => !names.has(s.sym)).map(async s => {
        try {
          const q = await quote({ mint: s.address, lamports: s.spendLamports });
          const dec = await decimalsFor(s.address, mints.find(x => x.address === s.address));
          const fair = s.priceNative > 0 ? (Number(s.spendLamports) / 1e9) / s.priceNative : null;
          const sane = pickQuote([q], { fair, unit: Math.pow(10, dec) });
          if (!sane.ok) return { s, dec, err: 'the quote is off the market: ' + sane.why };
          return { s, q, dec };
        } catch (e) { return { s, err: e.message || String(e) }; }
      }));
      quotes.length = 0;
      quotes.push(...again);
    } else {
      console.log('    Not one seat has a route: there is nothing to buy,');
      console.log('    the epoch does not close.');
      return { settled: false, plan };
    }
  }

  head2('who it will pay');
  plan.payout.slice(0, 8).forEach(p =>
    console.log('  ' + p.address + '  ' + (p.share * 100).toFixed(4) + '%'));
  if (plan.payout.length > 8) console.log('  … and another ' + nf(plan.payout.length - 8));

  /* =======================================================================
     SENDING

     Everything above only read and computed. From here on transactions get
     signed, and the order here is not decoration but the only protection.

     Signing and the journal are loaded HERE and not at the top of the
     file, on purpose: send.js pulls in the Solana library, journal.js
     pulls in pg. The dry run has to work on bare node, otherwise people
     stop running it on a fresh machine, and it is the main instrument.

     The dry run does come this far and further: it SIMULATES every
     transaction against the node. The previous version only printed the
     intent, and a mistake in an assembled call was found by the first live
     signature.
     ======================================================================= */
  /* Without a key there is nothing to simulate with: it has to be signed
     at least formally. So in a dry run without a key we stop here, honestly. */
  if (!CFG.key) {
    console.log('\n  The dry run ended at the settlement: there is no key, nothing');
    console.log('  to assemble the transactions with. Everything above is computed.');
    return { settled: false, dry: true, plan };
  }

  const wallet = operatorFrom(CFG.key, CFG.operator);
  const sender = new Sender(wallet, { dry: !LIVE });

  if (!LIVE) {
    head2('simulation');
    console.log('  Nothing gets sent: every transaction is assembled and');
    console.log('  shown to the node, and it answers whether it would go through.');
  }

  /* The journal is kept by the database. It can be absent: on a fresh
     machine, where the dry run is the first thing anyone runs,
     DATABASE_URL is usually not set. That is no reason to refuse: the dry
     run needs the journal for nothing except making the code go the same
     way. So without a database it gets a journal in memory, and a LIVE run
     never goes without a database: the journal is the whole protection
     against a second payment. */
  const J = (!process.env.DATABASE_URL && !LIVE)
    ? memoryJournal()
    : await import('./journal.js');
  if (!process.env.DATABASE_URL && LIVE) {
    console.log('\n  STOPPED. A live run does not go without a database: the journal');
    console.log('  is the only protection against a second payment to someone already paid.');
    console.log('  Set DATABASE_URL on the crank service.');
    return { settled: false, plan, stuck: true };
  }

  const { run, resumed, done, pending } = await J.openRun({
    token: CFG.token, pot: float, operator: CFG.operator });

  /* A run cut off halfway is not a rarity but the norm: the node goes
     quiet, the process gets killed, the float runs out. Continuing blind
     is not allowed. */
  if (pending.length) {
    console.log('\n  The previous run was cut off, steps in the unknown: ' + pending.length);
    for (const step of pending) {
      const v = await J.resolveStep(step, CFG.operator);
      console.log('    ' + step.key + ' → ' + v.verdict + (v.why ? ' (' + v.why + ')' : ''));
      if (v.verdict === 'mined') done.add(step.key);
      if (v.verdict === 'pending') {
        console.log('\n  STOPPED. The step can still go through: its blockhash is alive.');
        console.log('  Repeating it now means possibly paying twice.');
        console.log('  In a minute the answer becomes exact by itself: the next pass decides.');
        await J.closeRun(run.id, 'running', null);
        return { settled: false, plan, waiting: true };
      }
      if (v.verdict === 'unknown') {
        await J.closeRun(run.id, 'stuck', 'step ' + step.key + ': ' + v.why);
        console.log('\n  STOPPED. One step can be neither confirmed nor cancelled.');
        console.log('  To continue means possibly paying twice. A human is needed.');
        return { settled: false, plan, stuck: true };
      }
    }
  }
  if (resumed) console.log('  Continuing run #' + run.id + ', steps done: ' + done.size);

  const opts = { done };

  /* --- The buys ---

     No wrapping and no approvals: on Solana the owner signs the transfer
     himself, and the router wraps and unwraps SOL itself inside the same
     transaction. Two cost items of the previous chain disappeared entirely. */
  head2(LIVE ? 'buying' : 'checking the buys');
  const bought = [];
  for (const { s, q, err } of quotes) {
    if (err || !s.spendLamports || s.spendLamports <= 0n) continue;
    try {
      const tx = await swapTx({ route: q.route, owner: CFG.operator });
      const r = await J.runStep(run.id, 'swap:' + s.sym,
        () => sender.settle(tx), opts);
      if (r.skipped) { console.log('  ' + s.sym.padEnd(14) + 'already bought earlier'); }
      else console.log('  ' + s.sym.padEnd(14) + (r.dry ? 'the simulation passed' : r.signature));
      bought.push(s);
    } catch (e) {
      /* A purchase that did not land costs ONE seat, not the epoch: that
         seat's share has already been split between the others above, and
         stopping here would cost the payout of nine coins that were
         bought.

         The payout is different: there an exception goes all the way up
         and stops the run. The difference is that a purchase that did not
         land is visible at once and costs one seat, while a batch of
         transfers that did not land is not visible at all and costs
         people their share. */
      console.log('  ' + s.sym.padEnd(14) + 'skipped: ' + (e.message || e));
    }
  }

  if (!bought.length) {
    await J.closeRun(run.id, 'empty', 'not a single buy worked out');
    console.log('\n  Not one buy worked out, there is nothing to hand out.');
    return { settled: false, plan };
  }

  /* --- The payout ---

     What gets handed out is WHAT LIES ON THE WALLET, not what the quote
     promised. The difference between them is slippage, and handing out by
     the quote means promising more than was bought: the last one comes up
     short, and the whole epoch reverts on him.

     In a dry run nothing appeared on the wallet: the buys were only
     simulated. So there the payout is computed from what the quote
     promised, otherwise the dry run would not check it at all. */
  head2(LIVE ? 'handing out' : 'checking the payout');
  const payees = plan.payout.filter(h => h.raw);
  const paid = [];                 // what goes to the storefront once the epoch closes

  for (const s of bought) {
    const m = mints.find(x => x.address === s.address);
    const prog = m ? m.program : PROG.token;
    const dec = (quotes.find(x => x.s.address === s.address) || {}).dec
                ?? await decimalsFor(s.address, m);

    let have;
    if (LIVE) {
      have = await tokenBalance(s.address, CFG.operator);
    } else {
      have = (quotes.find(x => x.s.address === s.address) || {}).q?.out || 0n;
    }
    if (have === 0n) { console.log('  ' + s.sym.padEnd(14) + 'zero on the wallet, skipping'); continue; }

    const parts = splitByBalance(have, payees);
    const from = ataFor(s.address, CFG.operator, prog);

    /* Accounts first, transfers after, and that is not order for order's
       sake: a transfer to an account that does not exist is a refusal, and
       the refusal would drag the whole batch of ten transfers down with
       it. Creation is idempotent, so a repeat is safe by itself, without
       the journal. */
    const needCreate = [];
    for (let i = 0; i < payees.length; i++) {
      if (parts[i] === 0n) continue;
      const ata = ataFor(s.address, payees[i].address, prog);
      if (missingSet.has(ata)) needCreate.push(payees[i].address);
    }

    let created = 0;
    for (const chunk of batch(needCreate, CREATES_PER_TX)) {
      const keys = chunk.map(a => 'ata:' + s.sym + ':' + a);
      const ixs = chunk.map(owner => ixCreateAta({
        payer: CFG.operator, owner, mint: s.address, ownerProgram: prog }));
      const r = await J.runBatch(run.id, keys, () => sender.settle(ixs, { cu: CU_CREATES }), opts);
      if (!r.skipped) created += chunk.length;
    }

    const moves = [];
    for (let i = 0; i < payees.length; i++) {
      if (parts[i] === 0n) continue;
      moves.push({ to: payees[i].address, amount: parts[i] });
    }

    let sent = 0;
    let lastSig = null;
    for (const chunk of batch(moves, PER_TX)) {
      const keys = chunk.map(x => 'xfer:' + s.sym + ':' + x.to);
      const ixs = chunk.map(x => ixTransfer({
        mint: s.address, from, to: ataFor(s.address, x.to, prog),
        owner: CFG.operator, amount: x.amount, decimals: dec, ownerProgram: prog }));
      const r = await J.runBatch(run.id, keys, () => sender.settle(ixs, { cu: CU_TRANSFERS }), opts);
      if (!r.skipped) { sent += chunk.length; lastSig = r.signature || lastSig; }
    }
    /* The storefront line: how much of the coin was handed out and what
       confirms it. The signature is taken from the last batch: it opens
       the transaction in the explorer. One line per seat, not per
       transfer: otherwise the storefront drowns in ten thousand lines for
       one epoch. */
    if (lastSig && sent) {
      paid.push({ signature: lastSig, symbol: s.sym, token: s.address,
                  amount: Number(have) / Math.pow(10, dec),
                  recipients: sent, runId: run.id });
    }
    console.log('  ' + s.sym.padEnd(14)
      + nf(Number(have) / Math.pow(10, dec), 2) + ' to ' + sent + ' wallets'
      + (created ? '  (+' + created + ' accounts created)' : ''));
  }

  if (!LIVE) {
    await J.closeRun(run.id, 'dry', 'dry run, everything simulated');
    console.log('\n  The dry run is over. Not a single transaction was sent,');
    console.log('  but every one was assembled and checked by the node. Mode reason: ' + whyMode + '.');
    return { settled: false, dry: true, plan, runId: run.id };
  }

  /* The storefront learns about the epoch here, and only after the payout
     has gone through. Writing it earlier means one day showing an epoch
     that broke off halfway. */
  let shown = 0;
  try { shown = await J.recordEpoch(paid); }
  catch (e) { console.log('  ⚠ Writing to the storefront failed: ' + (e.message || e)); }

  await J.closeRun(run.id, 'ok', null);
  console.log('\n  The epoch is closed. Run #' + run.id +
              ', fees spent ' + sol(sender.spentLamports()) + ' SOL.');
  console.log('  Lines added to the storefront: ' + shown + ' of ' + paid.length + '.');
  return { settled: true, plan, runId: run.id, paid: paid.length };
}

/* =========================================================================
   A JOURNAL IN MEMORY, FOR THE DRY RUN ONLY

   The same set of functions as the real one, and it stores nothing longer
   than the process. It is there so that the dry run goes by THE SAME code
   as the live one: a branch saying "and here there is no journal" in the
   main path would mean the live path is checked only in live.

   A live run never gets here: there is a refusal above.
   ========================================================================= */
function memoryJournal() {
  let n = 0;
  const steps = new Map();
  return {
    async openRun() { return { run: { id: ++n }, resumed: false, done: new Set(), pending: [] }; },
    async closeRun() {},
    async runStep(runId, key, send, { done } = { done: new Set() }) {
      if (done.has(key)) return { skipped: true, key };
      if (steps.has(key)) return { skipped: true, key, alreadyClaimed: true };
      steps.set(key, true);
      const rec = await send();
      done.add(key);
      return { ...rec, key };
    },
    async runBatch(runId, keys, send, { done } = { done: new Set() }) {
      const todo = keys.filter(k => !done.has(k) && !steps.has(k));
      if (!todo.length) return { skipped: true, keys };
      for (const k of todo) steps.set(k, true);
      const rec = await send(todo);
      for (const k of todo) done.add(k);
      return { ...rec, keys: todo };
    },
    async resolveStep() { return { verdict: 'dropped', why: 'a journal in memory' }; },
    async recordEpoch(rows) { return (rows || []).length; },
  };
}

/* The decimals of a basket coin. From the list if it gave them, otherwise
   from the chain: the transfer is made by the checked instruction, and it
   verifies the decimals against the coin. A mistake here is a refusal and
   not a transfer of the wrong amount, but a refusal in the middle of the
   payout also costs an epoch. */
const decCache = new Map();
async function decimalsFor(mint, hint) {
  if (hint && Number.isFinite(hint.decimals)) return hint.decimals;
  if (decCache.has(mint)) return decCache.get(mint);
  const s = await supplyOf(mint);
  decCache.set(mint, s.decimals);
  return s.decimals;
}

/* ---------- the schedule ---------- */

async function once() {
  try { await tick(); }
  catch (e) { console.error('\n  The pass failed: ' + (e.message || e)); }
}

if (import.meta.url === 'file://' + process.argv[1]
    || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  if (WATCH) {
    console.log('The crank is running. Checking every ' + C.MODEL.epochHours + ' h.');
    await once();
    setInterval(once, EVERY_MS);
  } else {
    await once();
  }
}
