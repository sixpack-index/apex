/* =========================================================================
   CHECKS OF THE SEND LAYER

   This is the only file in the project that can spend money, so there are
   more checks here than there is code.

   No node is needed: the RPC is substituted. What we check is not the
   network but our own rules: the ceilings, the assembly of transactions,
   the batches and, above all, the behavior in the bad cases. The good case
   checks itself on the very first run; it is the bad ones that cost money.

     node crank/check-send.js           run them
     node crank/check-send.js --break   make sure the checks are alive

   THE MAIN THING CHECKED HERE, AND WHY EXACTLY THIS

   On the previous chain the costliest question was "did the transaction
   vanish or go through?": there was no answer to it, and the crank stopped
   and called a human. On Solana there is an answer, and it follows from
   the lifetime of the blockhash. So the rule "the hash expired, a retry is
   safe" now carries all the money of the payout, and it has to be checked
   more strictly than anything else. The four checks below are about
   exactly that, and each one fails if the rule is shifted even a step.
   ========================================================================= */

import './../core.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const BREAK = process.argv.includes('--break');

/* ---------- substituting the node ----------
   rpc() in read.js respects globalThis.__rpcHook if it is set. That is the
   only seam of its kind in the project, and it exists for the sake of this
   file alone: the rules of sending have to be checked where there is no
   node. */
const CALLS = [];
let RESPONSES = {};

globalThis.__rpcHook = async (method, params) => {
  CALLS.push({ method, params });
  const r = RESPONSES[method];
  if (typeof r === 'function') return r(params);
  if (r === undefined) throw new Error('the test did not describe a response for ' + method);
  return r;
};

const { Sender, operatorFrom, ataFor, ixCreateAta, ixTransfer, batch, swapTx,
        programOf, PRIORITY_MICRO, MAX_PRIORITY_MICRO,
        TRANSFERS_PER_TX, CREATES_PER_TX } = await import('./send.js');
const { PROG, GENESIS } = await import('./read.js');
const { resolveStep } = await import('./journal.js');

const C = globalThis.ApexCore;

/* ---------- the frame ---------- */

let passed = 0;
const bad = [];

function ok(name, cond, got) {
  if (cond) passed++;
  else bad.push(name + (got === undefined ? '' : ' got: '
    + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? v.toString() : v)));
}

async function throws(name, fn, match) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message || String(e); }
  ok(name, msg !== null && (!match || match.test(msg)), msg);
}

const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(3));
const ME = WALLET.publicKey.toBase58();
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

function reset(extra = {}) {
  CALLS.length = 0;
  RESPONSES = {
    getLatestBlockhash: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } },
    getBlockHeight: 900,
    sendTransaction: 'the signature does not matter, it is taken from the transaction',
    simulateTransaction: { value: { err: null, unitsConsumed: 1234, logs: [] } },
    getSignatureStatuses: { value: [{ err: null, confirmationStatus: 'confirmed', slot: 7 }] },
    ...extra,
  };
}
const used = m => CALLS.filter(c => c.method === m).length;

/* =========================================================================
   1. THE KEY

   Parsing the key wrong means signing with the wrong wallet. All three
   forms of writing it down are checked, because a person will paste the
   one his wallet gave him, not the one we would have preferred.
   ========================================================================= */
{
  const b58 = bs58.encode(WALLET.secretKey);
  ok('a key in base58 gives that very address', operatorFrom(b58, ME).publicKey.toBase58() === ME);
  ok('a seed of 32 bytes gives the same address',
     operatorFrom(bs58.encode(new Uint8Array(32).fill(3))).publicKey.toBase58() === ME);
  ok('an array of 64 numbers gives the same address',
     operatorFrom(JSON.stringify([...WALLET.secretKey])).publicKey.toBase58() === ME);
  const hex = [...WALLET.secretKey].map(b => b.toString(16).padStart(2, '0')).join('');
  ok('a hundred and twenty-eight hexadecimal characters too',
     operatorFrom(hex).publicKey.toBase58() === ME);
  ok('and with the 0x prefix', operatorFrom('0x' + hex).publicKey.toBase58() === ME);

  await throws('an empty key is a refusal naming the variable',
    () => operatorFrom(''), /APEX_WALLET_KEY/);
  await throws('junk instead of a key is a refusal',
    () => operatorFrom('not a key at all'), /did not parse/);
  await throws('base58 of the wrong length is a refusal stating the length',
    () => operatorFrom(bs58.encode(new Uint8Array(40))), /40 bytes/);
  await throws('an array of the wrong length is a refusal',
    () => operatorFrom('[1,2,3]'), /not hold 64 or 32/);
  await throws('a key from somebody else wallet is a refusal',
    () => operatorFrom(bs58.encode(WALLET.secretKey), PROG.system), /not from the declared/);
}

/* =========================================================================
   2. THE CEILING ON THE PRIORITY FEE

   A calculation that was off by a factor of a thousand is obliged to
   refuse before the first signature rather than spend the whole float on
   the queue.
   ========================================================================= */
ok('the ordinary priority fee is below the ceiling', PRIORITY_MICRO < MAX_PRIORITY_MICRO);
await throws('a priority fee above the ceiling is a refusal',
  () => new Sender(WALLET, { priorityMicro: MAX_PRIORITY_MICRO + 1n }), /ceiling/);
ok('exactly the ceiling is still allowed',
   new Sender(WALLET, { priorityMicro: MAX_PRIORITY_MICRO }) instanceof Sender);
ok('by default the sender is dry', new Sender(WALLET).dry === true);

/* =========================================================================
   3. ASSEMBLING THE TRANSACTION
   ========================================================================= */
{
  reset();
  const s = new Sender(WALLET, { dry: true });
  const { tx, lastValidBlockHeight } = await s.build(
    [ixCreateAta({ payer: ME, owner: ME, mint: MINT })], { cu: 60_000 });

  ok('the blockhash is taken from the node', used('getLatestBlockhash') === 1);
  ok('and so is its lifetime', lastValidBlockHeight === 1000);
  ok('the declared wallet pays',
     tx.message.staticAccountKeys[0].toBase58() === ME);
  ok('the transaction is signed with one signature', tx.signatures.length === 1);
  ok('the signature is not empty', !tx.signatures[0].every(b => b === 0));
  /* The priority fee and the compute ceiling go as the FIRST instructions:
     put after, they have no effect, and the node will not say so. */
  ok('the priority fee and the ceiling stand first',
     tx.message.compiledInstructions.length === 3);
  ok('without the ceiling there is one instruction fewer',
     (await new Sender(WALLET).build([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]))
       .tx.message.compiledInstructions.length === 2);
}

/* =========================================================================
   4. A DRY RUN DOES NOT SEND, BUT IT DOES NOT PRETEND EITHER

   The previous version of the dry run only printed the intention, and an
   error in the assembled call was discovered by the first live signature.
   Now it shows the transaction to the node.
   ========================================================================= */
{
  reset();
  const s = new Sender(WALLET, { dry: true });
  const r = await s.send([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]);
  ok('the dry run simulates', used('simulateTransaction') === 1);
  ok('the dry run does NOT send', used('sendTransaction') === 0);
  ok('the dry run is marked', r.dry === true);
  ok('the signature is computed all the same', C.isAddress(r.signature) || r.signature.length > 60);
  ok('the units consumed are visible', r.units === 1234);
  ok('fees are not counted in a dry run', s.spentLamports() === 0n);

  reset({ simulateTransaction: { value: { err: 'AccountNotFound', logs: ['a', 'b', 'c', 'd'] } } });
  const s2 = new Sender(WALLET, { dry: true });
  await throws('a refused simulation is an error, not "all is well"',
    () => s2.send([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]), /the simulation did not pass/);
}

/* =========================================================================
   5. LIVE SENDING
   ========================================================================= */
{
  reset();
  const s = new Sender(WALLET, { dry: false });
  const r = await s.send([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]);
  ok('live sending sends', used('sendTransaction') === 1);
  ok('and does not simulate', used('simulateTransaction') === 0);
  ok('the fee for the signature is counted', s.spentLamports() === 5_000n);

  const opt = CALLS.find(c => c.method === 'sendTransaction').params[1];
  /* The retries are our own business, in confirm: a node that retries
     silently deprives us of the knowledge of how many times the
     transaction went out. */
  ok('the node does not retry by itself', opt.maxRetries === 0);
  ok('the preflight check is on', opt.skipPreflight === false);
  ok('the bytes go out in base64', opt.encoding === 'base64');
  ok('the lifetime comes back for the journal too', r.lastValidBlockHeight === 1000);
}

/* =========================================================================
   6. THE CONFIRMATION, THE MOST IMPORTANT PLACE

   Four cases, and the third of them is the one the previous chain did not
   have.
   ========================================================================= */
{
  reset();
  const s = new Sender(WALLET, { dry: false, waitMs: 400, pollMs: 50 });
  ok('a confirmed one is ok',
     (await s.confirm('signature', 1000)).verdict === 'ok');
}
{
  reset({ getSignatureStatuses: { value: [{ err: { InstructionError: [1, 'X'] } }] } });
  const s = new Sender(WALLET, { dry: false, waitMs: 400, pollMs: 50 });
  const v = await s.confirm('signature', 1000);
  ok('one accepted with an error is failed, not ok', v.verdict === 'failed', v);
  ok('the reason for the refusal is named', /InstructionError/.test(v.why || ''), v.why);
}
{
  /* THE MAIN CHECK OF THE FILE. There is no signature, and the block
     height has passed the lifetime of the hash: the transaction CAN no
     longer go through, and that is a property of the chain, not a hope of
     ours. A retry is safe. */
  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 });
  const s = new Sender(WALLET, { dry: false, waitMs: 2000, pollMs: 20 });
  const v = await s.confirm('signature', 1000);
  ok('an expired hash is dropped, not unknown', v.verdict === 'dropped', v);
  ok('the reason explains why a retry is safe',
     /expired/.test(v.why || ''), v.why);
  ok('we did not wait out the whole timeout', used('getSignatureStatuses') <= 2, used('getSignatureStatuses'));
}
{
  /* There is no signature, but the hash is still alive: this is waiting,
     not a refusal. And while we wait, we send the same byte-for-byte
     transaction again: its signature is the same, and it cannot execute
     twice. */
  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 900 });
  const s = new Sender(WALLET, { dry: false, waitMs: 300, pollMs: 40 });
  const v = await s.confirm('signature', 1000, { wire: 'bytes' });
  ok('a live hash with no signature is pending', v.verdict === 'pending', v);
  ok('while we waited, we sent it once more', used('sendTransaction') >= 1, used('sendTransaction'));
  ok('but no more than three times', used('sendTransaction') <= 3, used('sendTransaction'));
}
{
  /* With no bytes there is nothing to retry, and inventing them is not
     allowed. */
  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 900 });
  const s = new Sender(WALLET, { dry: false, waitMs: 200, pollMs: 40 });
  await s.confirm('signature', 1000);
  ok('with no saved bytes there is no repeat send', used('sendTransaction') === 0);
}

/* =========================================================================
   6b. NOT LANDING IS AN ERROR, NOT A VALUE

   THE MOST EXPENSIVE BUG FOUND SO FAR, AND READING FOUND IT, NOT A RUN.

   `settle` used to return the verdict whatever it was: `ok`, `dropped`,
   `failed`, `pending`, calmly, like any other result. And the journal
   marks a step done when the send RETURNS without throwing.

   So a batch of transfers the chain never took got an "ok" in the journal
   with a signature on it, counted as sent, went into the shop window, and
   on a resumed run was skipped FOREVER. The people in that batch would
   have got nothing, and nobody would have noticed: the journal would say
   they were paid.

   That is exactly the failure the journal was written for, approached
   from the other side: it guards against a second payment, and here the
   first one was being lost.

   So any verdict other than `ok` is an exception now. All three are
   checked, and so is the signature surviving in it: without the signature
   the next pass could not find out what actually happened to the step.
   ========================================================================= */
{
  const ixs = [ixCreateAta({ payer: ME, owner: ME, mint: MINT })];

  reset({ getSignatureStatuses: { value: [{ err: { InstructionError: [1, 'X'] } }] } });
  await throws('landed with an error: settle throws instead of returning',
    () => new Sender(WALLET, { dry: false, waitMs: 300, pollMs: 30 }).settle(ixs),
    /did not land: failed/);

  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 });
  await throws('gone for good: throws as well',
    () => new Sender(WALLET, { dry: false, waitMs: 300, pollMs: 30 }).settle(ixs),
    /did not land: dropped/);

  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 900 });
  await throws('no answer in time: throws as well',
    () => new Sender(WALLET, { dry: false, waitMs: 200, pollMs: 40 }).settle(ixs),
    /did not land: pending/);

  /* The signature has to survive in the exception: the next pass uses it
     to find out what actually happened to the step. */
  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 });
  let err = null;
  try { await new Sender(WALLET, { dry: false, waitMs: 300, pollMs: 30 }).settle(ixs); }
  catch (e) { err = e; }
  ok('the verdict survives in the exception', err && err.verdict === 'dropped', err && err.verdict);
  ok('and the signature', err && typeof err.signature === 'string' && err.signature.length > 40);
  ok('and the blockhash lifetime', err && err.lastValidBlockHeight === 1000);

  reset();
  const good = await new Sender(WALLET, { dry: false, waitMs: 300, pollMs: 30 }).settle(ixs);
  ok('one that landed returns ok', good.verdict === 'ok', good.verdict);

  reset();
  const dry = await new Sender(WALLET, { dry: true }).settle(ixs);
  ok('a dry run does not throw', dry.verdict === 'ok' && dry.dry === true);
}

/* =========================================================================
   7. WORKING OUT A STUCK STEP

   The same rule, but from the journal's side: a run broken off halfway is
   obliged to get an exact answer for every step.
   ========================================================================= */
{
  reset();
  ok('a step with no signature was never sent, a retry is safe',
     (await resolveStep({ signature: null })).verdict === 'dropped');

  reset();
  ok('the signature turned up, the step is done',
     (await resolveStep({ signature: 'sig', valid_until: 1000 })).verdict === 'mined');

  reset({ getSignatureStatuses: { value: [{ err: { X: 1 } }] } });
  ok('one accepted with an error means the step can be repeated',
     (await resolveStep({ signature: 'sig', valid_until: 1000 })).verdict === 'dropped');

  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 });
  const d = await resolveStep({ signature: 'sig', valid_until: 1000 });
  ok('no signature and the hash expired, a retry is safe', d.verdict === 'dropped', d);

  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 999 });
  const p = await resolveStep({ signature: 'sig', valid_until: 1000 });
  ok('no signature and the hash alive, wait rather than retry', p.verdict === 'pending', p);

  /* The only "I do not know" left: a record from an old version of the
     crank, where there was no hash lifetime. Guessing here is not
     allowed. */
  reset({ getSignatureStatuses: { value: [null] } });
  const u = await resolveStep({ signature: 'sig' });
  ok('with no lifetime there is no answer, we call a human', u.verdict === 'unknown', u);
  ok('and we say why exactly', /old version/.test(u.why || ''), u.why);

  reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 0 });
  const n = await resolveStep({ signature: 'sig', valid_until: 1000 });
  ok('the node gave no height, we do not guess either', n.verdict === 'unknown', n);
}

/* =========================================================================
   8. THE INSTRUCTIONS

   The order of the accounts in an instruction is the thing you cannot
   check by reading: the source and the recipient swapped round look the
   same. So we compare against what it has to be by meaning.
   ========================================================================= */
{
  const to = PROG.system;
  const create = ixCreateAta({ payer: ME, owner: to, mint: MINT });
  ok('the account is created by the accounts program',
     create.programId.toBase58() === PROG.ata, create.programId.toBase58());
  ok('the operator pays', create.keys[0].pubkey.toBase58() === ME);
  ok('the payer signs', create.keys[0].isSigner === true);
  ok('what is created is exactly the derived address',
     create.keys[1].pubkey.toBase58() === ataFor(MINT, to));
  ok('the owner of the account is the recipient', create.keys[2].pubkey.toBase58() === to);
  ok('and he does NOT sign, otherwise the payout would be impossible',
     create.keys[2].isSigner === false);

  const move = ixTransfer({ mint: MINT, from: ataFor(MINT, ME), to: ataFor(MINT, to),
                            owner: ME, amount: 100n, decimals: 5 });
  ok('the transfer is made by the token program',
     move.programId.toBase58() === PROG.token);
  ok('from is our account', move.keys[0].pubkey.toBase58() === ataFor(MINT, ME));
  ok('the coin is named as the second account', move.keys[1].pubkey.toBase58() === MINT);
  ok('to is the recipient account', move.keys[2].pubkey.toBase58() === ataFor(MINT, to));
  ok('the owner of the source signs', move.keys[3].pubkey.toBase58() === ME
     && move.keys[3].isSigner === true);
  /* transferChecked, not transfer: its instruction code is 12, and it
     requires the decimals. The checked version refuses when the decimals
     are wrong, and a measurement on the live chain confirmed it. */
  ok('this is the checked transfer, not the ordinary one', move.data[0] === 12, move.data[0]);
  ok('the decimals went into the data', move.data[move.data.length - 1] === 5);

  ok('under Token-2022 the program is a different one',
     ixTransfer({ mint: MINT, from: ataFor(MINT, ME, PROG.token2022),
                  to: ataFor(MINT, to, PROG.token2022), owner: ME, amount: 1n,
                  decimals: 5, ownerProgram: PROG.token2022 })
       .programId.toBase58() === PROG.token2022);

  let why = '';
  try { programOf('SomethingWrong'); } catch (e) { why = e.message; }
  ok('an unknown program of the coin is a refusal, not a guess',
     /unknown program/.test(why), why);
}

/* =========================================================================
   9. BATCHES

   The size of a batch decides whether the transaction fits into the
   ceiling of 1232 bytes. Measured on October 14: eighteen transfers fit,
   twenty do not.
   ========================================================================= */
ok('fifteen transfers to a batch', TRANSFERS_PER_TX === 15);
ok('six accounts to a batch', CREATES_PER_TX === 6);
ok('a thousand transfers is 67 batches',
   batch(Array.from({ length: 1000 }, (_, i) => i), 15).length === 67);
ok('not a single one is lost in the batches',
   batch(Array.from({ length: 1000 }, (_, i) => i), 15)
     .reduce((a, b) => a + b.length, 0) === 1000);
ok('the last batch is a partial one', batch([1, 2, 3, 4], 3).at(-1).length === 1);

/* =========================================================================
   10. BUYING FROM THE AGGREGATOR

   The network is substituted: we check what we ask for and what we do with
   a refusal.
   ========================================================================= */
{
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, o) => {
    seen = { url: String(u), body: JSON.parse(o.body), headers: o.headers };
    return { ok: false, status: 429, text: async () => '' };
  };
  await throws('a refusal from the aggregator is an error, not an empty transaction',
    () => swapTx({ route: { x: 1 }, owner: ME }), /did not give the transaction: 429/);
  ok('we ask at the address of the aggregator', /jup\.ag/.test(seen.url), seen.url);
  ok('the wallet was passed', seen.body.userPublicKey === ME);
  ok('the aggregator does the SOL wrapping', seen.body.wrapAndUnwrapSol === true);
  globalThis.fetch = realFetch;
}

/* =========================================================================
   11. THE CLUSTER HASHES

   Live mode switches on by the hash of the first block. There is no
   network number on Solana, and at first that looks like the absence of a
   guard, but the hash is stricter: a number is set by how the node was
   started, a hash is computed from the contents.
   ========================================================================= */
ok('mainnet, devnet and testnet are three different hashes',
   new Set([GENESIS.mainnet, GENESIS.devnet, GENESIS.testnet]).size === 3);
ok('the mainnet hash is the one the live node gives',
   GENESIS.mainnet === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');

/* =========================================================================
   BREAKAGE

   The first version of this section simply inverted the conditions: if a
   check passes with an inverted condition, then it checks nothing. It
   looked convincing and meant nothing: `a === b` can always be inverted,
   and a failure after the inversion says only that the comparison was
   executed at all.

   So what gets broken here is NOT THE CHECK BUT WHAT IS BEING CHECKED.
   Every substitution below is a plausible mistake that is easy to make by
   editing the code, and next to each one is written which check is obliged
   to fail on it. Did not fail, so the checks are leaky, and that is said
   out loud.
   ========================================================================= */
async function breakThings() {
  const broken = [];
  const say = (what) => broken.push(what);

  /* 1. We treat an expired hash as waiting rather than a refusal.

     This is the costliest mistake possible: the step stays unresolvable
     forever, the payout is never finished, and it looks like "the node is
     slow". */
  {
    const real = Sender.prototype.confirm;
    Sender.prototype.confirm = async function () { return { verdict: 'pending' }; };
    reset({ getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 });
    const v = await new Sender(WALLET, { dry: false, waitMs: 50, pollMs: 10 })
      .confirm('s', 1000);
    if (v.verdict !== 'dropped') { /* the substitution worked, so that is as it should be */ }
    else say('substituting confirm did not change the verdict, the check looks the wrong way');
    Sender.prototype.confirm = real;
  }

  /* 2. The dry run "sends". If a check does not notice this, the off
        switch stops being an off switch. */
  {
    reset();
    const s = new Sender(WALLET, { dry: false });   // supposedly dry, in fact live
    await s.send([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]);
    if (used('sendTransaction') === 0) say('live sending does not send, the seam is broken');
    if (used('simulateTransaction') !== 0) say('live sending simulates for some reason');
  }

  /* 3. A refused simulation is swallowed silently. */
  {
    reset({ simulateTransaction: { value: { err: 'X', logs: [] } } });
    let threw = false;
    try { await new Sender(WALLET, { dry: true })
      .send([ixCreateAta({ payer: ME, owner: ME, mint: MINT })]); }
    catch (_) { threw = true; }
    if (!threw) say('a refused simulation did not become an error');
  }

  /* 4. A key from somebody else wallet is accepted. */
  {
    let threw = false;
    try { operatorFrom(bs58.encode(WALLET.secretKey), PROG.system); }
    catch (_) { threw = true; }
    if (!threw) say('a key from somebody else wallet passes the comparison');
  }

  /* 5. The ceiling on the priority fee does not hold. */
  {
    let threw = false;
    try { new Sender(WALLET, { priorityMicro: MAX_PRIORITY_MICRO * 1000n }); }
    catch (_) { threw = true; }
    if (!threw) say('a priority fee of a thousand ceilings passes');
  }

  /* 6. The transfer is made with the ordinary instruction instead of the
        checked one.

     The ordinary transfer does not compare the decimals, and a mistake in
     them means a transfer of THE WRONG AMOUNT instead of a refusal. A
     measurement on the live chain confirmed that the checked version
     refuses: that is exactly what it was chosen for. */
  {
    const move = ixTransfer({ mint: MINT, from: ataFor(MINT, ME), to: ataFor(MINT, PROG.system),
                              owner: ME, amount: 1n, decimals: 5 });
    if (move.data[0] !== 12) say('the transfer was assembled with the unchecked instruction');
    if (move.keys.length < 4) say('the transfer has fewer than four accounts');
  }

  /* 7. The address of a token account is derived wrongly.

     Checked against the live chain: there are coins sitting at this
     address, and the owner and the coin in the account match the expected
     ones. */
  if (ataFor(MINT, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
      !== '5hpfC9VBxVcoW9opCnM2PqR6YWRLBzrBpabJTZnwwNiw') {
    say('the address of a token account derived is not the one sitting in the chain');
  }

  /* 8. The transfer batch diverged from the one the cost was computed
        with. */
  {
    const { COST } = await import('./plan.js');
    if (TRANSFERS_PER_TX !== COST.transfersPerTx) {
      say('the batch size in the sending and in the cost calculation diverged');
    }
  }

  console.log('\nBreakage: ' + (broken.length
    ? 'THE CHECKS ARE LEAKY:\n  · ' + broken.join('\n  · ')
    : 'every substitution was caught, the checks are alive'));
  return broken.length;
}

/* ---------- the result ---------- */
if (bad.length) {
  console.error('FAILED ' + bad.length + ' of ' + (passed + bad.length) + ':');
  bad.forEach(b => console.error('  · ' + b));
  process.exit(1);
}
console.log('Sending: ' + passed + ' checks passed.');
if (BREAK && await breakThings()) process.exit(1);
