/* =========================================================================
   Signing and sending. The only file that touches the key.

   WHAT IS DIFFERENT HERE COMPARED WITH THE PREVIOUS CHAIN

   On EVM a transaction had a sequence number, the nonce, and it was the
   source of half the difficulties: the number was taken by the signing and
   not by the sending, two transactions with the same number ruled each
   other out, and a vanished transaction left a question without an answer.
   Had it not been accepted yet, or had another one with the same number
   already been accepted? The previous version of the journal honestly
   wrote "unknown" about such a step and stopped the crank, because
   continuing meant possibly paying twice.

   On Solana that question does not exist, and this is the main improvement
   of the move. A transaction is tied to a recent blockhash, and the hash
   lives about a minute (roughly 150 slots). While it is alive, the
   transaction may go through; as soon as the block height has passed
   `lastValidBlockHeight`, it CAN NEVER go through. So a vanished step has
   an exact answer rather than a guess:

     the signature turned up in the chain  → it went through
     no signature, the hash is still alive → in flight, we wait
     no signature, the hash has expired    → it did NOT go through, a
                                             retry is safe

   The third line is what EVM did not have. So there is no "unknown"
   verdict left here at all, and the crank no longer stops over a question
   that can be answered.

   ONE NODE FOR THE WHOLE CRANK

   Sending goes through the same `rpc` from read.js, not through Connection
   from the library. That is on purpose: Connection would set up a second
   path to the network with its own timeouts, its own retries and its own
   node address, and it would go around the seam for the checks
   (`globalThis.__rpcHook`). Then the send layer would only be checked
   against a live chain, which is to say it would not be checked.

   The library is used exactly where it cannot be replaced: assembling the
   message, deriving the addresses of accounts, signing. All of that is
   pure arithmetic and needs no network.
   ========================================================================= */

import './../core.js';
import bs58 from 'bs58';
import {
  Keypair, PublicKey, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { rpc, PROG, JUP, SLIPPAGE_BPS } from './read.js';
import { COST } from './plan.js';

const C = globalThis.ApexCore;

/* =========================================================================
   THE CEILINGS

   A ceiling is needed not against the greed of the network but against our
   own mistake. A calculation that put the priority fee a thousand times
   higher than needed would spend the whole float on gas and stop in the
   middle of the payout. The ceiling turns that into a refusal before the
   first signature.
   ========================================================================= */

/** The priority fee, in microlamports per compute unit. */
export const PRIORITY_MICRO = 1_000n;

/** The ceiling on the priority fee. Above it: a refusal, not a signature. */
export const MAX_PRIORITY_MICRO = 50_000n;

/* HOW MANY COMPUTE UNITS TO ASK FOR, AND WHY NOT "A BIT MORE, JUST IN
 * CASE".
 *
 * At first there was 400 000 here, with a margin, without looking. That is
 * a mistake, and a mistake you pay for: the priority fee is charged on the
 * REQUESTED ceiling, not on what was consumed. Asking for a sevenfold
 * margin means paying seven times over for the queue on every transaction
 * of the payout.
 *
 * Measured on the live chain on October 14: a transfer is about 1 900
 * units, creating an account is 14 818. Hence the ceilings below, each
 * with a twofold margin in case of a coin with Token-2022 extensions,
 * which is dearer than an ordinary one. */
export const CU_TRANSFERS = 60_000;   // 15 transfers is about 28 000
export const CU_CREATES = 120_000;    // 6 accounts is about 89 000

/** How many transfers we put into one transaction.
 *
 *  The number lives in plan.js and is taken from there instead of being
 *  repeated here: the cost calculation and the payout itself are obliged
 *  to count batches the same way. Let them diverge and the console would
 *  promise one number of transactions while the crank made another, and
 *  that would come apart silently. */
export const TRANSFERS_PER_TX = COST.transfersPerTx;

/** How many accounts we create in one transaction. Measured: twelve fit by
 *  size (1204 bytes out of 1232), but they eat 178 000 units. Six fits
 *  with a twofold margin on size and fits on compute as well. */
export const CREATES_PER_TX = 6;

/** How long we wait for a confirmation before treating the hash as expired. */
export const WAIT_MS = 90_000;

/* =========================================================================
   THE KEY

   Three forms of writing it down, and all three occur in life. We parse
   them all, because a person will paste the one his wallet gave him, not
   the one we would have preferred.
   ========================================================================= */

/**
 * A keypair out of a string. If `expected` is given, the address has to
 * match.
 *
 * The comparison is no formality. Let the key diverge from the declared
 * operator and the crank would compute the shares from the balance of one
 * wallet while paying from another, and that would get noticed on the
 * first transfer where the money ran out, which is to say in the middle of
 * the payout.
 */
export function operatorFrom(key, expected) {
  const raw = String(key || '').trim();
  if (!raw) throw new Error('the private key is not set (APEX_WALLET_KEY)');

  let bytes = null;

  /* 1. An array of 64 numbers, that is how it sits in the id.json file
        from solana-keygen. */
  if (raw.startsWith('[')) {
    let arr;
    try { arr = JSON.parse(raw); } catch (_) { arr = null; }
    if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
      throw new Error('the key looks like an array, but it does not hold 64 or 32 numbers');
    }
    bytes = Uint8Array.from(arr);
  }
  /* 2. A hundred and twenty-eight hexadecimal characters, that is, 64
        bytes. */
  else if (/^(0x)?[0-9a-fA-F]{128}$/.test(raw)) {
    const h = raw.replace(/^0x/, '');
    bytes = Uint8Array.from(h.match(/../g).map(b => parseInt(b, 16)));
  }
  /* 3. base58, the most common form, that is how wallets hand it out. */
  else {
    let d;
    try { d = bs58.decode(raw); } catch (_) {
      throw new Error('the key did not parse: it is not base58, not hex and not an array of numbers');
    }
    if (d.length !== 64 && d.length !== 32) {
      throw new Error('the key in base58 is ' + d.length + ' bytes long, and it has to be 64 or 32');
    }
    bytes = d;
  }

  /* Thirty-two bytes is a seed, not a full key: the pair is derived from
     it. Sixty-four is the whole pair. We accept both. */
  const kp = bytes.length === 32
    ? Keypair.fromSeed(bytes)
    : Keypair.fromSecretKey(bytes);

  const addr = kp.publicKey.toBase58();
  if (expected && addr !== String(expected).trim()) {
    throw new Error(
      'the key is not from the declared wallet.\n'
      + '    the key gives:   ' + addr + '\n'
      + '    in the settings: ' + expected + '\n'
      + '    The shares are computed from the balance of one address, and the crank\n'
      + '    would pay from another. That adds up exactly until the first transfer.');
  }
  return kp;
}

/* =========================================================================
   THE ADDRESSES OF TOKEN ACCOUNTS

   They are derived, not looked up: the address of a token account is
   determined unambiguously by the coin, the owner and the program of the
   coin. So "does the account exist" is checked with a single read by a
   ready address, not by searching the chain.
   ========================================================================= */

const pk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));

/** The program of the coin as a library object, by the string from the chain. */
export function programOf(ownerProgram) {
  if (ownerProgram === PROG.token2022) return TOKEN_2022_PROGRAM_ID;
  if (ownerProgram === PROG.token) return TOKEN_PROGRAM_ID;
  throw new Error('unknown program of the coin: ' + ownerProgram);
}

/** The address of an owner's token account for a coin. */
export function ataFor(mint, owner, ownerProgram = PROG.token) {
  return getAssociatedTokenAddressSync(
    pk(mint), pk(owner), /* allowOwnerOffCurve */ true, programOf(ownerProgram),
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
}

/**
 * The instruction that creates an account, IDEMPOTENT, and that matters.
 *
 * Ordinary creation fails if the account already exists. For the crank
 * that means a run broken off halfway would, on the retry, fail on the
 * very first account already created, and the payout would never go any
 * further. The idempotent version simply does nothing in that case, and a
 * retry becomes safe in itself, without the journal.
 */
export function ixCreateAta({ payer, owner, mint, ownerProgram = PROG.token }) {
  return createAssociatedTokenAccountIdempotentInstruction(
    pk(payer), pk(ataFor(mint, owner, ownerProgram)), pk(owner), pk(mint),
    programOf(ownerProgram), ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * A transfer of a coin. `transferChecked`, not `transfer`, on purpose: the
 * checked version requires the decimals to be stated and compares them
 * against the coin. Get the decimals wrong and we get a refusal rather
 * than a transfer of the wrong amount. The difference between those two
 * outcomes is the whole point of this line.
 */
export function ixTransfer({ mint, from, to, owner, amount, decimals,
                             ownerProgram = PROG.token }) {
  return createTransferCheckedInstruction(
    pk(from), pk(mint), pk(to), pk(owner), amount, decimals, [],
    programOf(ownerProgram),
  );
}

/* =========================================================================
   THE PURCHASE: A READY TRANSACTION FROM JUPITER

   The quote is taken in read.js (a pure read), and the transaction here:
   it has to be signed.

   We take a ready one instead of assembling it ourselves. Assembling it
   would require knowing the call format of every venue the route went
   through, which is to say writing an aggregator. What we sign, mind you,
   is only what the aggregator hands back for our own route, with our
   wallet as the payer. That is not checked by trust but by the slippage
   allowance: however much cunning there is in the route, less than
   `minOut` will not reach us.
   ========================================================================= */

export async function swapTx({ route, owner, priorityMicro = PRIORITY_MICRO }) {
  const res = await fetch(JUP.swap, {
    method: 'POST',
    headers: { ...JUP.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: route,
      userPublicKey: String(owner),
      /* Wrapping and unwrapping SOL is asked for by Jupiter itself: we pay
         in native SOL, and the pools trade the wrapped one. It also closes
         the wrapper at the end of the same transaction, so no extra
         account is left behind. */
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Number(priorityMicro) * 200,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error('Jupiter did not give the transaction: ' + res.status);
  const d = await res.json();
  if (!d || !d.swapTransaction) throw new Error('Jupiter did not give the transaction');
  return VersionedTransaction.deserialize(Buffer.from(d.swapTransaction, 'base64'));
}

/* =========================================================================
   THE SENDER
   ========================================================================= */

/** In batches of n. Pulled out separately, because it is checked separately. */
export function batch(items, n) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export class Sender {
  /**
   * @param wallet  the operator's keypair
   * @param dry     a dry run: it assembles and counts, but does not send
   */
  /* `waitMs` and `pollMs` are in the settings exactly for the sake of the
     checks: waiting ninety seconds in a test means not writing the test at
     all, and the behavior with an expired hash and with a vanished
     transaction is the main thing that has to be checked here. In live
     mode both keep their own values. */
  constructor(wallet, { dry = true, priorityMicro = PRIORITY_MICRO,
                        waitMs = WAIT_MS, pollMs = 2500 } = {}) {
    if (BigInt(priorityMicro) > MAX_PRIORITY_MICRO) {
      throw new Error('the priority fee ' + priorityMicro
        + ' is above the ceiling of ' + MAX_PRIORITY_MICRO + ', which is almost certainly a calculation error');
    }
    this.wallet = wallet;
    this.dry = dry;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.priorityMicro = BigInt(priorityMicro);
    this.fees = 0n;
    this.sent = 0;
  }

  /** How much was paid in signature fees by this run. */
  spentLamports() { return this.fees; }

  /** A fresh blockhash and how long it lives. */
  async blockhash() {
    const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = r && r.value ? r.value : r;
    if (!v || !v.blockhash) throw new Error('the node did not give a blockhash');
    return { blockhash: v.blockhash, lastValidBlockHeight: Number(v.lastValidBlockHeight) };
  }

  /** Assemble a transaction out of instructions and sign it. */
  async build(ixs, { cu = null } = {}) {
    const head = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(this.priorityMicro) }),
    ];
    if (cu) head.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));

    const { blockhash, lastValidBlockHeight } = await this.blockhash();
    const msg = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [...head, ...ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.wallet]);
    return { tx, lastValidBlockHeight };
  }

  /**
   * Send. Takes either an array of instructions or a ready transaction
   * (that is how a swap arrives from Jupiter).
   *
   * Returns { signature, lastValidBlockHeight }. The journal writes down
   * both, and the second matters more than the first: it is what later
   * decides whether the transaction vanished or is still in flight.
   */
  async send(what, { cu = null } = {}) {
    let tx, lastValidBlockHeight;

    if (Array.isArray(what)) {
      ({ tx, lastValidBlockHeight } = await this.build(what, { cu }));
    } else {
      /* A ready transaction from Jupiter: it already has a blockhash of
         its own, and changing it is not allowed, that would break its own
         signature over the address tables. We sign it as it is and take
         the deadline from the node. */
      tx = what;
      tx.sign([this.wallet]);
      const h = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]).catch(() => null);
      lastValidBlockHeight = Number(h || 0) + 150;
    }

    const wire = Buffer.from(tx.serialize()).toString('base64');
    const signature = bs58.encode(tx.signatures[0]);

    if (this.dry) {
      /* A dry run does not send, but it does not pretend either. It
         SIMULATES: the node executes the transaction at its end and
         answers whether it would have gone through. That is exactly what
         the previous version lacked, there a dry run only printed the
         intention, and an error in the assembled call was discovered by
         the first live signature. */
      const sim = await rpc('simulateTransaction',
        [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }])
        .catch(e => ({ value: { err: e.message || String(e) } }));
      const v = (sim && sim.value) || sim || {};
      if (v.err) {
        throw new Error('the simulation did not pass: ' + JSON.stringify(v.err)
          + (v.logs && v.logs.length ? '\n    ' + v.logs.slice(-3).join('\n    ') : ''));
      }
      this.sent++;
      return { signature, lastValidBlockHeight, dry: true, units: v.unitsConsumed ?? null };
    }

    /* maxRetries: 0 on purpose. The retries are our own business, in
       `confirm`: a node that retries silently deprives us of the knowledge
       of how many times the transaction went out, and the journal needs
       that knowledge. */
    await rpc('sendTransaction', [wire, {
      encoding: 'base64', skipPreflight: false, maxRetries: 0,
      preflightCommitment: 'confirmed',
    }]);

    this.sent++;
    this.fees += BigInt(tx.signatures.length) * 5_000n;
    return { signature, lastValidBlockHeight, wire };
  }

  /**
   * Wait for the confirmation. Returns a verdict instead of throwing: a
   * vanished transaction is a normal outcome, not an exception.
   *
   *   'ok'       it went through
   *   'failed'   accepted, but it executed with an error
   *   'dropped'  it did not go through and can no longer do so, a retry is
   *              safe
   */
  async confirm(signature, lastValidBlockHeight, { wire = null } = {}) {
    const until = Date.now() + this.waitMs;
    let resent = 0;

    while (Date.now() < until) {
      const st = await rpc('getSignatureStatuses', [[signature]]).catch(() => null);
      const s = st && st.value && st.value[0];
      if (s) {
        if (s.err) return { verdict: 'failed', why: JSON.stringify(s.err) };
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          return { verdict: 'ok', slot: s.slot };
        }
      }

      /* The hash has expired, so the answer is final, and this is the very
         answer that the previous chain did not have. */
      const h = Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])
        .catch(() => 0));
      if (h && h > lastValidBlockHeight) {
        return { verdict: 'dropped', why: 'the blockhash has expired, the transaction can no longer go through' };
      }

      /* While the hash is alive, it makes sense to send the same
         byte-for-byte transaction once more: its signature is the same,
         and it cannot execute twice. That is not a risk of paying twice
         but a guard against a lost packet. */
      if (wire && !this.dry && resent < 3) {
        resent++;
        await rpc('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true,
                                              maxRetries: 0 }]).catch(() => {});
      }

      await new Promise(r => setTimeout(r, this.pollMs));
    }
    /* Time ran out while the hash is still alive: there is no answer yet.
       This is the only case where we do not know, and it is honestly
       called waiting. */
    return { verdict: 'pending', why: 'no confirmation came within ' + (this.waitMs / 1000) + ' s' };
  }

  /** Send and wait. The usual path for every step except the journal's. */
  /**
   * Send and wait.
   *
   * NOT LANDING IS AN ERROR, NOT A VALUE. This used to return the verdict
   * whatever it was, and that quietly broke the project's main defence.
   *
   * The journal marks a step done when the send RETURNS without throwing.
   * And `settle` was returning `dropped`, `failed` and `pending` calmly,
   * like any other result. So a batch of transfers the chain never took
   * got an "ok" in the journal with a signature on it, counted as sent,
   * went into the shop window, and on a resumed run was skipped FOREVER.
   * The people in that batch would have got nothing, and nobody would
   * have noticed: the journal would say they were paid.
   *
   * That is exactly the failure the journal was written for, approached
   * from the other side: it guards against a second payment, and here the
   * first one was being lost.
   *
   * So any verdict other than `ok` is an exception now. The step is
   * marked failed, the run stops, and the next pass finishes exactly the
   * names that were left open.
   *
   * Anyone who wants the verdict as a value has `send` and `confirm`
   * separately: that is what they were split for.
   */
  async settle(what, opts = {}) {
    const r = await this.send(what, opts);
    if (r.dry) return { ...r, verdict: 'ok' };
    const v = await this.confirm(r.signature, r.lastValidBlockHeight, { wire: r.wire });
    if (v.verdict !== 'ok') {
      throw Object.assign(
        new Error('the transaction did not land: ' + v.verdict + (v.why ? ' (' + v.why + ')' : '')),
        { verdict: v.verdict, signature: r.signature, lastValidBlockHeight: r.lastValidBlockHeight });
    }
    return { ...r, ...v };
  }
}

/* =========================================================================
   WHY THERE IS NO WRAPPING, NO APPROVAL AND NO SWAP OF OUR OWN HERE

   The previous version exported callWrap, callUnwrap, callApprove,
   callSwapExactIn, callSwapV4, callCollectFees. Not one of them carries
   over:

     wrapping and unwrapping   Jupiter does itself, inside the swap;
     approval                  is not needed on Solana, the owner signs
                               himself;
     a swap of our own         is replaced by the aggregator's route;
     collecting the fee        is done by the owner with his wallet, not by
                               the crank.

   The last one is not an omission but the same two-wallet scheme that was
   adopted on the previous chain: the crank's key controls only the float
   on the working wallet. A leak costs the float, not the whole accrued
   fee, and that is limited not by an agreement but by the fact that the
   crank does not have the second key.
   ========================================================================= */
export { TRANSFERS_PER_TX as PER_TX };
