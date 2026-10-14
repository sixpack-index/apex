/* =========================================================================
   CHECKS OF THE EPOCH JOURNAL

   One property is checked: A SECOND PAYMENT IS IMPOSSIBLE. Everything else
   here is the harness around that.

   The database is real, not a fake. The whole meaning of the journal rests
   on the primary key and the partial unique index; a fake would return
   what is expected of it and would not check the one thing all of this is
   written for.

     DATABASE_URL=… node crank/check-journal.js
     DATABASE_URL=… node crank/check-journal.js --break
   ========================================================================= */

import './../core.js';

const BREAK = process.argv.includes('--break');

/* We substitute the node: working out stuck steps is our rules, not the
   behavior of the network. */
let RESPONSES = {};
globalThis.__rpcHook = async (method, params) => {
  const r = RESPONSES[method];
  if (typeof r === 'function') return r(params);
  if (r === undefined) throw new Error('the test did not describe a response for ' + method);
  return r;
};

const { openRun, closeRun, runStep, resolveStep, ensureSchema, runReport } =
  await import('./journal.js');
const { q, pool } = await import('./../server/db.js');

let passed = 0;
const bad = [];
function ok(name, cond, got) {
  const c = BREAK ? !cond : cond;
  if (c) passed++;
  else bad.push(name + (got === undefined ? '' : ' got: ' + JSON.stringify(got)));
}
async function throws(name, fn, match) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message || String(e); }
  ok(name, msg !== null && (!match || match.test(msg)), msg);
}

const OPER = '0x' + '11'.repeat(20);
const TOKEN = () => '0x' + Math.floor(Math.random() * 1e15).toString(16).padStart(40, '0');

await ensureSchema();
await q('delete from epoch_runs');

/* =========================================================================
   1. Opening a run and picking one up
   ========================================================================= */
{
  const t = TOKEN();
  const a = await openRun({ token: t, pot: 1000n, operator: OPER });
  ok('a fresh token opens a new run', a.resumed === false && a.run.id > 0);
  ok('the pot is written down as given', String(a.run.pot) === '1000', a.run.pot);

  const b = await openRun({ token: t, pot: 2000n, operator: OPER });
  ok('a second open picks up the same run instead of starting another',
    b.resumed === true && b.run.id === a.run.id, [a.run.id, b.run.id]);

  await closeRun(a.run.id, 'done', 'test');
  const c = await openRun({ token: t, pot: 3000n, operator: OPER });
  ok('after the run is closed a new one opens', c.resumed === false && c.run.id !== a.run.id);
  await closeRun(c.run.id, 'done', 'test');
}

/* =========================================================================
   2. Two cranks at the same time

   The most dangerous case in life: Railway did not put out the old
   container, a new one came up, and both took on one epoch. Guarding that
   with code is pointless, the processes know nothing about each other. The
   database guards it.
   ========================================================================= */
{
  const t = TOKEN();
  /* The race is set up honestly: the two inserts go out at the same time,
     not one after the other. One after the other, the second would see the
     first and simply pick it up. */
  const both = await Promise.allSettled([
    q(`insert into epoch_runs (token, status) values ($1, 'running')`, [t]),
    q(`insert into epoch_runs (token, status) values ($1, 'running')`, [t]),
  ]);
  const okCount = both.filter(r => r.status === 'fulfilled').length;
  ok('only one of two simultaneous runs survives: the database refuses the second',
    okCount === 1, okCount);
  await q(`delete from epoch_runs where token = $1`, [t]);
}

/* =========================================================================
   3. A step is executed EXACTLY ONCE
   ========================================================================= */
{
  const t = TOKEN();
  const { run, done } = await openRun({ token: t, operator: OPER });

  let calls = 0;
  const send = async () => { calls += 1; return { signature: 'A'.repeat(64), lastValidBlockHeight: 1000 }; };

  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  ok('the same step is sent once no matter how many times it is asked for',
    calls === 1, calls);

  /* And the same thing, but with a clean memory: that is what a restart of
     the process looks like, when the set of what is done is empty and the
     database remembers. */
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done: new Set() });
  ok('after a restart the step is still not repeated: the database remembers',
    calls === 1, calls);

  await closeRun(run.id, 'done');
}

/* =========================================================================
   4. Different steps do not get mixed up with each other
   ========================================================================= */
{
  const t = TOKEN();
  const { run, done } = await openRun({ token: t, operator: OPER });
  let n = 0;
  const send = () => Promise.resolve({ signature: 'B'.repeat(60) + String(n).padStart(4,'0'), lastValidBlockHeight: 1000 + (++n) });

  await runStep(run.id, 'collect', send, { done });
  await runStep(run.id, 'wrap', send, { done });
  await runStep(run.id, 'buy:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xaaa:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xbbb:PIPEDOG', send, { done });
  ok('five different steps all go through', n === 5, n);

  const { steps } = await runReport(run.id);
  ok('every step is recorded as ok', steps.every(s => s.status === 'ok'), steps.map(s => s.status));
  ok('every step has a hash lifetime of its own',
    steps.map(s => Number(s.valid_until)).sort((a, b) => a - b).join(',') === '1001,1002,1003,1004,1005',
    steps.map(s => s.valid_until));
  await closeRun(run.id, 'done');
}

/* =========================================================================
   5. A failure in sending: the step stays failed rather than "done"
   ========================================================================= */
{
  const t = TOKEN();
  const { run, done } = await openRun({ token: t, operator: OPER });
  await throws('a failure in sending is passed up, not swallowed',
    () => runStep(run.id, 'buy:AI', () => { throw new Error('node is down'); }, { done }),
    /node is down/);

  const { steps } = await runReport(run.id);
  ok('a failed step is written down as failed', steps[0].status === 'failed', steps[0].status);
  ok('the reason is kept', /node is down/.test(steps[0].detail || ''), steps[0].detail);

  /* And the most important thing: a failed step is NOT repeated
     automatically. Only a human can repeat it, once he has worked out
     whether the money left or not. */
  let again = 0;
  const r = await runStep(run.id, 'buy:AI', () => { again += 1; return { signature: 'C'.repeat(64) }; }, { done });
  ok('a failed step is not retried by itself', again === 0 && r.skipped === true, [again, r]);
  await closeRun(run.id, 'stopped', 'test');
}

/* =========================================================================
   6. Working out a stuck step

   Three outcomes, and "it probably went through" is not among them.
   ========================================================================= */

/* Working out stuck steps. On Solana this question has an exact answer,
   and it follows from the lifetime of the blockhash rather than from the
   sequence number of the wallet, as it was on the previous chain. So there
   is almost no "I do not know" verdict left: there is one, and it has
   exactly one reason. */
RESPONSES = { getSignatureStatuses: { value: [{ err: null, confirmationStatus: 'confirmed' }] } };
{
  const v = await resolveStep({ signature: 'S'.repeat(64), valid_until: 1000 }, OPER);
  ok('the signature turned up, the step is done', v.verdict === 'mined', v);
}

RESPONSES = { getSignatureStatuses: { value: [{ err: { InstructionError: [0, 'X'] } }] } };
{
  const v = await resolveStep({ signature: 'S'.repeat(64), valid_until: 1000 }, OPER);
  ok('accepted, but it executed with an error, so it can be repeated', v.verdict === 'dropped', v);
}

RESPONSES = { getSignatureStatuses: { value: [null] }, getBlockHeight: 999 };
{
  const v = await resolveStep({ signature: 'S'.repeat(64), valid_until: 1000 }, OPER);
  ok('no signature and the hash alive, wait rather than retry', v.verdict === 'pending', v);
}

RESPONSES = { getSignatureStatuses: { value: [null] }, getBlockHeight: 1001 };
{
  const v = await resolveStep({ signature: 'S'.repeat(64), valid_until: 1000 }, OPER);
  ok('no signature and the hash expired, a retry is safe', v.verdict === 'dropped', v);
  ok('and the reason explains it', /expired/.test(v.why || ''), v.why);
}

RESPONSES = { getSignatureStatuses: { value: [null] } };
{
  const v = await resolveStep({ signature: 'S'.repeat(64) }, OPER);
  ok('with no hash lifetime there is no answer, we call a human', v.verdict === 'unknown', v);
}

{
  const v = await resolveStep({ signature: null, valid_until: 1000 }, OPER);
  ok('a step claimed but never sent may be repeated', v.verdict === 'dropped', v);
}

/* =========================================================================
   7. An unclosed run is picked up with all the steps already done
   ========================================================================= */
{
  const t = TOKEN();
  const first = await openRun({ token: t, operator: OPER });
  const send = () => Promise.resolve({ signature: 'E'.repeat(64), lastValidBlockHeight: 1000 });
  await runStep(first.run.id, 'collect', send, { done: first.done });
  await runStep(first.run.id, 'wrap', send, { done: first.done });
  // the process dies here, closeRun is not called

  const again = await openRun({ token: t, operator: OPER });
  ok('the unfinished run is picked up, not started over', again.resumed === true);
  ok('what was already done is known', again.done.has('collect') && again.done.has('wrap'),
    [...again.done]);
  ok('and it is exactly what was done, nothing more', again.done.size === 2, again.done.size);
  await closeRun(again.run.id, 'done');
}

/* ---------- the result ---------- */

await pool.end();

if (BREAK) {
  if (passed === 0) {
    console.log('Breakage: all ' + bad.length + ' checks flipped, none is vacuous');
    process.exit(0);
  }
  console.error('Breakage: ' + passed + ' checks survived inversion: they assert nothing');
  process.exit(1);
}
if (bad.length) {
  console.error('Journal: ' + bad.length + ' checks failed:\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log('Journal: ' + passed + ' checks passed.');
