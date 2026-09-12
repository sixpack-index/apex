/* =========================================================================
   The crank.

   Wakes up every three hours, looks at how much the fee has accrued, and
   if what has accrued is enough to cover the settlement, takes it, buys
   the basket and sends it out to holders.

   RUNNING

     node crank/index.js              one pass
     node crank/index.js --watch      the same thing on a schedule
     node crank/index.js --live       force live mode (needed on a fork)
     APEX_DRY=1 node crank/...        force dry mode, the kill switch

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
                       http://127.0.0.1:8545 here

   TWO WALLETS

   One wallet receives the fee from the pool, and the crank works from
   another. The owner collects the fee himself and decides himself how much
   to move to the working one; the size of an epoch is computed from the
   balance ON THE WORKING WALLET.

   The point is that the crank's key controls only a small float. A leak
   costs the float, not the whole accrued fee. Details are at the place
   where the balance is computed.

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
import { ADDR, NOT_HOLDERS, poolPot, launchInfo, poolFor, quote, feeLabel,
         gasPrice, head, holders, supplyOf, ethBalance, erc20Balance,
         rpc, RPC_URL, IS_DEFAULT_RPC } from './read.js';
import { planEpoch, gasForEpoch, GAS, redistribute, splitByBalance } from './plan.js';

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
     3. the node answers that this is Robinhood Chain and not some other
        network.

   Any of the three missing means a dry run, and the crank prints which one
   is missing. No "it switched itself on and I did not understand why".

   Both switches are still there and they work in both directions:
     `--live`       turn it on by force (needed on a fork: the key there is
                    fake, but the pass is live);
     APEX_DRY=1     turn it off by force, whatever is configured. This is
                    the kill switch: one variable puts out every payout
                    without touching the site, the database or the key.
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
  /* The name says what this is: the key TO THE WALLET, that is, the money
     edit of the variable. */
  key: env('WALLET_KEY'),
};

/** What in the settings did not come from the environment, for an honest line in the report. */
const fromDb = new Set();

/**
 * Read the addresses out of the database if they are not in the environment.
 *
 * The database can be unreachable, and that is no reason to fall over:
 * with the variables set the crank works perfectly well without it. Saying
 * nothing about it is not allowed, otherwise "the address is not set"
 * would mean two different things at once.
 */
async function loadConfig() {
  if (CFG.token && CFG.operator) return;
  if (!process.env.DATABASE_URL) return;
  try {
    const { settings } = await import('./../server/db.js');
    const s = await settings();
    if (!CFG.token && s.token) { CFG.token = s.token; fromDb.add('token'); }
    if (!CFG.operator && s.operator) { CFG.operator = s.operator; fromDb.add('operator'); }
  } catch (e) {
    console.log('  ⚠ The settings did not read out of the database: ' + (e.message || e));
    console.log('    Working off the environment variables, if they are set.');
  }
}

const EVERY_MS = C.MODEL.epochHours * 3600 * 1000;

/* ---------- output ---------- */

const eth = (wei, d = 6) => (Number(wei) / 1e18).toFixed(d);
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
function decideLive(chainId) {
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
     chain is this number. The automation has no right to get it wrong
     silently. */
  if (chainId !== C.CHAIN.id) {
    return { live: false, why: 'the node answers "network ' + chainId + '", and Robinhood Chain ('
                               + C.CHAIN.id + ') is needed. For a fork, start with --live' };
  }
  return { live: true, why: 'the key is in place, the token address is entered, the network is the right one' };
}

/* ---------- one pass ---------- */

export async function tick() {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log('\n' + '═'.repeat(62));
  console.log(stamp + '   pass');
  console.log('═'.repeat(62));

  /* Which node we connected to, on the first line and always.

     On a fork everything looks exactly like live: the same contracts, the
     same balances, the same answers. The one way to tell them apart is the
     node address, and if it is not written down then the most dangerous
     question, "is this definitely not real money?", has no answer. */
  let chainId = null;
  try { chainId = Number(BigInt(await rpc('eth_chainId'))); } catch (_) {}
  const where = IS_DEFAULT_RPC ? 'the live node' : 'OWN NODE · ' + RPC_URL;
  console.log('  ' + where + (chainId ? '  · network ' + chainId : ''));
  if (!IS_DEFAULT_RPC && chainId && chainId !== C.CHAIN.id) {
    console.log('  ⚠ Network ' + chainId + ' is not Robinhood Chain (' + C.CHAIN.id + ').');
    console.log('    For a fork that is normal if anvil was started without --chain-id;');
    console.log('    the contracts are real, copied from the live network.');
  }
  await loadConfig();
  if (fromDb.size) {
    console.log('  from the database: ' + [...fromDb].join(', ') + ', entered in the console');
  }

  /* The mode is decided HERE, after the database: the token address comes
     from there, which means a contract entered in the console switches
     live mode on by itself, on the very next epoch. */
  const { live: LIVE, why: whyMode } = decideLive(chainId);
  console.log('  ' + (LIVE ? 'LIVE MODE' : 'dry run, nothing gets signed')
              + ': ' + whyMode);
  if (LIVE && IS_DEFAULT_RPC) {
    console.log('  ⚠ The transactions will go out for real, on real money.');
  }

  if (!C.isAddress(CFG.token)) {
    console.log('\n  The token address is not set. While it is missing there is');
    console.log('  nothing to compute: that is the off switch.');
    console.log('  It is entered in the console, where the site sees it too.');
    console.log('  To override for one pass: APEX_TOKEN=0x…');
    return { skipped: 'no token address' };
  }
  /* 1. What Pons knows about the launch and how much fee has accrued */
  const info = await launchInfo(CFG.token);
  const [pot, ourPool, gp, blk] = await Promise.all([
    poolPot(CFG.token, info), poolFor(CFG.token), gasPrice(), head(),
  ]);

  head2('accrued on the locked position');
  line('for the payout, ether', eth(pot.ethWei) + ' ETH');
  line('arrived in our own token', nf(Number(pot.tokenWei) / 1e18, 0) + ', to be burned');
  line('the fee goes to', info.feeTo);
  line('venue share', info.venueShare + '%  · ours ' + (100 - info.venueShare) + '% of what is collected');
  line('pool fee tier', (info.poolFee / 10_000) + '%');
  line('our pool', ourPool.pool + '  (tier ' + feeLabel(ourPool.fee) + ')');
  line('liquidity position', '# ' + nf(info.positionId) + ', locked forever');
  line('gas price', (Number(gp) / 1e9).toFixed(5) + ' gwei');
  line('block', nf(blk));

  /* =======================================================================
     TWO WALLETS, AND THAT IS ON PURPOSE

     The crank used to compute the epoch from what had accrued on the
     locked position, and it required the fee recipient to be itself:
     otherwise collectFees from it would not go through.

     Now it is the other way round, and that is better:

       the fee wallet       receives everything from the pool. Only the
                            owner has the key; the crank does not see it
                            and cannot touch it.
       the working wallet   holds a small float for buys and gas. The crank
                            has its key.

     The owner collects the fee himself and decides himself how much to
     move to the working wallet. The epoch is computed from THE BALANCE ON
     THE WORKING WALLET, not from what has accrued on the pool.

     What this buys: a leak of the crank's key costs exactly what lies on
     the working wallet, not the whole accrued fee. The loss is capped by
     the size of the float, and it is capped not by an agreement but by the
     fact that the crank has no second key.

     And the contract itself holds this split up: collectFees admits only
     the locker owner, the launcher and the recipient. The working wallet
     is in none of those roles, so the crank physically cannot take the
     fee, even if it wanted to.
     ======================================================================= */

  /* The operator address is checked before we ask the node about it.

     Without this check the crank got all the way to the end of the
     collection and fell over with a raw node error: "eth_getBalance:
     invalid argument 0: hex string has length 0". There is no way to tell
     from that that an environment variable is simply not set, and under
     the new scheme the operator is Alexander's personal wallet, which is
     the easiest thing to forget on the first run.

     A refusal has to name the reason and the fix, not somebody else's RPC
     error code. */
  if (!C.isAddress(CFG.operator)) {
    console.log('\n  The working wallet address is not set.');
    console.log('  This is the wallet the crank buys the basket from and hands it');
    console.log('  out to holders from: it has to hold a supply of ether for gas.');
    console.log('\n  It is entered in the console, section "working wallet · gas".');
    console.log('  The console will also show how many epochs the balance covers.');
    console.log('  To override for one pass: APEX_OPERATOR=0x…');
    return { skipped: 'no operator address' };
  }

  const float = await ethBalance(CFG.operator);

  head2('working wallet');
  line('address', CFG.operator);
  line('balance', eth(float) + ' ETH');

  /* An empty wallet is now an ordinary thing, not an exception.

     The fee used to land on this same address and top it up by itself.
     Under the new scheme Alexander puts the ether in by hand, which means
     the supply will run out one day, and between "ran out" and "noticed"
     the epochs will simply stop closing, silently. The threshold is
     computed from the cost of one settlement. */
  if (float === 0n) {
    console.log('\n  ⚠ The operator wallet is empty. The crank will be able neither');
    console.log('    to buy the basket nor to hand it out: the epochs will pile up in');
    console.log('    the pool but not close. Top it up before the launch.');
  }
  line('the fee accrues on', info.feeTo
    + (info.feeTo.toLowerCase() === CFG.operator.toLowerCase()
       ? '  ⚠ this is the same wallet' : ''));

  /* Two wallets coinciding is not an error, but it is not what all this
     was written for either: the whole point of the split is that the
     crank's key controls only the float. We say it out loud instead of
     deciding for the person. */
  if (info.feeTo.toLowerCase() === CFG.operator.toLowerCase()) {
    console.log('\n  ⚠ The fee drips onto the same wallet whose key the crank holds.');
    console.log('    It will work, but a leak of the key then costs the whole accrued');
    console.log('    fee, not just the working float. To split them: setFeeRedirect.');
  }

  /* 2. Who is in. Supply comes from the contract: a constant in the code
        will one day diverge from the chain, and the percentages will drift
        silently. */
  const supply = await supplyOf(CFG.token);
  const floor = supply * 0.0001;
  const snap = await holders(CFG.token, floor);
  const hs = snap.holders;

  /* 3. What to buy */
  const basket = await C.readBasket();

  /* 4. The decision.

     The address of our pool goes into the exclusions on its own line, and
     that is no small thing. In V4 all the network's liquidity sat in one
     singleton contract, which was on the list anyway. In V3 every pair has
     its own contract, and it holds almost the whole supply: on the very
     first run of the previous version the pool turned out to be the
     largest recipient with a 5.9% share. To pay the pool is to make a gift
     to the exchange, and the payout will report success while doing it. */
  const plan = planEpoch({
    /* The epoch is computed from the balance on the working wallet. What
       has accrued on the position (pot) is shown above for reference: the
       owner collects it, the crank does not reach that far. */
    potWei: float,
    basket: basket.basket,
    holders: hs,
    gasPriceWei: gp,
    supply,
    operator: CFG.operator,
    token: CFG.token,
    exclude: [...NOT_HOLDERS, ourPool.pool, info.feeTo, info.deployer],
  });

  head2('who is in');
  line('snapshot at block', nf(snap.block));
  line('supply from contract', nf(supply));
  line('listed by the explorer', nf(snap.listed));
  line('with a non-zero balance', nf(hs.length) +
       '   (' + nf(snap.listed - hs.length - snap.failed) + ' have already sold out)' +
       (snap.failed ? ' · NOT READ ' + nf(snap.failed) : ''));
  line('sum of their balances', nf(Math.round(hs.reduce((a, h) => a + h.balance, 0))) +
       '  (' + (hs.reduce((a, h) => a + h.balance, 0) / supply * 100).toFixed(2) + '% of supply)');
  line('floor', nf(plan.floor) + ' coins (0.01% of supply)');
  line('pass the floor', nf(plan.recipients));
  line('excluded', nf(plan.excluded) + '  (pools, operator, the token itself, burn addresses)');
  line('eligible supply', nf(plan.eligibleSupply) + '  (' + (plan.eligibleRatio * 100).toFixed(2) + '% of the whole)');

  head2('what the settlement will cost');
  line('transfers', nf(plan.transfers) + '  (' + nf(plan.recipients) + ' × ' + basket.basket.length + ')');
  line('gas', nf(gasForEpoch(plan.recipients)));
  line('cost', eth(plan.costWei) + ' ETH');
  line('needed with margin', eth(plan.needWei) + ' ETH');

  /* The snapshot must be complete. Shares are computed off the sum of the
     balances, and if part of it did not read, every share is computed off
     the wrong total: the payout drifts apart silently, and there will be
     nothing to take it back with. */
  if (!snap.complete) {
    console.log('\n  The epoch is NOT closing: ' + (snap.why ||
      ('the snapshot is incomplete, ' + nf(snap.failed) + ' balances out of ' + nf(snap.listed) + ' were not read')) + '.');
    console.log('  To pay out on an incomplete list is to compute the shares of');
    console.log('  others off the wrong total. We wait for the node to answer fully.');
    return { settled: false, plan, incomplete: true };
  }

  if (!plan.settle) {
    console.log('\n  The epoch is NOT closing: ' + plan.why + '.');
    console.log('  Three hours is a floor, not a length: we keep accruing.');
    return { settled: false, plan };
  }

  /* The ten quotes go at once, not one after another: each of them climbs
     into the chain for the list of pools and polls them, and sequentially
     that is minutes.

     A FALSE TRAIL, SO NOBODY LOOKS FOR IT TWICE. On the fork on August 31
     all ten quotes failed with "nowhere to buy", and I decided the volley
     was at fault and broke it into threes. It did not help: the same
     quotes failed one at a time too. The culprit was the COLD fork: anvil
     pulls pool state from the live network as it is needed, and the V3
     quoter walks ticks in batches of slots, so on the very first walk part
     of the requests return an error instead of data. Ask for a quote on a
     penny once, the fork pulls the state in, and after that everything
     computes. On a live node the state is always warm, and the question
     does not arise.

     Hence the rule for a fork: warm up the pools with tiny quotes before a
     live pass. Written down in FORK.md. */
  head2('what it will buy');
  const quotes = await Promise.all(plan.seats.map(s =>
    quote({ token: s.address, amountWei: s.spendWei,
            priceNative: s.priceNative, pairId: s.pairId,
            ethPairIds: s.ethPairIds || [] })
      .then(q => ({ s, q })).catch(e => ({ s, err: e.message || String(e) }))));

  for (const { s, q, err } of quotes) {
    const got = err
      ? '→ nowhere to buy: ' + err
      : '→ ' + nf(Number(q.out) / 1e18, 2) + ' ' + s.sym +
        '   ' + q.venue + ' ' + feeLabel(q.fee) +
        (q.alternatives ? ', ' + q.edge.toFixed(2) + '% better than the next of ' + (q.alternatives + 1)
                        : ', only one usable pool');
    console.log('  ' + s.sym.padEnd(14) + eth(s.spendWei) + ' ETH  ' + got);
  }

  /* A seat with nowhere to buy.

     What used to stand here was a warning and nothing else: the share of
     such a seat hung on the operator's wallet, not handed to holders and
     not returned. Now it is split between the other seats of the same
     epoch.

     Carrying it into the next epoch was the second option and was
     rejected: it requires keeping a remainder between runs, and the money
     sits idle all that time. Splitting it today is more honest and easier
     to check. */
  const blind = quotes.filter(x => x.err);
  if (blind.length) {
    const names = new Set(blind.map(x => x.s.sym));
    const r = redistribute(plan.seats, names);
    plan.seats = r.seats;
    console.log('\n  ⚠ Seats with no pool: ' + blind.length + ' of ' + r.seats.length +
                ': ' + blind.map(x => x.s.sym).join(', ') + '.');
    if (r.live) {
      console.log('    Their share (' + eth(r.moved) + ' ETH) is split between the other ' +
                  r.live + '. The buys below already account for the split.');
    } else {
      console.log('    Not one seat has a usable pool: there is nothing to buy,');
      console.log('    the epoch does not close.');
    }
  }

  head2('who it will pay');
  plan.payout.slice(0, 8).forEach(p =>
    console.log('  ' + p.address + '  ' + (p.share * 100).toFixed(4) + '%'));
  if (plan.payout.length > 8) console.log('  … and another ' + nf(plan.payout.length - 8));

  if (!LIVE) {
    console.log('\n  Dry run: not a single transaction was sent.');
    console.log('  Reason: ' + whyMode + '.');
    return { settled: false, dry: true, plan };
  }

  /* =======================================================================
     THE LIVE PART

     Everything above only read and computed. From here on transactions get
     signed, and the order here is not decoration but the only protection.

     Signing and the journal are loaded HERE and not at the top of the
     file, on purpose: `send.js` pulls in ethers, `journal.js` pulls in pg.
     The dry run has to work on bare node, otherwise people stop running it
     on a fresh machine, and it is the main instrument.
     ======================================================================= */
  const { Sender, operatorFrom, callWrap, callApprove, callTransfer,
          callSwapExactIn, callSwapV4 } = await import('./send.js');
  const J = await import('./journal.js');

  /* The key has to belong to the declared operator. Had they diverged, the
     crank would compute shares off the balance of one wallet and pay from
     another, and that would be noticed on the first transfer where the
     money ran out, that is, in the middle of the payout. */
  const wallet = operatorFrom(CFG.key, CFG.operator);
  const sender = new Sender(wallet, { dry: false });
  await sender.start();

  const { run, resumed, done, pending } = await J.openRun({
    token: CFG.token, potWei: plan.potWei ?? null, operator: CFG.operator });

  /* A run cut off halfway is not a rarity but the norm: the node goes
     quiet, the process gets killed, the gas runs out. Continuing blind is
     not allowed. */
  if (pending.length) {
    console.log('\n  The previous run was cut off, steps in the unknown: ' + pending.length);
    for (const step of pending) {
      const v = await J.resolveStep(step, CFG.operator);
      console.log('    ' + step.key + ' → ' + v.verdict + (v.why ? ' (' + v.why + ')' : ''));
      if (v.verdict === 'mined') done.add(step.key);
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
  const step = (key, call) => J.runStep(run.id, key, () => sender.send(call), opts);

  /* --- 1. Wrapping and the approval, only if there are buys through V3 ---

     On V4 we pay with native ether right inside the swap transaction:
     neither wrapping nor approvals are needed there. On V3 the router can
     only do ERC-20, so the ether has to be wrapped and permitted to be
     spent.

     Exactly as much is wrapped as will go to V3. Wrapping everything would
     lock in WETH the money that is paid with on V4 as well. */
  const live = quotes.filter(x => !x.err && x.s.spendWei > 0n);
  const v3 = live.filter(x => x.q.venue === 'v3');
  const v3Total = v3.reduce((a, x) => a + x.s.spendWei, 0n);

  if (v3Total > 0n) {
    head2('wrapping');
    await step('wrap', callWrap(v3Total));
    console.log('  wrapped ' + eth(v3Total) + ' ETH');
    await step('approve:weth', callApprove(ADDR.weth, ADDR.swapRouter, v3Total));
    console.log('  the router is allowed to spend exactly this amount');
  }

  /* --- 2. The buys ---

     Slippage tolerance: three percent. The quote was taken seconds ago,
     but between it and execution other people's trades get into the pool.
     Zero here would mean the epoch falls apart from anyone else's buy;
     a lot would mean we get swapped at any price. */
  head2('buying');
  const SLIP = 97n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const bought = [];

  for (const { s, q } of live) {
    const minOut = (q.out * SLIP) / 100n;
    let call;
    try {
      call = q.venue === 'v4'
        ? callSwapV4({ key: q.key, token: s.address, amountIn: s.spendWei, minOut, deadline })
        : callSwapExactIn({ tokenIn: ADDR.weth, tokenOut: s.address, fee: q.fee,
                            recipient: CFG.operator, amountIn: s.spendWei, minOut });
    } catch (e) {
      /* A pool we do not know how to walk through (one with a hook, for
         instance) shows up here and not later. The seat stays without a
         purchase. */
      console.log('  ' + s.sym.padEnd(14) + 'skipped: ' + (e.message || e));
      continue;
    }
    const r = await step('swap:' + s.sym, call);
    console.log('  ' + s.sym.padEnd(14) + (r.skipped ? 'already bought earlier' : r.hash));
    bought.push(s);
  }

  if (!bought.length) {
    await J.closeRun(run.id, 'empty', 'not a single buy worked out');
    console.log('\n  Not one buy worked out, there is nothing to hand out.');
    return { settled: false, plan };
  }

  /* --- 3. The payout ---

     What gets handed out is WHAT LIES ON THE WALLET, not what the quote
     promised. The difference between them is slippage, and handing out by
     the quote means promising more than was bought: the last one comes up
     short, and the whole epoch reverts on him.

     splitByBalance divides in whole numbers, the sum adds up exactly. */
  head2('handing out');
  /* The name `payees` and not `holders`, and that is not a matter of taste.

     `const holders = …` stood here, and it shadowed the function of the
     same name imported from read.js, for the WHOLE of tick(), because a
     `const` is visible throughout the body of the function from the first
     line. Because of that the call `await holders(CFG.token, floor)` two
     hundred lines above failed with "Cannot access 'holders' before
     initialization", and it failed in the dry run too: it never got as far
     as the payout.

     That is, the crank could not close a single epoch, live or idle.
     Caught by the very first fork run on August 31; not one of the 156
     checks saw it, because they all call the parts separately, and not one
     of them runs tick() whole. */
  const payees = plan.payout.filter(h => h.raw);
  for (const s of bought) {
    const have = await erc20Balance(s.address, CFG.operator);
    if (have === 0n) { console.log('  ' + s.sym.padEnd(14) + 'zero on the wallet, skipping'); continue; }
    const parts = splitByBalance(have, payees);
    let sent = 0;
    for (let i = 0; i < payees.length; i++) {
      if (parts[i] === 0n) continue;
      const r = await step('xfer:' + s.sym + ':' + payees[i].address.toLowerCase(),
                           callTransfer(s.address, payees[i].address, parts[i]));
      if (!r.skipped) sent++;
    }
    console.log('  ' + s.sym.padEnd(14) + nf(Number(have) / 1e18, 2) + ' to ' + sent + ' wallets');
  }

  await J.closeRun(run.id, 'ok', null);
  console.log('\n  The epoch is closed. Run #' + run.id +
              ', gas spent ' + eth(sender.spentWei()) + ' ETH.');
  return { settled: true, plan, runId: run.id };
}

/* ---------- the schedule ---------- */

async function once() {
  try { await tick(); }
  catch (e) { console.error('\n  The pass failed: ' + (e.message || e)); }
}

if (WATCH) {
  console.log('The crank is running. Checking every ' + C.MODEL.epochHours + ' h.');
  await once();
  setInterval(once, EVERY_MS);
} else {
  await once();
}
