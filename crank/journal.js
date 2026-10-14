/* =========================================================================
   THE EPOCH JOURNAL: PROTECTION AGAINST A SECOND PAYMENT

   An epoch is not one transaction but anywhere from ten to hundreds: take
   the fee, swap it, buy six coins, and then make one transfer to every
   holder for every seat. Between any two of them the process can die: the
   node went down, the gas ran out, the container restarted.

   And this is where the line runs between "annoying" and "disaster".

   If the crank starts the epoch over after a fall, it WILL PAY AGAIN the
   people it has already paid. The money leaves and cannot be brought back.
   So a fall has to lead to CONTINUATION, not to a restart, and that
   property must come from the construction, not from being careful.

   HOW IT IS DONE

   Every step has a name, and the name says unambiguously what exactly the
   step does: `collect`, `wrap`, `buy:PIPEDOG`, `pay:0xabc...:PIPEDOG`. The
   name is written to the database BEFORE sending, and the primary key
   (run, name) physically will not let it be written twice. Not "we try not
   to repeat ourselves" but "a repeat is impossible at the table level".

   On startup the crank first looks for an unclosed run. Found one: it
   finishes that run, skipping everything already marked done.

   ABOUT STEPS STUCK IN "SENDING"

   The nastiest case: the step is recorded as sent, and there is no
   confirmation. The transaction may have gone through, or it may have been
   lost, and the difference between those two answers is money.

   ON SOLANA THAT QUESTION HAS AN EXACT ANSWER, AND THAT IS THE MAIN THING
   THE MOVE CHANGED.

   On the previous chain a transaction was identified by the wallet's
   sequence number, the nonce. The number was taken by the signing, and a
   vanished step left the question without an answer: is its transaction
   still on its way, or has another one already taken the number? The
   previous version of this file honestly wrote "unknown" and stopped the
   crank, because continuing meant possibly paying twice. A stop cost three
   hours, but a second payment cost money.

   Here a transaction is tied to a recent blockhash, and the hash lives
   about a minute. While it is alive, the transaction may go through. As
   soon as the block height has passed `valid_until`, it CAN NEVER go
   through, which means repeating it is safe, with no guessing:

     the signature turned up in the chain → it went through
     no signature, the hash is still alive → in flight, we wait
     no signature, the hash has expired    → it did not go through, a
                                              retry is safe

   So there is no "unknown" verdict here any more. It is left for exactly
   one case: the step is recorded and there is no hash lifetime with it,
   and that is only possible for a record written by an old version of the
   crank.
   ========================================================================= */

import { q } from './../server/db.js';
import { rpc } from './read.js';

/* =========================================================================
   Schema

   Kept apart from migrate() in server/db.js on purpose: the server and the
   crank are deployed separately, and the crank must be able to bring up
   its own storage itself, without waiting for the server to restart.
   ========================================================================= */
export async function ensureSchema() {
  await q(`
    create table if not exists epoch_runs (
      id         bigserial primary key,
      token      text        not null,
      status     text        not null,          -- running | done | stopped
      pot        numeric(78, 0),                -- lamports on the working wallet
      operator   text,
      started_at timestamptz not null default now(),
      ended_at   timestamptz,
      note       text
    );
  `);

  /* One unclosed run per token, and the database is what checks that, not
     the code.

     Two cranks brought up at the same time, by oversight or because
     Railway had not yet put out the old container, would hand out one
     epoch twice. A partial unique index makes the second run physically
     impossible. */
  await q(`
    create unique index if not exists epoch_runs_one_running
      on epoch_runs (token) where status = 'running';
  `);

  await q(`
    create table if not exists epoch_steps (
      run_id      bigint      not null references epoch_runs (id) on delete cascade,
      key         text        not null,
      status      text        not null,         -- sending | ok | failed
      signature   text,                         -- the signature of the transaction, base58
      valid_until bigint,                       -- the block height past which it will not go through
      detail      text,
      at          timestamptz not null default now(),
      primary key (run_id, key)
    );
  `);
  await q(`create index if not exists epoch_steps_run on epoch_steps (run_id);`);

  /* The database on Railway is older than this code: the columns of the
     previous chain are sitting in it (hash, nonce, pot_wei). We pour the
     new ones into the old table and leave the old ones alone, because
     dropping a column with the records of past runs means erasing the
     history that somebody will one day have to work through. The old ones
     stay empty and nobody reads them. */
  await q(`alter table epoch_steps add column if not exists signature text;`);
  await q(`alter table epoch_steps add column if not exists valid_until bigint;`);
  await q(`alter table epoch_runs  add column if not exists pot numeric(78, 0);`);
}

/* =========================================================================
   The run
   ========================================================================= */

/**
 * Open a run or pick up an unclosed one.
 *
 * Returns { run, resumed, done }, where done is the set of step names that
 * are already finished and have to be skipped.
 */
export async function openRun({ token, pot, operator }) {
  await ensureSchema();

  const open = (await q(
    `select * from epoch_runs where token = $1 and status = 'running' order by id desc limit 1`,
    [token]
  )).rows[0];

  if (open) {
    const steps = (await q(`select * from epoch_steps where run_id = $1`, [open.id])).rows;
    return {
      run: open,
      resumed: true,
      done: new Set(steps.filter(s => s.status === 'ok').map(s => s.key)),
      pending: steps.filter(s => s.status === 'sending'),
    };
  }

  const run = (await q(
    `insert into epoch_runs (token, status, pot, operator)
     values ($1, 'running', $2, $3) returning *`,
    [token, pot === undefined || pot === null ? null : String(pot), operator || null]
  )).rows[0];

  return { run, resumed: false, done: new Set(), pending: [] };
}

export async function closeRun(runId, status, note) {
  await q(
    `update epoch_runs set status = $2, ended_at = now(), note = $3 where id = $1`,
    [runId, status, note || null]
  );
}

/* =========================================================================
   The step
   ========================================================================= */

/**
 * Execute a step once in the whole life of a run.
 *
 * `send` is obliged to return the send record from Sender, with the fields
 * signature and lastValidBlockHeight. The order here matters and it is
 * exactly this:
 *
 *   1. claim the step in the database as "sending". If one like it already
 *      exists, the primary key will not allow it, and we learn about that
 *      BEFORE spending money;
 *   2. send;
 *   3. write down how it ended.
 *
 * The reverse order, send first and write afterwards, leaves a window in
 * which the money has left and there is no record. It is short, but it is
 * exactly the window a fall lands in: transactions live in the network for
 * seconds, and a write to the database for milliseconds.
 */
export async function runStep(runId, key, send, { done } = { done: new Set() }) {
  if (done.has(key)) return { skipped: true, key };

  try {
    await q(
      `insert into epoch_steps (run_id, key, status) values ($1, $2, 'sending')`,
      [runId, key]
    );
  } catch (e) {
    /* 23505 is a uniqueness violation. So the step is already claimed, and
       that is not a bug in the code but exactly the protection all of this
       was written for. */
    if (e.code === '23505') return { skipped: true, key, alreadyClaimed: true };
    throw e;
  }

  let rec;
  try {
    rec = await send();
  } catch (e) {
    await q(
      `update epoch_steps set status = 'failed', detail = $3, at = now()
       where run_id = $1 and key = $2`,
      [runId, key, String(e.message || e).slice(0, 500)]
    );
    throw e;
  }

  await q(
    `update epoch_steps set status = 'ok', signature = $3, valid_until = $4, at = now()
     where run_id = $1 and key = $2`,
    [runId, key, rec.signature || null, rec.lastValidBlockHeight ?? null]
  );
  done.add(key);
  return { ...rec, key };
}

/* =========================================================================
   A BATCH OF STEPS IN ONE TRANSACTION

   On Solana about ten transfers fit into one transaction, and that is no
   small economy: a thousand holders across ten coins is ten thousand
   transfers, that is, the difference between a thousand transactions and
   ten thousand.

   But the journal becomes more complicated because of it, and the
   complication here is a dangerous one. The simple path, one step per
   transaction with a name of the form `xfer:PUMP:batch3`, breaks exactly
   where the journal is needed. The holder list changes between two
   attempts (somebody sold, somebody bought), the batches get reassembled,
   and "batch3" in a new run already means different people. A repeat would
   pay again the people who must not be paid, and would not pay the ones
   who must.

   So the name of a step stays BY NAME, as it was: `xfer:PUMP:<address>`.
   One transaction simply closes several names at once: all of them are
   claimed before sending, and all of them are marked with one and the same
   signature.

   What that gives: the batches can be reassembled however you like, in any
   order and of any size, while the protection against a second payment
   stays by name. And if the previous run managed to pay part of the list,
   the new one simply assembles batches out of those who are left.
   ========================================================================= */

/**
 * Execute a batch of steps with one send.
 *
 * The order is the same as in runStep, and for the same reason: first
 * claim all the names, then send, then write down the result.
 *
 * If even one name is already claimed by somebody else, the batch is not
 * sent at all: that means somebody has already taken it, and sending now
 * is exactly the second payment this whole file is about.
 */
export async function runBatch(runId, keys, send, { done } = { done: new Set() }) {
  const todo = keys.filter(k => !done.has(k));
  if (!todo.length) return { skipped: true, keys };

  const claimed = [];
  for (const key of todo) {
    try {
      await q(`insert into epoch_steps (run_id, key, status) values ($1, $2, 'sending')`,
              [runId, key]);
      claimed.push(key);
    } catch (e) {
      if (e.code === '23505') {
        /* The name is taken. Rolling back the ones already claimed is not
           allowed, they are ours, and cancelling them means permitting a
           repeat. We send what we managed to claim and leave what is taken
           to the previous run. */
        break;
      }
      throw e;
    }
  }
  if (!claimed.length) return { skipped: true, keys, alreadyClaimed: true };

  let rec;
  try {
    rec = await send(claimed);
  } catch (e) {
    await q(`update epoch_steps set status = 'failed', detail = $3, at = now()
             where run_id = $1 and key = any($2)`,
            [runId, claimed, String(e.message || e).slice(0, 500)]);
    throw e;
  }

  await q(`update epoch_steps set status = 'ok', signature = $3, valid_until = $4, at = now()
           where run_id = $1 and key = any($2)`,
          [runId, claimed, rec.signature || null, rec.lastValidBlockHeight ?? null]);
  for (const k of claimed) done.add(k);
  return { ...rec, keys: claimed };
}

/* =========================================================================
   Working out stuck steps
   ========================================================================= */

/**
 * What actually happened to a step marked "sending".
 *
 * Returns one of:
 *   mined     it went through, it can be counted as done
 *   dropped   it did not go through and can no longer do so, a retry is
 *             safe
 *   pending   it may still go through, wait
 *   unknown   there is no unambiguous answer, a human is needed
 *
 * The last case is all but impossible on this chain and is left for
 * exactly one thing: the record was made by an old version of the crank
 * and there is no hash lifetime with it. Then an answer is impossible, and
 * the crank calls a human instead of guessing.
 */
export async function resolveStep(step, operator) {
  const sig = step.signature || null;
  if (!sig) {
    /* There is no signature at all: the step was claimed but never got as
       far as being sent. That happens when the process died between two
       lines. A retry is safe. */
    return { verdict: 'dropped', why: 'the step was claimed, but it was never sent' };
  }

  const st = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])
    .catch(() => null);
  const s = st && st.value && st.value[0];
  if (s) {
    return s.err
      ? { verdict: 'dropped', why: 'the transaction was accepted, but it executed with an error: '
                                 + JSON.stringify(s.err), status: s }
      : { verdict: 'mined', status: s };
  }

  /* The signature is not in the chain. Whether its blockhash is still
     alive is decided by the height. */
  const until = step.valid_until;
  if (until === null || until === undefined) {
    return { verdict: 'unknown',
             why: 'the signature is not in the chain, and no hash lifetime was written down with the step. '
                + 'This is a record from an old version of the crank: an answer is impossible' };
  }

  const height = Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])
    .catch(() => 0));
  if (!height) {
    return { verdict: 'unknown', why: 'the node did not tell us the block height, there is nothing to decide with' };
  }
  if (height > Number(until)) {
    /* The main place in the file. The hash has expired, so the transaction
       CAN NEVER go through, and that is a property of the chain, not a
       hope of ours. A retry is safe, and there is no need to call a
       human. */
    return { verdict: 'dropped',
             why: 'no signature, the blockhash expired at height ' + until
                + ' (now ' + height + '), it can no longer go through' };
  }
  return { verdict: 'pending',
           why: 'no signature yet, but the hash is alive until height ' + until
              + ' (now ' + height + '), it may still go through' };
}

/* =========================================================================
   WRITING THE EPOCH TO THE SHOP WINDOW

   The epochs table is what the site reads: it is the very line "paid in
   kind across N epochs". On the previous chain the server filled it,
   re-reading the transfers off the explorer, which is to say the shop
   window showed the chain rather than our report.

   On Solana there is no explorer with free transfer history, and the node
   is asked for history one transaction per request: an epoch for a
   thousand holders is several hundred transactions, and the public node
   will not allow re-reading them every five minutes (see the comment in
   server/collect.js).

   So the crank writes, and it writes exactly what it sent. This is a
   self-report, and calling it reading the chain would be untrue. What
   makes it verifiable: every row holds the signature of the transaction.
   With it anyone opens the transaction in an explorer and checks the
   amount. The check stayed possible, it is just the reader who does it
   rather than us on his behalf.

   The key is the signature, so writing the same transaction again
   duplicates nothing. That matters for a run that broke off: it will
   finish, reach the writing again, and spoil nothing.
   ========================================================================= */

/**
 * @param rows [{ signature, slot, symbol, token, amount }]
 */
export async function recordEpoch(rows) {
  let added = 0;
  for (const r of rows || []) {
    if (!r || !r.signature) continue;
    const res = await q(
      `insert into epochs (signature, at, slot, symbol, token, amount, raw)
       values ($1, now(), $2, $3, $4, $5, $6)
       on conflict (signature) do nothing`,
      [r.signature, r.slot ?? null, r.symbol ?? null, r.token ?? null,
       Number.isFinite(r.amount) ? r.amount : null,
       JSON.stringify({ recipients: r.recipients ?? null, runId: r.runId ?? null })]
    );
    added += res.rowCount;
  }
  return added;
}

/** Everything about a run in one piece, for the report and for the console. */
export async function runReport(runId) {
  const run = (await q(`select * from epoch_runs where id = $1`, [runId])).rows[0];
  const steps = (await q(
    `select * from epoch_steps where run_id = $1 order by at asc`, [runId]
  )).rows;
  return { run, steps };
}
