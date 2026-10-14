/* =========================================================================
   Reading the chain for the crank. Read-only: nothing is signed and
   nothing is sent, this file needs no key.

   THIS IS SOLANA, AND WHAT DIFFERS IS NOT THE SYNTAX

   The previous version of this file read Pons: the fee locker, the Uniswap
   pools, ticks, quoters. Every number there was obtained by a contract
   call, and half the file was a table of selectors. None of that is here,
   and the reason is not that things got simpler. They got DIFFERENT, and
   there are exactly four differences, each of which changes a decision
   rather than a line.

     1. THE FEE DOES NOT ACCRUE ON A POSITION. On pump.fun the creator fee
        lands on a separate account derived from the creator's address, and
        the creator takes it himself. That account is an ordinary one, with
        a balance in lamports, and its balance is read with a single call.
        No collectFees with two tokens on the way out: plain SOL arrives.

     2. THE RATE IS NOT A CONSTANT. It falls as the market cap grows, from
        0.95% down to 0.05%, and the table lives in core.js. So "how much
        will accrue over an epoch" is not predicted here at all: what gets
        read is how much HAS ACCRUED.

     3. BUYING HAS TO GO THROUGH SOMEONE ELSE'S ROUTER. On Solana there is
        no single Uniswap: liquidity is spread across Raydium, Orca,
        Meteora, PumpSwap and another ten venues, and each one has its own
        call format. Writing that by hand means writing an aggregator, and
        writing it badly. So the route is asked of Jupiter, and Jupiter
        hands back a ready transaction too. All we do is sign it.

     4. THE HOLDER LIST COMES FROM THE NODE, NOT FROM AN EXPLORER. That is
        both good and bad. Good: the answer is complete and exact, with no
        paged output from an explorer. Bad: a free node answers such a
        request with a refusal or with emptiness, and emptiness is worse
        than a refusal. So there is a separate guard below, and it is loud.

   Every address and size below was checked with calls to the live node,
   not taken from an article. What exactly was measured is written next to
   each one.
   ========================================================================= */

import './../core.js';
import bs58 from 'bs58';

const C = globalThis.ApexCore;

/* =========================================================================
   THE NODE

   The live public one by default. For a dry run and for the holder list
   you put your own, paid one here: see `holders` below.
   ========================================================================= */
const RPC = process.env.APEX_RPC || C.CHAIN.rpc;
export const RPC_URL = RPC;
export const IS_DEFAULT_RPC = RPC === C.CHAIN.rpc;

/* The public Solana node holds about ten requests per second from one
   address and answers 429 when there are more. That is not a network
   error, that is the norm, and a retry has to wait instead of firing at
   once. */
const TIMEOUT_MS = 25_000;

let id = 0;

/**
 * A request to the node. Retries are mandatory: the node is shared, and
 * "fetch failed" or a 429 out of nowhere is an everyday thing here.
 *
 * The `globalThis.__rpcHook` hook is the only seam for substituting the
 * node in the checks. It is needed because the send layer has to be
 * checked where there is no node: batches, vanished signatures, a repeat
 * send, those are our rules and not the behavior of the network, and
 * running a live chain for them means not checking them at all. In live
 * mode the hook does not exist, and the branch is not executed.
 */
export async function rpc(method, params = [], tries = 4) {
  if (typeof globalThis.__rpcHook === 'function') {
    return globalThis.__rpcHook(method, params);
  }

  let last;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      /* A 429 means "too often", and it has a pause of its own, a longer
         one. The node asked us to wait, not to retry immediately. */
      if (res.status === 429) {
        last = new Error('the node limited the rate (429)');
        await new Promise(r => setTimeout(r, 2000 * (k + 1)));
        continue;
      }
      if (!res.ok) throw new Error('the node answered ' + res.status);
      const d = await res.json();
      if (d.error) {
        const msg = (d.error.message || 'node error');
        /* Retrying a refusal on the merits is pointless: the answer will
           not change. On Solana there are two common kinds, and both are
           about a forbidden method. */
        if (/not supported|disabled|excluded|unauthorized/i.test(msg)) {
          throw Object.assign(new Error(msg), { fatal: true });
        }
        throw new Error(msg);
      }
      return d.result;
    } catch (e) {
      last = e;
      if (e && e.fatal) break;
      await new Promise(r => setTimeout(r, 700 * (k + 1)));
    }
  }
  throw new Error(method + ': ' + (last && last.message ? last.message : 'the node did not answer'));
}

/* =========================================================================
   WHICH CLUSTER THIS IS

   There is no network number on Solana at all, and at first that looks
   like the absence of a guard: on the previous chain live mode switched on
   only when the chainId matched. But every cluster has its own hash of the
   first block, and that is STRICTER than a number. A number is set by how
   the node was started and is faked with one line in a config; the hash is
   computed from the contents of the block, and faking it means faking the
   whole cluster.

   The hashes below were checked against the getGenesisHash answer of the
   public nodes of each cluster on October 14, 2026.
   ========================================================================= */
export const GENESIS = {
  mainnet:  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet:   'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet:  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

/* The value out of the node's answer: almost every Solana method returns
   { context, value }, and writing `.value` in twenty places means
   forgetting it once. */
const val = (r) => (r && typeof r === 'object' && 'value' in r ? r.value : r);

/* =========================================================================
   ADDRESSES AND SIZES

   Checked against the live node on October 14, 2026: each one was read
   with a getAccountInfo call, and for each one the owning program
   matched.
   ========================================================================= */
export const PROG = {
  /* Two token programs, not one. The old one and Token-2022 live side by
     side, a coin may have either, and a transfer is made by the program
     that OWNS THE COIN. Substituting the wrong one means getting a refusal
     on the very first transfer, that is, in the middle of the payout. So
     `ownerProgramOf` below asks the chain about it instead of guessing. */
  token:     'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata:       'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  system:    '11111111111111111111111111111111',

  /* pump.fun: the curve itself and its AMM. Needed not for trading (we
     trade through Jupiter) but to find the account on which the creator
     fee accrues. */
  pump:      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpAmm:   'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
};

/* The size of a token account under the old program is 165 bytes, and that
   is the key to the holder list: everything else belonging to the program
   is filtered out by it. Under Token-2022 the size is larger and variable,
   so the size filter is applied to the old program only. Checked: exactly
   165. */
export const TOKEN_ACCOUNT_SIZE = 165;

/* Offsets inside a token account. Needed for the filter by coin and for
   parsing the answer without jsonParsed, when the node does not give it. */
export const OFF = { mint: 0, owner: 32, amount: 64 };

/* =========================================================================
   SIMPLE READS
   ========================================================================= */

/** The current slot. Like a block number: it dates the snapshot. */
export const slot = async () => Number(await rpc('getSlot'));

/** The balance in lamports. */
export async function solBalance(addr) {
  return BigInt(val(await rpc('getBalance', [addr])) ?? 0);
}

/**
 * The supply and the decimals of a coin.
 *
 * Taken from the chain, not from a constant in the code: a constant will
 * one day diverge from the chain, and then the shares go wrong silently.
 * On pump.fun the supply is a billion with nine decimals, but that has to
 * be checked against the coin, not against memory.
 */
export async function supplyOf(mint) {
  const s = val(await rpc('getTokenSupply', [mint]));
  if (!s || s.amount === undefined) throw new Error('the node did not give the supply of the coin');
  const decimals = Number(s.decimals);
  const raw = BigInt(s.amount);
  return { raw, decimals, supply: Number(raw) / Math.pow(10, decimals) };
}

/** Which program owns the coin: the old one or Token-2022. */
export async function ownerProgramOf(mint) {
  const a = val(await rpc('getAccountInfo', [mint, { encoding: 'base64' }]));
  if (!a) throw new Error('the coin ' + mint + ' was not found in the chain');
  const owner = a.owner;
  if (owner !== PROG.token && owner !== PROG.token2022) {
    throw new Error('the address ' + mint + ' is not a coin: it is owned by ' + owner);
  }
  return owner;
}

/**
 * How much of the coin the owner holds. The sum over all of his accounts
 * for this coin, not over one of them: there may be several accounts, and
 * the first of them is sometimes empty.
 */
export async function tokenBalance(mint, owner) {
  const r = val(await rpc('getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed' }])) || [];
  let sum = 0n;
  for (const it of r) {
    const amt = it?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt !== undefined) sum += BigInt(amt);
  }
  return sum;
}

/**
 * The rent deposit for a token account, LIVE, from the node.
 *
 * The same figure sits in plan.js as a constant, and there it is for a
 * rough estimate and for the checks. Before a live settlement it has to be
 * taken from here: the rent is being lowered in stages, and those two
 * numbers can diverge at any moment. Diverge they will, and then the crank
 * computes the wrong cost, and that gets noticed in the middle of the
 * payout.
 */
export async function rentExempt(size = TOKEN_ACCOUNT_SIZE) {
  return BigInt(await rpc('getMinimumBalanceForRentExemption', [size]));
}

/* =========================================================================
   A TOKEN ACCOUNT: DERIVING THE ADDRESS

   The address of a token account is derived from the coin and the owner,
   without asking the chain. That is needed twice: to count how many
   accounts are missing (before the decision), and to assemble the transfer
   (after it).

   The derivation lives in send.js, where the curve library already is.
   Here there is only the CHECK FOR EXISTENCE by ready addresses: that one
   is a pure read.
   ========================================================================= */

/**
 * How many of the listed accounts do not exist.
 *
 * Asked in batches of a hundred: that is what getMultipleAccounts takes at
 * a time. For a thousand holders and ten coins that is a hundred calls,
 * and that is tolerable, it is counted once per epoch, before the
 * decision.
 *
 * What comes back is not only the number but the missing accounts
 * themselves: they have to be created later, and exactly they.
 */
export async function whichMissing(addresses) {
  const missing = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const r = val(await rpc('getMultipleAccounts', [chunk, { encoding: 'base64' }])) || [];
    for (let k = 0; k < chunk.length; k++) if (!r[k]) missing.push(chunk[k]);
  }
  return missing;
}

/* =========================================================================
   THE HOLDER LIST

   THE MOST DANGEROUS PLACE IN THE WHOLE CRANK, AND IT IS DANGEROUS
   QUIETLY.

   There is one request: getProgramAccounts on the token program, with a
   filter by account size and by coin. The answer is every account of this
   coin at once, with the owner and the balance. That is better than it was
   on the previous chain, where the list was assembled by walking an
   explorer page by page and could break off halfway.

   WHAT THE MEASUREMENT SHOWED, AND WHERE I WAS WRONG

   At first I wrote down that a free node answers this request with an
   empty array and a 200, and that a paid one is needed. The first part
   turned out to be untrue. Measured on October 14 against the ten coins of
   our own basket, the public node api.mainnet-beta.solana.com:

     PUMP    1 027 640 accounts   292 MB   15.4 s
     RAY     1 131 296 accounts   321 MB   15.2 s
     KMNO      282 847 accounts    80 MB    4.0 s
     arc       182 731 accounts    52 MB    2.7 s
     HYPE, MU       refused with 413 after half a second

   So it does give the list, and it gives it whole even for a million
   accounts. The 413 refusal comes not from the size of the coin but from
   the load: it arrived on the eighth and the ninth request in a row, when
   the previous ones had already pulled half a gigabyte. That is load
   shedding, not a ceiling.

   TWO CONCLUSIONS FOLLOW, AND BOTH ARE IN THE CODE

   1. dataSlice IS MANDATORY. Without it the answer arrives parsed into
      JSON, and for a million accounts that is more than half a gigabyte of
      text: node dies on it with ERR_STRING_TOO_LONG without even getting
      as far as the parsing. Caught right here, by the first measurement.
      With dataSlice we take forty bytes per account instead of a hundred
      and sixty-five: the owner and the balance, the rest we do not need.
      We parse it ourselves, by hand.

   2. AN EMPTY LIST FOR A LIVE COIN IS A REFUSAL ALL THE SAME. Even though
      we have never seen one: the price of a mistake here is not
      symmetrical. Taking emptiness for the truth means deciding that there
      are no holders and honestly reporting that there is nobody to pay,
      and that will look like "nobody bought the coin".

   A paid node is still needed, but for a different reason than I thought:
   not because the public one cannot, but because the public one does not
   have to. On launch day APEX will have thousands of accounts, not a
   million, and the answer will weigh kilobytes. A refusal from the load
   can arrive at any moment even so, and then the epoch simply does not
   close until the next time.
   ========================================================================= */

/**
 * A snapshot of the holders.
 *
 * @param mint    the address of the coin
 * @param floor   the floor in whole coins (not in minimal units)
 * @returns { holders, listed, failed, complete, why, slot, decimals }
 */
export async function holders(mint, floor, opts = {}) {
  const at = opts.slot ?? await slot();
  const sup = opts.supply ?? await supplyOf(mint);
  const program = opts.program ?? await ownerProgramOf(mint);

  const filters = [{ memcmp: { offset: OFF.mint, bytes: mint } }];
  /* The size filter is for the old program only: under Token-2022 the size
     depends on the set of extensions, and a hard number would cut off real
     accounts. The filter by coin is enough, and it is the main one
     anyway. */
  if (program === PROG.token) filters.unshift({ dataSize: TOKEN_ACCOUNT_SIZE });

  let raw;
  try {
    raw = val(await rpc('getProgramAccounts',
      [program, {
        encoding: 'base64',
        /* Forty bytes instead of a hundred and sixty-five: the owner (32)
           and the balance (8), one after the other, starting from the
           thirty-second byte. The rest of the account we do not need for
           anything. */
        dataSlice: { offset: OFF.owner, length: 40 },
        filters,
      }]));
  } catch (e) {
    return {
      holders: [], listed: 0, failed: 0, complete: false, slot: at,
      decimals: sup.decimals,
      why: 'the node refused the list of accounts: ' + (e.message || e) + '.\n'
         + (/413/.test(String(e.message))
            ? '    A 413 is load shedding, not a ceiling: the same node gives\n'
            + '    even a million accounts when it is not busy. The epoch simply\n'
            + '    will not close until the next time.\n'
            : '')
         + '    ' + whyPaidNode(),
    };
  }

  const list = Array.isArray(raw) ? raw : [];

  /* Emptiness for a live coin is a refusal, not an answer. See the
     reasoning above. */
  if (!list.length && sup.raw > 0n) {
    return {
      holders: [], listed: 0, failed: 0, complete: false, slot: at,
      decimals: sup.decimals,
      why: 'the node returned an EMPTY list of accounts, although the supply of the coin is '
         + sup.supply.toLocaleString('en-US') + ', which means the accounts exist.\n'
         + '    ' + whyPaidNode(),
    };
  }

  const unit = Math.pow(10, sup.decimals);
  const floorRaw = BigInt(Math.round(floor * unit));

  /* ADD UP FIRST, CUT OFF SECOND. THE ORDER HERE IS SOMEBODY'S MONEY.
   *
   * It used to be the other way round: the floor was applied to EVERY
   * account, and only the survivors were added up by owner. One and the
   * same person may hold the coin on several accounts, that is how
   * wallets work when they open a new account on every purchase through
   * certain venues. If he has two accounts with 0.006% of supply on each,
   * together that is 0.012%, so he clears the floor. The old way threw
   * out both and he got nothing.
   *
   * The refusal was quiet and against him: he simply did not appear in
   * the list. Adding up has to come first, because the floor is promised
   * to the HOLDER and not to the account: the docs say "a wallet must
   * hold at least 0.01% of supply", and a wallet here is the owner.
   *
   * Zero accounts are dropped straight away: they would add nothing to
   * the sum, and about a third of a coin's account list is made of them. */
  const byOwner = new Map();
  let failed = 0;
  for (const it of list) {
    const parsed = parseSlice(it);
    if (!parsed) { failed++; continue; }
    const { owner, raw: r } = parsed;
    if (r === 0n) continue;
    const prev = byOwner.get(owner);
    if (prev) { prev.raw += r; prev.accounts.push(it.pubkey); }
    else byOwner.set(owner, { address: owner, raw: r, accounts: [it.pubkey] });
  }

  const merged = [...byOwner.values()]
    .filter(h => h.raw >= floorRaw)
    .map(h => ({ ...h, balance: Number(h.raw) / unit, account: h.accounts[0] }))
    .sort((a, b) => (a.raw < b.raw ? 1 : -1));

  return {
    holders: merged,
    listed: list.length,
    failed,
    complete: failed === 0,
    why: failed ? 'accounts not parsed: ' + failed : null,
    slot: at,
    decimals: sup.decimals,
  };
}

/**
 * Parsing one account out of the trimmed answer.
 *
 * Forty bytes: the owner is the first thirty-two, the balance is the next
 * eight, as a number starting from the LOW byte. The byte order here is no
 * detail: read them the other way round and a balance of a hundred coins
 * turns into an astronomical number, and the shares get computed from it.
 * There is a check for this, and it compares the parsing against a real
 * account out of the chain.
 *
 * Separately: jsonParsed will never come back here. For a million accounts
 * it gives more than half a gigabyte of text, and node dies on it with
 * ERR_STRING_TOO_LONG without getting as far as the parsing. That is
 * measured, not assumed.
 */
export function parseSlice(it) {
  const d = it?.account?.data;
  const b64 = Array.isArray(d) ? d[0] : (typeof d === 'string' ? d : null);
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 40) return null;
  const owner = bs58.encode(buf.subarray(0, 32));
  const raw = buf.readBigUInt64LE(32);
  return { owner, raw };
}

function whyPaidNode() {
  return 'A free node does not give the holder list. A paid one is needed:\n'
       + '    Helius, Triton, QuickNode or any with getProgramAccounts\n'
       + '    enabled. The address goes into APEX_RPC.\n'
       + '    The crank will not pay out from an incomplete list: the shares are\n'
       + '    computed from the sum of the balances, and an incomplete sum means\n'
       + '    the wrong share for everyone.';
}

/* Addresses that never count as holders.

   On Solana this list is shorter than on EVM: there is no zero address,
   and burning is done not with a transfer to an address but with a burn
   instruction. What is left is the system program, where a coin only ever
   lands by mistake, and the incinerator, where it is sent on purpose. The
   pools and the operator's wallet are added to the exclusions separately,
   over in index.js: their addresses are known only there. */
export const NOT_HOLDERS = [
  '11111111111111111111111111111111',                // the system program
  '1nc1nerator11111111111111111111111111111111',     // the agreed incinerator
];

/* =========================================================================
   WHAT ACCRUES: THE CREATOR FEE

   On pump.fun the creator fee lands not on the creator's wallet but on a
   separate account derived from his address. Only he can take it. The
   crank does not reach in there and must not: under the scheme adopted on
   the previous chain and kept here, the owner takes the fee himself and
   himself decides how much to move over to the working wallet.

   So this function is informational: it shows how much has accrued, and
   that is enough for the console to make it visible whether it is time to
   move money over. The size of the epoch is counted from the balance ON
   THE WORKING wallet.

   The address of the account is derived as a PDA from "creator-vault" and
   the creator's address. The derivation needs the curve, it is in send.js;
   here there is only the read of the balance by a ready address.
   ========================================================================= */
export async function vaultPot(vault) {
  const lamports = await solBalance(vault);
  /* There is always a deposit for existence sitting on the account, and it
     is not income. We subtract the size of the deposit for an empty
     account: otherwise the console shows something accrued where nothing
     has accrued. */
  const rent = await rentExempt(0);
  return { lamports, rent, free: lamports > rent ? lamports - rent : 0n };
}

/* =========================================================================
   THE PRICE OF A PURCHASE: JUPITER

   The route is asked of the aggregator instead of being assembled by hand.
   The reason is not laziness: on Solana liquidity is spread across a dozen
   venues with different call formats, and a router of our own would mean
   an aggregator of our own, written worse and checked not at all.

   Here there is only the QUOTE, a pure read. The ready transaction is
   fetched in send.js: it requires a signature, and its place is there.

   Separately: slippageBps. Three percent, the same as on the previous
   chain. Zero would mean the epoch falls apart from anybody else's trade,
   a lot would mean we get swapped at any price at all.
   ========================================================================= */
/* WHICH ADDRESS THE AGGREGATOR HAS, AND WHY THAT IS WORTH WRITING DOWN

   The first thing here was `quote-api.jup.ag/v6`. That is what half the
   articles say, and it is already untrue: the sixth version is marked
   deprecated, access to it is being narrowed step by step, the limits are
   being cut. A crank that goes there will one day stop buying, not at once
   and not loudly but by degrees, and it will look like "there is no
   route".

   Checked on October 14, 2026 with a live request, not against the docs:

     lite-api.jup.ag/swap/v1   answers, asks for no key. This is the free
                               entrance, and it is declared to be going
                               away, but the shutdown date has been moved
                               and there is no new one yet.
     api.jup.ag/swap/v1        the same path, but it requires a key in the
                               x-api-key header.

   So the free one by default, and moving over does not take a code change:
   set APEX_JUP_KEY (and, if it comes to that, APEX_JUP_BASE). The day the
   free entrance closes must not require a deploy. */
const JUP_KEY = process.env.APEX_JUP_KEY || '';
const JUP_BASE = (process.env.APEX_JUP_BASE
  || (JUP_KEY ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1'))
  .replace(/\/+$/, '');

export const JUP = {
  base:  JUP_BASE,
  quote: JUP_BASE + '/quote',
  swap:  JUP_BASE + '/swap',
  headers: JUP_KEY
    ? { accept: 'application/json', 'user-agent': C.UA, 'x-api-key': JUP_KEY }
    : { accept: 'application/json', 'user-agent': C.UA },
};

export const SLIPPAGE_BPS = 300;

/**
 * What this many lamports will swap into.
 *
 * @returns { out, route, venue, impact } or throws with a reason
 */
export async function quote({ mint, lamports, slippageBps = SLIPPAGE_BPS }) {
  if (!lamports || BigInt(lamports) <= 0n) throw new Error('nothing to swap');
  const u = JUP.quote
    + '?inputMint=' + C.CHAIN.quote
    + '&outputMint=' + mint
    + '&amount=' + BigInt(lamports).toString()
    + '&slippageBps=' + slippageBps
    + '&onlyDirectRoutes=false';

  const res = await fetch(u, {
    headers: JUP.headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    /* Our own message, not somebody else's code: "nowhere to buy" is a
       decision about the epoch, and the reason has to read without the
       Jupiter docs. */
    if (res.status === 400 && /no route|not tradable|could not find any route/i.test(t)) {
      throw new Error('there is no route');
    }
    /* A refusal over the key has to be told apart from "no route" out
       loud: the first is cured by a variable, the second is cured by
       nothing. Confusing them means one day deciding that ten coins went
       untradable all at once. */
    if (res.status === 401 || res.status === 403) {
      throw new Error('the aggregator did not let us in (' + res.status + '): a key is needed in APEX_JUP_KEY');
    }
    if (res.status === 429) throw new Error('the aggregator limited the rate (429)');
    throw new Error('the aggregator answered ' + res.status);
  }
  const d = await res.json();
  if (!d || !d.outAmount) throw new Error('there is no route');

  const hops = (d.routePlan || []).map(p => p?.swapInfo?.label).filter(Boolean);
  return {
    out: BigInt(d.outAmount),
    route: d,
    venue: hops.length ? hops.join(' → ') : 'direct',
    impact: d.priceImpactPct !== undefined ? Number(d.priceImpactPct) * 100 : null,
  };
}

/* =========================================================================
   NAMES THAT ARE GONE

   The previous version exported ADDR, SEL, POOL_FEE, FEE_TIERS, quoteV3,
   quoteV4, v4PoolsFor, v4KeyById, paysInEth, launchInfo, poolPot, poolFor,
   erc20Balance, ethBalance, gasPrice, head, feeLabel, decimalsOf.

   Not one of them means anything on Solana: there are no pool fee tiers,
   there are no pool keys, there is no gas price in the old sense, there
   are no selectors. Leaving them as stubs means leaving code that somebody
   will one day call and get plausible nonsense back. So they are gone
   entirely, and index.js is rewritten for the new ones.
   ========================================================================= */
