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
   receipt. The transaction may have gone through, or it may have been
   lost, and the difference between those two answers is money. Guessing is
   not allowed here, so the crank does not guess: it asks the network for a
   receipt by hash, and if there is none, it compares the step's nonce with
   the wallet's current nonce. The nonce has moved past: then a transaction
   with that nonce happened, and repeating it is out of the question. If
   there is no unambiguous answer, the run stops and calls for a human. A
   stop costs three hours, a second payment costs money.
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
      pot_wei    numeric(78, 0),
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
      run_id  bigint      not null references epoch_runs (id) on delete cascade,
      key     text        not null,
      status  text        not null,             -- sending | ok | failed
      nonce   integer,
      hash    text,
      detail  text,
      at      timestamptz not null default now(),
      primary key (run_id, key)
    );
  `);
  await q(`create index if not exists epoch_steps_run on epoch_steps (run_id);`);
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
export async function openRun({ token, potWei, operator }) {
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
    `insert into epoch_runs (token, status, pot_wei, operator)
     values ($1, 'running', $2, $3) returning *`,
    [token, potWei === undefined || potWei === null ? null : String(potWei), operator || null]
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
 * Perform a step once in the whole life of the run.
 *
 * `send` has to return the send record from Sender, with the fields hash
 * and nonce. The order here matters and it is exactly this one:
 *
 *   1. claim the step in the database as "sending". If one like it already
 *      exists, the primary key will not allow it, and we find that out
 *      BEFORE spending money;
 *   2. send;
 *   3. write down how it ended.
 *
 * The reverse order, send first and write afterwards, leaves a window in
 * which the money is gone and there is no record. It is short, but that is
 * exactly the window a fall lands in: transactions live for seconds in the
 * network, and a database write takes milliseconds.
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
    `update epoch_steps set status = 'ok', hash = $3, nonce = $4, at = now()
     where run_id = $1 and key = $2`,
    [runId, key, rec.hash || null, rec.nonce ?? null]
  );
  done.add(key);
  return { ...rec, key };
}

/* =========================================================================
   Sorting out stuck steps
   ========================================================================= */

/**
 * What actually happened to a step marked "sending".
 *
 * Returns one of:
 *   mined     went through, can be counted as done
 *   dropped   did not go through and the nonce is free, can be repeated
 *   unknown   there is no unambiguous answer, a human is needed
 *
 * The third case exists not for completeness but because it happens: a
 * node can lose a receipt, and the wallet nonce could have been moved by
 * anyone who holds the key. Writing "probably went through" here means
 * paying twice one day.
 */
export async function resolveStep(step, operator) {
  if (!step.hash) {
    /* There is no hash at all: the step was claimed but never got as far
       as being sent. That happens when the process dies between two lines.
       Repeating it is safe. */
    return { verdict: 'dropped', why: 'the step was claimed but never sent' };
  }

  const receipt = await rpc('eth_getTransactionReceipt', [step.hash]).catch(() => null);
  if (receipt) {
    return BigInt(receipt.status) === 1n
      ? { verdict: 'mined', receipt }
      : { verdict: 'dropped', why: 'the transaction was mined but reverted', receipt };
  }

  if (step.nonce === null || step.nonce === undefined) {
    return { verdict: 'unknown', why: 'no receipt and no nonce recorded' };
  }

  const mined = Number(BigInt(await rpc('eth_getTransactionCount', [operator, 'latest'])));
  if (mined > step.nonce) {
    return {
      verdict: 'unknown',
      why: 'no receipt, but the wallet nonce has moved past ' + step.nonce
         + '. Some transaction with that nonce went through, check by hand '
         + 'whether it was this one before letting the crank continue.',
    };
  }
  return { verdict: 'dropped', why: 'no receipt and the nonce is still free' };
}

/** Everything about a run in one piece, for the report and for the console. */
export async function runReport(runId) {
  const run = (await q(`select * from epoch_runs where id = $1`, [runId])).rows[0];
  const steps = (await q(
    `select * from epoch_steps where run_id = $1 order by at asc`, [runId]
  )).rows;
  return { run, steps };
}
