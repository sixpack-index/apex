/* =========================================================================
   The collector. It goes to the chain itself, on a schedule, and puts what
   it read into the database.

   Why have it at all, if the browser can do the same: other people's free
   APIs fall over. DexScreener quietly returns zero pairs on a large request,
   Blockscout throws a 500 about every other time. While the browser was
   doing the reading, the visitor saw all of that: the page flickered with
   dashes for no reason. Now the collector sees the failure, and the visitor
   gets the last good value together with its age.

   From which follows the main rule of this file: **a failed read never
   overwrites a successful one**. Only what actually arrived is written into
   the database.
   ========================================================================= */

import './../core.js';
import { q, settings } from './db.js';
/* The gas cost of an epoch is counted by the crank, and this is that same
   function rather than a copy of it. Two pieces of arithmetic for one
   question are bound to diverge, and to diverge silently: the console would
   say "enough for forty epochs" while the crank stops on the third. */
import { costForEpoch } from './../crank/plan.js';

const C = globalThis.ApexCore;

/* The schedule. The basket and the market once a minute: more often is
   pointless, and other people's APIs did not ask for it. Holders once every
   ten minutes, Blockscout is slow. The vault once every five minutes,
   nothing there changes faster than an epoch of three hours. */
const EVERY = {
  basket: 60_000,
  self: 60_000,
  holders: 10 * 60_000,
  vault: 5 * 60_000,
  gas: 5 * 60_000,
};

/* A REQUEST TO THE NODE WITH A CEILING ON TIME.

   Both balance reads went through a bare fetch, with no timeout. A hung node
   held the task forever, and the timer once every five minutes started a new
   one on top of it, and they piled up. Twelve seconds, the same as in
   core.js. */
const RPC_TIMEOUT_MS = 12_000;

async function rpc(body) {
  const r = await fetch(C.CHAIN.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  return r;
}

/* What happened last time. Served in /api/health: a silent collector is the
   worst kind of breakage, so its state is always visible from outside. */
export const health = {
  startedAt: Date.now(),
  basket: { at: null, ok: null, why: null, source: null },
  self: { at: null, ok: null, why: null },
  holders: { at: null, ok: null, why: null },
  /* The fields are listed in full on purpose: `mark` mixes the new into the
     old, and a field forgotten here would show up in the response only
     after the first successful read. While a field that has STAYED here
     from the previous chain lives in the response forever: `eth: null` hung
     in /api/health long after the move to Solana and promised the reader
     ether that does not exist. */
  vault: { at: null, ok: null, why: null, added: 0, lamports: null, sol: null },
  gas: { at: null, ok: null, why: null, sol: null, lamports: null,
         epochs: null, rentSol: null, rentOk: null, address: '' },
};

function mark(what, ok, why, extra) {
  health[what] = { ...health[what], at: Date.now(), ok, why: why || null, ...(extra || {}) };
  if (!ok) console.warn('collector ' + what + ': ' + why);
}

/* ---------- the basket of the chain ---------- */
async function collectBasket() {
  try {
    /* Our own token does not go into our own basket: promised in the docs,
       held to here. We take the address from the settings, the same one that
       is typed into the console. */
    const s = await settings();
    const d = await C.readBasket({ exclude: s.token || '' });
    if (!d.basket.length) throw new Error('the basket came back empty');
    await q(
      'insert into basket (source, scanned, priced, rows) values ($1, $2, $3, $4)',
      [d.source, d.scanned, d.priced, JSON.stringify(d.basket)]
    );
    mark('basket', true, null, { source: d.source });
  } catch (e) {
    mark('basket', false, e.message);
  }
}

/* ---------- our own token ---------- */
async function collectSelf() {
  try {
    const s = await settings();
    const token = s.token;
    /* No address means nothing to read, and that is not an error. This is
       exactly how the whole calculation is switched off: erase the address
       in the console and the site lives on while the numbers go dark. */
    if (!C.isAddress(token)) { mark('self', true, null); return; }

    const m = await C.marketOf(token);
    /* An empty read is not written: otherwise one failure of DexScreener
       would zero out the cards, although the market has not gone anywhere. */
    if (m.price === null && m.liq === null) throw new Error('the market did not read');

    await q(
      `insert into market (token, price, market_cap, liq, vol24, pools, pair_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [token, m.price, m.marketCap, m.liq, m.vol24, m.pools, m.pairId]
    );
    mark('self', true);
  } catch (e) {
    mark('self', false, e.message);
  }
}

/* ---------- holders ---------- */
async function collectHolders() {
  try {
    const s = await settings();
    const token = s.token;
    if (!C.isAddress(token)) { mark('holders', true, null); return; }
    const n = await C.holdersOf(token);
    if (!Number.isFinite(n)) throw new Error('the explorer gave no number');
    /* A minute is accuracy enough for a snapshot, and it is also the key:
       two collectors within one minute do not double the row. */
    await q(
      `insert into holders (token, at, count)
       values ($1, date_trunc('minute', now()), $2)
       on conflict (token, at) do update set count = excluded.count`,
      [token, n]
    );
    mark('holders', true);
  } catch (e) {
    mark('holders', false, e.message);
  }
}

/* ---------- what the creator fee has accumulated ----------

   THERE WAS SOMETHING ELSE HERE, AND IT DOES NOT CARRY OVER.

   On the previous chain this collector reconstructed the HISTORY OF PAYOUTS
   off the chain: Blockscout served every token transfer to the vault address
   in a single request, with the hash, the time and the amount, and a key on
   the hash made reading it again free. The storefront showed that history as
   proof: not "we paid" but "here are the transfers, check for yourself".

   On Solana that is not possible, and the reason is arithmetical. There is
   no explorer here with a free transfer history (Solscan asks for a key),
   and a node is asked for history by signatures: getSignaturesForAddress
   serves a list, and every signature needs a getTransaction of its own. An
   epoch of a thousand holders over ten coins is ten thousand transfers in
   several hundred transactions. Reconstructing that every five minutes is
   hundreds of requests for one epoch, and a public node sheds load at that
   point (measured: a 413 after a few heavy requests).

   SO THE SOURCE OF THE HISTORY HAS CHANGED: it is written by THE CRANK
   ITSELF, when it closes an epoch, into that same epochs table. It knows
   what it sent, more precisely than any explorer, and with every record it
   puts the signature of the transaction, by which anyone who wants to can
   open it in an explorer and check.

   What is worse about this: it is self reporting, not a read of the chain.
   The storefront can no longer say "we do not trust ourselves and read it
   again". What is better: it works, and the signature in every row keeps a
   check possible, it just makes it a step for the reader rather than ours.

   This collector has one job left, and it is a useful one every day: to read
   how much HAS ACCUMULATED on the creator fee account. Under the scheme with
   two wallets the owner takes it by hand, which means he has to see when the
   time has come. */
async function collectVault() {
  try {
    const s = await settings();
    const vault = s.vault;
    if (!C.isAddress(vault)) { mark('vault', true, null, { added: 0, sol: null }); return; }

    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [vault] });
    if (!r.ok) throw new Error('the node answered ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'the node returned an error');
    const lamports = j.result && j.result.value;
    if (typeof lamports !== 'number') throw new Error('the node gave no balance');

    mark('vault', true, null, { added: 0, lamports, sol: lamports / 1e9, address: vault });
  } catch (e) {
    mark('vault', false, e.message);
  }
}

/* ---------- the operator's gas ----------

   Under the scheme of 29 August a friend forwards the fee, and the working
   wallet is topped up by hand. Which means the reserve will run out one day,
   and it will look like nothing at all: the crank simply stops closing
   epochs, the storefront keeps showing the basket, nobody notices a thing
   until the first complaint from a holder.

   So the balance is read in here and shown on the console. It is read by a
   direct call to the node: an explorer is not needed for a single number and
   answers 403 without a header, while getBalance is on every node always.

   There is no key here and there cannot be: the server knows the address and
   can only look. The crank signs, at its own place, with its own key. */
async function collectGas() {
  try {
    const s = await settings();
    const who = s.operator;
    /* No address means nothing to read, and that is not an error: before the
       launch there may be no operator at all. */
    /* We blank out ALL the fields, not only the balance. `mark` mixes the new
       into the old, and without this the reserve in epochs stayed from the
       previous read after the address was removed: no address, no balance,
       and yet "enough for 3 epochs" is there. The console does not show that
       number right now, but it sat in the API response, and a field that has
       outlived its reason lies right up until the first reader. */
    if (!C.isAddress(who)) {
      mark('gas', true, null, { sol: null, epochs: null, lamports: null,
                                rentSol: null, rentOk: null, address: '' });
      return;
    }

    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [who] });
    if (!r.ok) throw new Error('the node answered ' + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'the node returned an error');
    const lamports = j.result && j.result.value;
    if (typeof lamports !== 'number') throw new Error('the node gave no balance');
    const sol = lamports / 1e9;

    /* THE BALANCE ON ITS OWN SAYS NOTHING. On the previous chain it was
       converted into epochs: how many distributions this gas will carry. On
       Solana the question is a different one and a more important one,
       because the main cost is a one off.

       We count two things:
         how many epochs it will carry on the REPEATING costs, that is, on
         the fees for signatures, and that is the "how long it will last";
         whether there is enough at all for the ONE OFF opening of the
         recipients' accounts, because without that the first distribution
         will not happen.

       The number of recipients is taken from the last holder snapshot. While
       the holders have not been read, we count by the ceiling in the rules,
       ten thousand wallets: better to frighten in advance than to reassure
       for nothing. */
    let epochs = null, rentSol = null, rentOk = null;
    try {
      const hold = s.token
        ? (await q('select count from holders where token = $1 order by at desc limit 1',
                   [s.token])).rows[0]
        : null;
      const recipients = hold && Number.isFinite(Number(hold.count))
        ? Number(hold.count)
        : 10_000;
      const c = costForEpoch(recipients);
      rentSol = Number(c.rent) / 1e9;
      rentOk = lamports >= Number(c.rent);
      const fees = Number(c.fees);
      if (fees > 0) epochs = Math.floor(lamports / fees);
    } catch (_) { /* without a holder snapshot these two numbers just will not be there */ }

    mark('gas', true, null, {
      sol, lamports, address: who, epochs, rentSol, rentOk,
    });
  } catch (e) {
    mark('gas', false, e.message);
  }
}

/* ---------- the start ---------- */

/**
 * Every task spins on a timer of its own and catches its own errors. A
 * common loop would mean that a fallen Blockscout stops the reading of
 * DexScreener, and the two are connected by nothing except that both are
 * free.
 */
export function startCollector() {
  const run = (fn, ms) => { fn(); setInterval(fn, ms); };
  run(collectBasket, EVERY.basket);
  run(collectSelf, EVERY.self);
  run(collectHolders, EVERY.holders);
  run(collectVault, EVERY.vault);
  run(collectGas, EVERY.gas);
}

export const jobs = { collectBasket, collectSelf, collectHolders, collectVault, collectGas };
