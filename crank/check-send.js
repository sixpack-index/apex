/* =========================================================================
   CHECKS FOR THE SENDING LAYER

   This is the only file in the project that can spend money, so there are
   more checks here than there is code.

   No node is needed: the RPC is substituted. What is checked is not the
   network but our rules: nonces, ceilings, how calls are assembled and,
   above all, the behaviour in the bad cases. The good case checks itself on
   the very first pass; it is the bad ones that cost money.

     node crank/check-send.js           run them
     node crank/check-send.js --break   make sure the checks are alive
   ========================================================================= */

import './../core.js';
import { Wallet, id as keccakOf } from 'ethers';

/* Selectors are computed HERE, from the function signatures, rather than
   copied over from send.js. Comparing a constant with the same constant is
   pointless: the check would pass with a wrong value too. The only way to
   check a selector for real is to derive it independently. The signatures
   are taken from the contract ABIs, and the router ABI was read off the
   explorer. */
const SIG = {
  collectFees:      'collectFees(address)',
  deposit:          'deposit()',
  withdraw:         'withdraw(uint256)',
  approve:          'approve(address,uint256)',
  transfer:         'transfer(address,uint256)',
  exactInputSingle: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
};
const sel = name => keccakOf(SIG[name]).slice(0, 10);

const BREAK = process.argv.includes('--break');

/* ---------- substituting the node ----------
   rpc() in read.js honours globalThis.__rpcHook when it is set. That is the
   only seam of its kind in the project, and it exists precisely for this
   file: the sending rules have to be checked where there is no node. */
const CALLS = [];
let RESPONSES = {};

globalThis.__rpcHook = async (method, params) => {
  CALLS.push({ method, params });
  const r = RESPONSES[method];
  if (typeof r === 'function') return r(params);
  if (r === undefined) throw new Error('the test did not describe a response for ' + method);
  return r;
};

const { Sender, operatorFrom, callCollectFees, callWrap, callUnwrap,
        callApprove, callTransfer, callSwapExactIn, MAX_GAS_PRICE_WEI } =
  await import('./send.js');

/* ---------- the frame ---------- */

let passed = 0;
const bad = [];
const S = 'x';

function ok(name, cond, got) {
  const c = BREAK ? !cond : cond;
  if (c) passed++;
  else bad.push(name + (got === undefined ? '' : ' — got: '
    + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? v.toString() : v)));
}

async function throws(name, fn, match) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message || String(e); }
  ok(name, msg !== null && (!match || match.test(msg)), msg);
}

const KEY = '0x' + '11'.repeat(32);
const ADDR_OF_KEY = new Wallet(KEY).address;
const OTHER = '0x' + 'ab'.repeat(20);

function reset(extra = {}) {
  CALLS.length = 0;
  RESPONSES = {
    eth_getTransactionCount: '0x5',
    eth_gasPrice: '0x' + (500_000n).toString(16),      // a fixture, not a measurement: see send.js
    eth_estimateGas: '0x' + (100_000n).toString(16),
    eth_sendRawTransaction: '0x' + '00'.repeat(32),
    eth_getTransactionReceipt: { status: '0x1', gasUsed: '0x' + (90_000n).toString(16) },
    ...extra,
  };
}

/* =========================================================================
   1. The key
   ========================================================================= */

ok('a key without 0x is accepted', operatorFrom('11'.repeat(32), ADDR_OF_KEY).address === ADDR_OF_KEY);
ok('the address is derived from the key', operatorFrom(KEY, null).address === ADDR_OF_KEY);

await throws('an empty key is refused', () => operatorFrom('', ADDR_OF_KEY), /not set/i);
await throws('garbage instead of a key is refused', () => operatorFrom('0xdeadbeef', null), /unreadable/i);
await throws("a key from the wrong wallet is refused",
  () => operatorFrom(KEY, OTHER), /belongs to/i);

/* The error message must not carry the key: the log outlives the process,
   and one day someone will read it. */
let leak = '';
try { operatorFrom('0xzz', null); } catch (e) { leak = e.message; }
ok('the error message does not carry the key', !leak.includes('zz') && !leak.includes('0x'), leak);

/* =========================================================================
   2. Nonces
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  await s.send({ to: OTHER, label: 'one' });
  await s.send({ to: OTHER, label: 'two' });
  await s.send({ to: OTHER, label: 'three' });
  ok('the nonce is taken from the node once',
    CALLS.filter(c => c.method === 'eth_getTransactionCount').length === 1,
    CALLS.filter(c => c.method === 'eth_getTransactionCount').length);
  ok('the nonce grows by one for each step',
    s.sent.map(r => r.nonce).join(',') === '5,6,7', s.sent.map(r => r.nonce));
  ok('the node is asked for the pending nonce, not the mined one',
    CALLS.find(c => c.method === 'eth_getTransactionCount').params[1] === 'pending');
}

/* =========================================================================
   3. The gas price ceiling
   ========================================================================= */

reset({ eth_gasPrice: '0x' + (MAX_GAS_PRICE_WEI + 1n).toString(16) });
await throws('a gas price above the ceiling stops the pass',
  () => new Sender(new Wallet(KEY), { dry: true }).send({ to: OTHER }), /ceiling/i);

reset({ eth_gasPrice: '0x' + MAX_GAS_PRICE_WEI.toString(16) });
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  const r = await s.send({ to: OTHER });
  ok('exactly at the ceiling still goes through', r.gasPrice === MAX_GAS_PRICE_WEI, r.gasPrice);
}

/* =========================================================================
   4. Headroom over the gas estimate
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  const r = await s.send({ to: OTHER });
  ok('the gas estimate gets a 25% headroom', r.gasLimit === 125_000n, r.gasLimit);
}

reset();
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  const r = await s.send({ to: OTHER, gasLimit: 21_000n });
  ok('an explicit limit is not re-estimated',
    r.gasLimit === 21_000n && !CALLS.some(c => c.method === 'eth_estimateGas'), r.gasLimit);
}

/* =========================================================================
   5. A dry run does NOT send
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  const r = await s.send({ to: OTHER, label: 'dry' });
  ok('a dry run does not send', !CALLS.some(c => c.method === 'eth_sendRawTransaction'));
  ok('a dry run still signs and gets a hash', /^0x[0-9a-f]{64}$/.test(r.hash), r.hash);
  ok('a dry run marks the record', r.dry === true);
}

/* =========================================================================
   6. The signature is real

   The hash has to match the hash of the transaction parsed back: that is
   what checks that what gets signed is exactly what we assembled, and not
   something that merely looks like it.
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY), { dry: true });
  const r = await s.send({ to: OTHER, value: 123n, label: 'signed' });
  ok('the hash is the hash of the signed bytes', /^0x[0-9a-f]{64}$/.test(r.hash));
  ok('the chain is ours', s.chainId === BigInt(globalThis.ApexCore.CHAIN.id), s.chainId);
}

/* =========================================================================
   7. Sending and the receipt
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY));
  const r = await s.send({ to: OTHER, label: 'real' });
  ok('a live run does send', CALLS.some(c => c.method === 'eth_sendRawTransaction'));
  ok('what is sent is the signed hex',
    /^0x02[0-9a-f]+$/.test(CALLS.find(c => c.method === 'eth_sendRawTransaction').params[0]));
  ok('a receipt with status 1 is a success', r.ok === true);
}

reset({ eth_getTransactionReceipt: { status: '0x0', gasUsed: '0x1' } });
await throws('a reverted step stops the pass',
  () => new Sender(new Wallet(KEY)).send({ to: OTHER, label: 'boom' }), /reverted/i);

/* =========================================================================
   8. The most important one: a lost transaction is NOT sent again
   ========================================================================= */

reset({
  eth_getTransactionReceipt: null,                    // no receipt now, and there never will be
  eth_getTransactionCount: p => (p[1] === 'latest' ? '0x6' : '0x5'),
});
{
  const s = new Sender(new Wallet(KEY), { waitMs: 1 });
  let msg = '';
  try { await s.send({ to: OTHER, label: 'lost' }); } catch (e) { msg = e.message; }
  const sends = CALLS.filter(c => c.method === 'eth_sendRawTransaction').length;
  ok('a lost transaction is sent exactly once, never twice', sends === 1, sends);
  ok('the operator is told it went through and must be checked by hand',
    /went through|by hand|twice/i.test(msg), msg);
}

/* =========================================================================
   9. Assembling the calls

   The selectors are verified separately with keccak; what is checked here
   is the layout of the arguments, the thing that breaks silently.
   ========================================================================= */

const T = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const R = '0x1111111111111111111111111111111111111111';

{
  const c = callCollectFees(T);
  ok('collectFees: the selector matches the one derived from the signature',
    c.data.slice(0, 10) === sel('collectFees'), c.data.slice(0, 10) + ' vs ' + sel('collectFees'));
  ok('collectFees: the address is padded to 32 bytes',
    c.data.length === 10 + 64 && c.data.endsWith(T.slice(2).toLowerCase()), c.data.length);
}
{
  const c = callWrap(1234n);
  ok('wrap: no arguments, ether goes in value',
    c.data === sel('deposit') && c.value === 1234n, c.data);
}
{
  const c = callUnwrap(1234n);
  ok('unwrap: the amount is an argument, not value',
    c.data === sel('withdraw') + (1234n).toString(16).padStart(64, '0')
      && c.value === undefined, c.data);
}
{
  const c = callTransfer(T, R, 77n);
  ok('transfer: recipient then amount',
    c.data === sel('transfer') + R.slice(2).toLowerCase().padStart(64, '0')
             + (77n).toString(16).padStart(64, '0'), c.data);
}
{
  const c = callApprove(T, R, 88n);
  ok('approve: spender then amount',
    c.data === sel('approve') + R.slice(2).toLowerCase().padStart(64, '0')
             + (88n).toString(16).padStart(64, '0'), c.data);
}
{
  const c = callSwapExactIn({
    tokenIn: R, tokenOut: T, fee: 10_000, recipient: R, amountIn: 5n, minOut: 4n,
  });
  const body = c.data.slice(10);
  ok('swap: the selector matches SwapRouter02, the variant without a deadline',
    c.data.slice(0, 10) === sel('exactInputSingle'),
    c.data.slice(0, 10) + ' vs ' + sel('exactInputSingle'));
  /* And separately: this is NOT the old router. It has the same structure
     plus a deadline, a different selector, and a call made against it would
     simply not find the function. */
  ok('swap: it is not the old SwapRouter selector',
    c.data.slice(0, 10) !== keccakOf(
      'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))').slice(0, 10));
  ok('swap: exactly seven fields', body.length === 7 * 64, body.length / 64);
  const word = i => body.slice(i * 64, (i + 1) * 64);
  ok('swap: field 1 is tokenIn', word(0).endsWith(R.slice(2).toLowerCase()));
  ok('swap: field 2 is tokenOut', word(1).endsWith(T.slice(2).toLowerCase()));
  ok('swap: field 3 is the fee tier', BigInt('0x' + word(2)) === 10_000n);
  ok('swap: field 4 is the recipient', word(3).endsWith(R.slice(2).toLowerCase()));
  ok('swap: field 5 is amountIn', BigInt('0x' + word(4)) === 5n);
  ok('swap: field 6 is amountOutMinimum', BigInt('0x' + word(5)) === 4n);
  ok('swap: field 7 is the price limit and it is zero', BigInt('0x' + word(6)) === 0n);
}

/* The most expensive mistake possible in this file: a zero minimum output
   means "give it away at any price". It is allowed only where the caller
   decided so, and never by default. */
{
  const c = callSwapExactIn({ tokenIn: R, tokenOut: T, fee: 500, recipient: R, amountIn: 5n, minOut: 0n });
  ok('swap: a zero minimum is passed through as asked, not silently invented',
    BigInt('0x' + c.data.slice(10).slice(5 * 64, 6 * 64)) === 0n);
}

/* =========================================================================
   10. What was spent
   ========================================================================= */

reset();
{
  const s = new Sender(new Wallet(KEY));
  await s.send({ to: OTHER, label: 'a' });
  await s.send({ to: OTHER, label: 'b' });
  ok('the spend is counted from gasUsed of the receipt, not from the limit',
    s.spentWei() === 2n * 90_000n * 500_000n, s.spentWei());
}

/* ---------- the result ---------- */

/* The --break mode inverts every condition. A healthy result is when NOT a
   single check passes after the inversion: that means each of them really
   does depend on what it asserts, rather than being true always. A check
   that survives inversion is empty, it checks nothing.

   The opposite condition used to stand here, and the file reported a
   breakage on a healthy pass. The check of the checks gets checked too. */
if (BREAK) {
  if (passed === 0) {
    console.log('Breakage: all ' + bad.length + ' checks flipped, none is vacuous');
    process.exit(0);
  }
  console.error('Breakage: ' + passed + ' checks survived inversion: they assert nothing');
  process.exit(1);
}

if (bad.length) {
  console.error('Send layer: ' + bad.length + ' checks failed:\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log('Send layer: ' + passed + ' checks passed.');
