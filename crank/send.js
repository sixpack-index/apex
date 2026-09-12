/* =========================================================================
   SIGNING AND SENDING

   Everything that spends money passes through here and nowhere else. The
   rest of the crank only reads and computes.

   WHY A LIBRARY AND NOT OUR OWN CODE. Signing a transaction is secp256k1,
   keccak, RLP and the EIP-1559 rules. You can write that yourself, and it
   will even work on the first test; the mistake shows up on a rare input
   and costs a wallet. The one place in the project where our own
   implementation is unacceptable in principle is this one. Hence ethers:
   it is proven by the billions that have gone through it.

   Everything else, the queue, the ceilings, the retries, the waiting, is
   written here, because that is about OUR rules and not about cryptography.

   THE FOUR RULES THAT GOVERN THIS FILE

   1. The key has to match the operator address. It does not match, we do
      not work. A key from the wrong wallet means the money arrives
      somewhere other than where the plan computed; better to stop in the
      first second than halfway through the payout.

   2. The nonce is kept by us, not asked for before every send. The node
      answers with a delay, and two transactions in a row would get the
      same nonce: the second would silently replace the first.

   3. A ceiling on the gas price. The crank wakes up by the clock, not by
      reason: if it woke up during a spike, it has to refuse and wait for
      the next time rather than hand the epoch to the network.

   4. A transaction went missing: do NOT send it again. This is the most
      expensive temptation in code like this. No confirmation arrived, so
      we go and look by nonce whether it already went through; sending a
      second time means paying twice.
   ========================================================================= */

import { Wallet, Transaction, getAddress, keccak256, AbiCoder } from 'ethers';
import { rpc, ADDR } from './read.js';

const C = globalThis.ApexCore;

/* The ceiling on the gas price.

   Measured on August 29 against live blocks: the base price is 0.069 to
   0.090 gwei and barely moves, checked at the head of the chain and at
   blocks a hundred, a thousand, ten thousand and a hundred thousand back.
   What used to stand here was "around 0.0005 gwei"; that was wrong by a
   factor of a hundred and forty, and the whole estimate of what an epoch
   costs was built on that number.

   5 gwei is seventy-odd of the current prices. The point is not fine
   tuning but catching an obvious anomaly: a broken node that returned
   nonsense, or a real storm. */
export const MAX_GAS_PRICE_WEI = 5_000_000_000n;      // 5 gwei

/* How long to wait for a confirmation before going to investigate. */
export const WAIT_MS = 90_000;
const POLL_MS = 2_000;

/* Margin on top of the gas estimate. The estimate is made against the
   current state of the network, and the transaction will execute against
   the next one: by then the state has shifted, and the exact estimate may
   not be enough. 25% is the usual practice. */
const GAS_HEADROOM = 125n;

/* =========================================================================
   The wallet
   ========================================================================= */

/**
 * Prepares the signer. Throws if the key is from the wrong address.
 *
 * @param key       the operator's private key
 * @param expected  the address it is obliged to turn out to be
 */
export function operatorFrom(key, expected) {
  if (!key) throw new Error('the operator key is not set');
  let w;
  try {
    w = new Wallet(key.startsWith('0x') ? key : '0x' + key);
  } catch (_) {
    /* The message is deliberately without detail: nothing must reach the
       log by which the key could be recovered or the search narrowed. */
    throw new Error('the operator key is unreadable');
  }
  if (expected && getAddress(w.address) !== getAddress(expected)) {
    throw new Error('the key belongs to ' + w.address + ', but the operator is ' + expected);
  }
  return w;
}

/* =========================================================================
   The send queue

   One instance per one pass of an epoch. Keeps the nonce and makes sure
   transactions leave strictly one after another.

   Sequentially and not in a batch: the steps of an epoch are linked, first
   take the fee, then swap, then buy, then hand out. Sending them all at
   once means sending the buy before the money appeared on the wallet, and
   paying for the failure.
   ========================================================================= */

export class Sender {
  constructor(wallet, { chainId = C.CHAIN.id, maxGasPriceWei = MAX_GAS_PRICE_WEI,
                        dry = false, waitMs = WAIT_MS } = {}) {
    this.w = wallet;
    this.chainId = BigInt(chainId);
    this.maxGasPriceWei = maxGasPriceWei;
    this.dry = dry;
    /* The waiting time is a field and not a constant: otherwise the test
       for a "missing transaction" would have to wait a minute and a half,
       and it simply would not be run. */
    this.waitMs = waitMs;
    this.nonce = null;
    this.sent = [];             // what left during this pass, for the report and the post-mortem
  }

  /** The nonce is taken once per pass and after that it grows on our side. */
  async start() {
    const n = await rpc('eth_getTransactionCount', [this.w.address, 'pending']);
    this.nonce = Number(BigInt(n));
    return this.nonce;
  }

  /**
   * The gas price with the ceiling check.
   *
   * This network has no fee market in the usual sense, so we take
   * eth_gasPrice and pay it as maxFeePerGas. We keep the priority part
   * equal to the price: with no competition it is the whole price, and
   * shaving it means hanging in the queue for an indefinite time.
   */
  async gas() {
    const p = BigInt(await rpc('eth_gasPrice'));
    if (p > this.maxGasPriceWei) {
      throw new Error('gas price ' + p + ' wei is above the ceiling '
        + this.maxGasPriceWei + ' wei, skipping this pass');
    }
    return p;
  }

  /**
   * The gas estimate for one particular call.
   *
   * The estimate is made BEFORE sending and not silently: if the node says
   * the call will not go through, then our plan has diverged from the
   * state of the chain, and it is better to learn that here than to pay
   * for a failed transaction.
   */
  async estimate({ to, data = '0x', value = 0n }) {
    const hex = v => '0x' + BigInt(v).toString(16);
    const g = await rpc('eth_estimateGas', [{
      from: this.w.address, to, data, value: hex(value),
    }]);
    return (BigInt(g) * GAS_HEADROOM) / 100n;
  }

  /**
   * Sign and send one call. Returns the hash and the nonce.
   *
   * `label` is the human name of the step. It goes into the report and
   * into the journal, and by it you can afterwards see where exactly the
   * pass stopped.
   */
  async send({ to, data = '0x', value = 0n, gasLimit = null, label = '' }) {
    if (this.nonce === null) await this.start();

    const gasPrice = await this.gas();
    const limit = gasLimit ?? await this.estimate({ to, data, value });

    const tx = Transaction.from({
      type: 2,
      chainId: this.chainId,
      nonce: this.nonce,
      to: getAddress(to),
      value: BigInt(value),
      data,
      gasLimit: limit,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
    });

    const raw = await this.w.signTransaction(tx);
    const hash = keccak256(raw);
    const rec = { label, hash, nonce: this.nonce, gasLimit: limit, gasPrice };

    /* A dry run gets AS FAR AS this place: it signs for real and computes
       the hash, but does not send. That is how the whole path is checked,
       including the gas estimate and the assembly of the call, without a
       single wei spent. */
    if (this.dry) {
      rec.dry = true;
      this.nonce += 1;
      this.sent.push(rec);
      return rec;
    }

    await rpc('eth_sendRawTransaction', [raw]);
    this.nonce += 1;
    this.sent.push(rec);

    const receipt = await this.wait(hash, rec.nonce);
    rec.receipt = receipt;
    rec.ok = receipt && BigInt(receipt.status) === 1n;
    if (!rec.ok) throw new Error('step "' + label + '" reverted on chain, hash ' + hash);
    return rec;
  }

  /**
   * Wait for the confirmation.
   *
   * If there is no receipt within the allotted time, we do NOT send again.
   * Instead we ask the network for the wallet's current nonce: if it has
   * already passed the nonce of our transaction, the transaction went
   * through, the node just has not handed over the receipt yet. Sending
   * again at that moment is a second payment.
   */
  async wait(hash, nonce) {
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) return r;
      await new Promise(s => setTimeout(s, POLL_MS));
    }
    const mined = Number(BigInt(await rpc('eth_getTransactionCount', [this.w.address, 'latest'])));
    if (mined > nonce) {
      throw new Error('the transaction went through, but the node did not return a receipt in time. '
        + 'Hash ' + hash + ', nonce ' + nonce + '. Check it by hand before the next pass, '
        + 'sending it again would pay twice.');
    }
    throw new Error('no receipt in ' + (this.waitMs / 1000) + ' s and the nonce has not moved: '
      + 'the transaction is stuck. Hash ' + hash + ', nonce ' + nonce + '.');
  }

  /** What the pass actually cost. */
  spentWei() {
    return this.sent.reduce((a, r) => {
      const used = r.receipt ? BigInt(r.receipt.gasUsed) : r.gasLimit;
      return a + used * r.gasPrice;
    }, 0n);
  }
}

/* =========================================================================
   Assembling the calls

   Call data is assembled here and not at the place of use: the selector,
   the argument padding and the field order are the things that go wrong
   silently and are discovered only by the gas already spent.
   ========================================================================= */

const pad = v => BigInt(v).toString(16).padStart(64, '0');
const addr = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/* Selectors. Each one computed with keccak over the signature and checked,
   not copied from somewhere: a mixed-up selector is not a compile error but
   spent gas and a call to the wrong function. */
const SEL = {
  collectFees:      '0xa480ca79',   // collectFees(address)
  deposit:          '0xd0e30db0',   // deposit()
  withdraw:         '0x2e1a7d4d',   // withdraw(uint256)
  approve:          '0x095ea7b3',   // approve(address,uint256)
  transfer:         '0xa9059cbb',   // transfer(address,uint256)
  exactInputSingle: '0x04e45aaf',   // see the note at callSwapExactIn
  execute:          '0x3593564c',   // execute(bytes,bytes[],uint256) on the UniversalRouter
};

/* Native ether in V4 terms: the zero address. Not "no currency" but a
   currency, and it always sorts first, which is why our token in a pair
   with ether is almost always the second one. */
const NATIVE = '0x0000000000000000000000000000000000000000';

/* The router command and the actions inside it. The numbers are from
   Uniswap, not from memory: Commands.V4_SWAP = 0x10,
   Actions.SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f. */
const CMD_V4_SWAP = '10';
const ACT = { swapExactInSingle: '06', settleAll: '0c', takeAll: '0f' };

const POOL_KEY =
  'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

/* The addresses are taken straight from read.js: one list for the whole
   project. A second copy of it here would mean two lists of the same
   thing, and those diverge silently. */

/** collectFees(address) on the Pons locker. */
export function callCollectFees(token) {
  return { to: ADDR.locker, data: SEL.collectFees + addr(token), label: 'collect the fee' };
}

/** deposit() on WETH: wrap ether. */
export function callWrap(valueWei) {
  return { to: ADDR.weth, data: SEL.deposit, value: valueWei, label: 'wrap ether' };
}

/** withdraw(uint256) on WETH: unwrap it back. */
export function callUnwrap(amountWei) {
  return { to: ADDR.weth, data: SEL.withdraw + pad(amountWei), label: 'unwrap ether' };
}

/** approve(spender, amount) on an ERC20. */
export function callApprove(token, spender, amountWei) {
  return {
    to: token,
    data: SEL.approve + addr(spender) + pad(amountWei),
    label: 'approve ' + token.slice(0, 10),
  };
}

/** transfer(to, amount) on an ERC20. */
export function callTransfer(token, to, amountWei) {
  return {
    to: token,
    data: SEL.transfer + addr(to) + pad(amountWei),
    label: 'send ' + token.slice(0, 10) + ' → ' + to.slice(0, 10),
  };
}

/**
 * exactInputSingle on the router.
 *
 * What is deployed on this network is SwapRouter02, read off the explorer,
 * the contract is verified. It has seven fields and NO deadline, unlike
 * the old SwapRouter. That is not a detail: the two versions have
 * different selectors, and a call against the wrong one simply will not
 * find the function.
 *
 *   SwapRouter02  exactInputSingle((address,address,uint24,address,
 *                 uint256,uint256,uint160))            → 0x04e45aaf
 *   the old one   the same list plus uint256 deadline  → 0x414bf389
 *
 * Both selectors were computed with keccak, not taken from memory.
 *
 * The field order is not rearranged: the encoding is positional, and
 * `amountOutMinimum` swapped with `sqrtPriceLimitX96` gives not an error
 * but a swap at any price.
 */
/**
 * Buying on Uniswap V4 through the UniversalRouter.
 *
 * WHY NOT THE WAY V3 DOES IT. On V3 every pair has its own contract, and
 * the wallet calls the router with one function. On V4 all the pools sit
 * in one PoolManager, and it does not exchange coins on a direct call: it
 * unlocks and calls back into the code of whoever called it. A wallet has
 * no code, so the callback fails. That is why the swap goes through an
 * intermediary, the UniversalRouter.
 *
 * WHAT IS INSIDE. The router is given a list of commands and an input for
 * each of them:
 *
 *   execute(commands, inputs, deadline)
 *     commands = 0x10                      one command: swap on V4
 *     inputs[0] = (actions, params[])       what exactly to do inside it
 *       actions = 06 0c 0f                  swap, settle, take
 *       params[0] = the swap parameters
 *       params[1] = what we pay with and at most how much
 *       params[2] = what we take and at least how much
 *
 * Three actions and not one: on V4 a swap only moves debts around inside
 * the PoolManager. Not settling the debt reverts the whole transaction;
 * not taking what was bought leaves the coins in the PoolManager, and that
 * will look like a successful purchase after which nothing arrived.
 *
 * THE ENCODING IS SOMEONE ELSE'S, AND THAT IS ON PURPOSE. Nested `bytes[]`
 * by hand is exactly the place where a mistake does not break the call but
 * changes its meaning: "how much I pay" swapped with "how much I get at
 * least" gives not a refusal but a swap at any price. ethers does the
 * encoding, and it was not proven by us.
 *
 * NATIVE ETHER. If we pay with native ether, it goes in the value field of
 * the same transaction. Wrapped ether would require a chain of approvals
 * through Permit2, and that is deliberately absent here: all our V4 pools
 * are paired with native ether, and writing an unused path to other
 * people's money is not allowed.
 */
export function callSwapV4({ key, token, amountIn, minOut, deadline }) {
  if (String(key.hooks).toLowerCase() !== NATIVE) {
    /* A pool with a hook can demand hookData we do not know, and can
       refuse by its own rules. A refusal here is cheaper than a guess: the
       seat stays without a purchase, and its share goes to the others. */
    throw new Error('a pool with the hook ' + key.hooks + ': swapping through it is not written');
  }

  const t = String(token).toLowerCase();
  const zeroForOne = key.currency0.toLowerCase() !== t;
  const currencyIn  = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  if (currencyIn.toLowerCase() !== NATIVE) {
    throw new Error('we would have to pay with something other than native ether (' + currencyIn + ')');
  }

  const abi = AbiCoder.defaultAbiCoder();
  const poolKey = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];

  const params = [
    abi.encode(
      ['tuple(' + POOL_KEY + ' poolKey,bool zeroForOne,uint128 amountIn,'
        + 'uint128 amountOutMinimum,bytes hookData)'],
      [[poolKey, zeroForOne, amountIn, minOut, '0x']]),
    abi.encode(['address', 'uint256'], [currencyIn, amountIn]),
    abi.encode(['address', 'uint256'], [currencyOut, minOut]),
  ];

  const actions = '0x' + ACT.swapExactInSingle + ACT.settleAll + ACT.takeAll;
  const input = abi.encode(['bytes', 'bytes[]'], [actions, params]);
  const body = abi.encode(['bytes', 'bytes[]', 'uint256'],
                          ['0x' + CMD_V4_SWAP, [input], deadline]);

  return {
    to: ADDR.universalRouter,
    data: SEL.execute + body.slice(2),
    value: amountIn,
    label: 'buy v4 ' + String(token).slice(0, 10),
  };
}

export function callSwapExactIn({ tokenIn, tokenOut, fee, recipient, amountIn, minOut }) {
  const data = SEL.exactInputSingle
    + addr(tokenIn) + addr(tokenOut) + pad(fee) + addr(recipient)
    + pad(amountIn) + pad(minOut) + pad(0);
  return { to: ADDR.swapRouter, data, label: 'buy ' + tokenOut.slice(0, 10) };
}
