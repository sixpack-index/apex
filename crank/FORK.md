# Rehearsing an epoch on a fork

A fork is a local copy of the live chain on your own machine. It takes the
chain's real state: Pons's contracts, the pools, the balances, and lets you
sign anything with fake ether. Nothing leaves the machine and nothing costs
money.

This rehearsal is what the whole thing was written for. It catches what code
can catch: whether the swap settles against the real pools, whether the
payout survives its five-hundredth transfer, whether the journal counts one
distribution twice.

> **Checked right here, August 29.** The buy went through on the fork for
> real, with a signature and with money, on both venues:
>
> | seat | venue | bought | the quote promised |
> |---|---|---|---|
> | DOGO | v4 | 833.86 | 833.86 |
> | PIPEDOG | v3 | 9408.83 | 9408.83 |

> **On August 31 an epoch closed end to end**, for the first time. The wrap,
> the approval for the router, the buy, the payout to 21 wallets, the entry
> in the journal:
>
> ```
> wrapped 2.995331 ETH
> PIPEDOG  0x0507979a93c8ad6a60eeec508ada5ba66ac926ea49e2fcc1680209108ec22f67
> handing out  PIPEDOG  2,602,515.19 to 21 wallets
> The epoch is closed. Run #1, gas spent 0.001390 ETH.
> ```
>
> The run was on one seat instead of ten (`seats: 1` in a copy of the
> project), not because ten do not work, but because every quote on a cold
> fork takes tens of seconds, see "The fork is cold" below. What was being
> checked is the "bought it and handed it out" path, while the rule about
> the ten is checked separately and without a chain.

## WHAT THIS RUN FOUND

**The crank could not close a single epoch. Not one, the dry run included.**

In `tick()`, on the payout line, stood `const holders = plan.payout.filter(…)`,
and it shadowed the function of the same name imported from `read.js`. A
`const` is visible throughout the body of the function from the first line,
so the call `await holders(CFG.token, floor)` two hundred lines ABOVE failed
with `Cannot access 'holders' before initialization`. It never got as far as
the payout.

Not one of the 156 checks saw this, and none of them could: they all call
the parts separately, and not one of them runs `tick()` whole. That is
exactly what the fork is for.

The variable was renamed to `payees`.

---

## What you need

**Foundry**, of which only `anvil` is used:

```
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

**Project dependencies**, once:

```
npm install
```

They are needed only by the signing layer (`ethers`); the other checks run
on bare node.

---

## 1. Start the fork

```
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
```

`--chain-id 4663` is optional but useful: without it anvil comes up as
network 31337 and the crank will honestly say this is not Robinhood Chain.
The contracts are real either way.

Anvil prints ten ready wallets with their private keys and 10,000 fake ETH
on each. The first of them is the operator.

The node lives at `http://127.0.0.1:8545` for as long as the window stays
open.

---

## 1a. Make the fork mine one block of its own

**A required step; without it nothing reads.**

```
curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["0x1"]}'
```

Why: anvil takes the header of the first block straight from the chain, and
Robinhood Chain does not fill in the blob gas fields, which appeared after
it. While the fork stands on that inherited block, **any read fails** with
`Excess blob gas not set`, and there is nothing to be learned from that
line.

A block of its own anvil composes itself, and after that everything works.
Transactions, by the way, go through even without this; only reading breaks,
which is more confusing still.

If you forget, the crank will remind you: it recognises this error and
prints exactly that command.

**The event history the crank asks of the live node, not of the fork.** A
fork copies the state of the chain but not the event log, and the V4 pool
keys are not found on it at all. This already happens by itself; your own
archive node can override it through `APEX_LOGS_RPC`.

---

## 2. Dry run against the fork

```
APEX_RPC=http://127.0.0.1:8545 \
APEX_TOKEN=0x…   \
APEX_OPERATOR=0x… \
node crank/index.js
```

The crank's first line says which node it connected to. Check that it reads
`OWN NODE · http://127.0.0.1:8545` and not "the live node". On a fork
everything looks exactly like production, and that line is the only thing
that tells them apart.

The token at this step is any live one on Robinhood Chain: ours does not
exist yet, and what is being checked is the path, not the name. The operator
is anvil's first wallet.

---

## 3. Live run against the fork

The same plus a key and `--live`:

```
APEX_RPC=http://127.0.0.1:8545 \
APEX_TOKEN=0x… \
APEX_OPERATOR=0x… \
APEX_WALLET_KEY=0x… \
node crank/index.js --live
```

The key belongs to that same first anvil wallet. It is fake and lives only
in that window; there is no reason to put a real key here.

**If the node line says "the live node" rather than "OWN NODE", do not run
it.** With `--live` against the live node the transactions go out for real,
and the crank warns about it on a line of its own.

---

## What should happen

The crank walks the whole path: it takes the balance off the working wallet,
wraps the ether, buys the ten, hands them out to holders and writes every
step to the journal.

It does **not** collect the fee, and it cannot: `collectFees` admits only
the owner of the locker. A friend takes the fee and forwards it to you, and
you put the ether on the working wallet yourself. The epoch is counted from
the balance sitting there. If it stops somewhere, that stop is the result of
the rehearsal: until today nobody knew about that break.

A couple of things look different on a fork and are not faults:

- **The fork is cold, and the first quote in every pool fails.** Anvil pulls
  state from the live chain as it needs it, while the V3 quoter walks ticks
  in tens of slots; on the first walk part of the requests come back as an
  error instead of data, and the crank honestly prints "nowhere to buy" for
  every seat at once. It looks like a breakage in the code, but it is not:
  the same quotes compute on the second try.

  The cure is a warm-up, one small quote into every pool before the run:

  ```
  APEX_RPC=http://127.0.0.1:8545 node -e "
  (async()=>{const R=await import('./crank/read.js');
   const C=(await import('./core.js'),globalThis.ApexCore);
   const b=await C.readBasket();
   for(const x of b.basket){ try{ await R.quote({token:x.address,
     amountWei:10n**16n, priceNative:x.priceNative, pairId:x.pairId,
     ethPairIds:x.ethPairIds||[]}); console.log('warm',x.sym);
   }catch(e){ console.log('once more',x.sym); } }})();"
  ```

  Warming one pool takes from fifteen seconds to a minute and a half: every
  cache miss is a separate trip to the live chain. Ten seats warm up over
  minutes, and that is normal. On a live node the state is always warm, and
  the question does not come up at all.

- **`--no-rate-limit` is required.** Without it anvil throttles its own trips
  to the live chain, and the holder snapshot comes back full of holes: on a
  token with 1366 addresses, 287 balances would not read. The crank catches
  this and refuses to close the epoch ("the snapshot is incomplete"), so the
  guard works, but because of it nothing can be checked.

- **The token must have been launched through Pons.** Not every coin on the
  chain is: neither `$PONS` nor `$PONSFOLIO` is listed in the factory, and
  the crank honestly says "token was not launched through Pons". A suitable
  one can be found like this: look at who the locker collected a fee from
  recently, and take it from there:

  ```
  node -e "…eth_getLogs on the locker address, then the address from the
           input of a transaction with method 0xa480ca79 (collectFees)…"
  ```

  Three live ones as of August 31: `0x7fe995a8…` (1366 holders),
  `0xb29cedad…` (27), `0x5ef0f8ff…` (4). For a rehearsal take the smallest:
  there are as many transfers as there are holders.

- **Gas prices.** They are the fork's own and bear no relation to the live
  ones. Measuring the cost of an epoch by them is meaningless.
- **Block time.** Anvil mines a block per transaction instantly; the live
  chain does not. Races that only show up under real latency will not appear
  on a fork.
- **The double-payout journal** needs a real Postgres:
  `DATABASE_URL=… node crank/check-journal.js`. A fake one would not check
  the thing it was written for.

---

## If something goes wrong

The fork can be restarted at any moment: its state resets to the current
live block and the rehearsal starts from a clean sheet. That is its main
property, that making a mistake here costs nothing.
