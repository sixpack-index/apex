/* =========================================================================
   CHECKS FOR THE EPOCH JOURNAL

   One property is checked: A DOUBLE PAYMENT IS IMPOSSIBLE. Everything else
   here is scaffolding around that.

   The database is real, not a fake. The whole meaning of the journal rests
   on the primary key and the partial unique index; a fake would return what
   is expected of it and would check exactly none of what all this was
   written for.

     DATABASE_URL=… node crank/check-journal.js
     DATABASE_URL=… node crank/check-journal.js --break
   ========================================================================= */

import './../core.js';

const BREAK = process.argv.includes('--break');

/* The node is substituted: sorting out a stuck step is our rules, not the
   behaviour of the network. */
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
  else bad.push(name + (got === undefined ? '' : ' — got: ' + JSON.stringify(got)));
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
  const a = await openRun({ token: t, potWei: 1000n, operator: OPER });
  ok('a fresh token opens a new run', a.resumed === false && a.run.id > 0);
  ok('the pot is written down as given', String(a.run.pot_wei) === '1000', a.run.pot_wei);

  const b = await openRun({ token: t, potWei: 2000n, operator: OPER });
  ok('a second open picks up the same run instead of starting another',
    b.resumed === true && b.run.id === a.run.id, [a.run.id, b.run.id]);

  await closeRun(a.run.id, 'done', 'test');
  const c = await openRun({ token: t, potWei: 3000n, operator: OPER });
  ok('after the run is closed a new one opens', c.resumed === false && c.run.id !== a.run.id);
  await closeRun(c.run.id, 'done', 'test');
}

/* =========================================================================
   2. Two cranks at once

   The most dangerous case in real life: Railway did not put out the old
   container, a new one came up, and both took on the same epoch. Guarding
   that in code is pointless, the processes know nothing about each other.
   The database is what guards it.
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
  ok('only one of two simultaneous runs survives — the database refuses the second',
    okCount === 1, okCount);
  await q(`delete from epoch_runs where token = $1`, [t]);
}

/* =========================================================================
   3. A step runs EXACTLY ONCE
   ========================================================================= */
{
  const t = TOKEN();
  const { run, done } = await openRun({ token: t, operator: OPER });

  let calls = 0;
  const send = async () => { calls += 1; return { hash: '0x' + 'aa'.repeat(32), nonce: 7 }; };

  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done });
  ok('the same step is sent once no matter how many times it is asked for',
    calls === 1, calls);

  /* And the same again but with a clean memory: that is what a restart of
     the process looks like, when the set of what is done is empty and the
     database remembers. */
  await runStep(run.id, 'pay:0xabc:PIPEDOG', send, { done: new Set() });
  ok('after a restart the step is still not repeated — the database remembers',
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
  const send = () => Promise.resolve({ hash: '0x' + 'bb'.repeat(32), nonce: ++n });

  await runStep(run.id, 'collect', send, { done });
  await runStep(run.id, 'wrap', send, { done });
  await runStep(run.id, 'buy:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xaaa:PIPEDOG', send, { done });
  await runStep(run.id, 'pay:0xbbb:PIPEDOG', send, { done });
  ok('five different steps all go through', n === 5, n);

  const { steps } = await runReport(run.id);
  ok('every step is recorded as ok', steps.every(s => s.status === 'ok'), steps.map(s => s.status));
  ok('each step keeps its own nonce',
    steps.map(s => s.nonce).sort((a, b) => a - b).join(',') === '1,2,3,4,5',
    steps.map(s => s.nonce));
  await closeRun(run.id, 'done');
}

/* =========================================================================
   5. A failure in sending: the step stays failed, it does not become "done"
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

  /* And the most important part: a failed step is NOT repeated on its own.
     Only a human can repeat it, after working out whether the money left or
     not. */
  let again = 0;
  const r = await runStep(run.id, 'buy:AI', () => { again += 1; return { hash: '0x' + 'cc'.repeat(32) }; }, { done });
  ok('a failed step is not retried by itself', again === 0 && r.skipped === true, [again, r]);
  await closeRun(run.id, 'stopped', 'test');
}

/* =========================================================================
   6. Sorting out a stuck step

   Three outcomes, and "it probably went through" is not among them.
   ========================================================================= */

RESPONSES = { eth_getTransactionReceipt: { status: '0x1' } };
{
  const v = await resolveStep({ hash: '0x' + 'dd'.repeat(32), nonce: 3 }, OPER);
  ok('a receipt with status 1 means it went through', v.verdict === 'mined', v);
}

RESPONSES = { eth_getTransactionReceipt: { status: '0x0' } };
{
  const v = await resolveStep({ hash: '0x' + 'dd'.repeat(32), nonce: 3 }, OPER);
  ok('a reverted transaction may be repeated', v.verdict === 'dropped', v);
}

RESPONSES = {
  eth_getTransactionReceipt: null,
  eth_getTransactionCount: () => '0x3',            // the nonce has not reached ours yet
};
{
  const v = await resolveStep({ hash: '0x' + 'dd'.repeat(32), nonce: 3 }, OPER);
  ok('no receipt and the nonce is still free — safe to repeat', v.verdict === 'dropped', v);
}

RESPONSES = {
  eth_getTransactionReceipt: null,
  eth_getTransactionCount: () => '0x9',            // the nonce has gone far past
};
{
  const v = await resolveStep({ hash: '0x' + 'dd'.repeat(32), nonce: 3 }, OPER);
  ok('no receipt but the nonce has moved past — a human decides, never the crank',
    v.verdict === 'unknown', v);
  ok('and the crank says plainly what to check', /by hand/i.test(v.why || ''), v.why);
}

{
  const v = await resolveStep({ hash: null, nonce: 3 }, OPER);
  ok('a step claimed but never sent may be repeated', v.verdict === 'dropped', v);
}

/* =========================================================================
   7. An unclosed run is picked up with every step already done
   ========================================================================= */
{
  const t = TOKEN();
  const first = await openRun({ token: t, operator: OPER });
  const send = () => Promise.resolve({ hash: '0x' + 'ee'.repeat(32), nonce: 1 });
  await runStep(first.run.id, 'collect', send, { done: first.done });
  await runStep(first.run.id, 'wrap', send, { done: first.done });
  // the process dies here, closeRun is never called

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
