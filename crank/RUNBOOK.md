# How to run an epoch without spending money

This file replaced `FORK.md`. A fork was a notion of the previous chain: a
local copy of the network through `anvil --fork-url`, where you can sign
whatever you like with fake ether. On Solana the way to check the crank is
a different one, and it is simpler.

## The main difference: the dry run now really does check

On the previous chain a dry run only printed the intention. Nobody checked
the assembled call, and an error in it was discovered by the first live
signature, that is, with money. That is why a fork was needed.

Here a dry run **simulates every transaction against the live node**. It
assembles the transaction with the same code, signs it, hands it to the
node and gets an answer: would it have gone through, how much compute did
it eat, what logs did the programs produce. Nothing goes outside while that
happens, the simulation is executed at the node, in memory.

This is strictly better than a fork in one important sense: the state is
real. A fork copied state as it went along and lied on a cold walk (on the
previous chain that made all ten quotes fail with "nowhere to buy", and I
spent two hours looking for the reason in the wrong place).

```
node crank/index.js
```

If the key, the coin address and the working wallet are set, and the node
answers mainnet, the run will be **live**. To force a dry one:

```
APEX_DRY=1 node crank/index.js
```

This is also the off switch: one variable kills all the payouts without
touching the site, the database or the key.

## What a dry run will show

In order, and every line is worth a separate look:

* **the cluster.** The first line. `the live node · mainnet` or the name of
  somebody else's cluster. If this is not mainnet, live mode will not
  switch on by itself.
* **the coin.** The supply and the decimals, from the chain, not from the
  code. The program: `SPL Token` or `Token-2022`. Which program the
  transfers go through depends on it.
* **the working wallet.** The balance in SOL. Empty and the crank will do
  nothing.
* **who is in on the share.** How many accounts the coin has, how many
  holders pass the floor, how much of the supply is eligible. If there is a
  refusal about a paid node here, read below.
* **what the settlement will cost.** Two parts, and the second matters
  more: the signature fees recur every epoch, the rent deposits for the
  accounts are one-off. The line `token accounts missing N of M` shows how many
  will have to be opened. In the first epoch that is M, in the second
  almost zero.
* **what it will buy.** Ten quotes, each one already compared against the
  market price. A `nowhere to buy` on one seat does not break the epoch:
  its share is divided between the rest.
* **whom it will pay.** The first eight recipients with their shares.
* **the simulation.** From there on every transaction is assembled and
  shown to the node. A failure here is a real error, and the place to
  notice it is right here rather than in live.

## What a dry run will not check

The simulation executes a transaction on its own, against the current
state. Three things stay unchecked, and each one of them is caught only by
a real send:

1. **Order.** A transfer of a coin that is not on the wallet yet will be
   failed by the simulation, even though in live the purchase has already
   gone through by that moment. That is why in a dry run the payout is
   counted from the quote rather than from the balance.
2. **Accumulation.** A hundred transactions in a row, each one depending on
   the previous one: that is checked only by executing them in sequence.
3. **The signature in the network.** That the node will accept the
   signature, that the blockhash will not expire, that the batch will fit
   into the byte limit in a real packet.

## If a real send is needed: a local node

For the third point there is `solana-test-validator`. It brings up a chain
of its own and can **copy real accounts** from mainnet: coins, pools,
programs:

```bash
solana-test-validator \
  --url https://api.mainnet-beta.solana.com \
  --clone <the coin address> \
  --clone <the pool address> \
  --reset
```

Then the crank is pointed there, and the key can be any key at all:

```bash
APEX_RPC=http://127.0.0.1:8899 node crank/index.js --live
```

`--live` is mandatory here: the cluster is not mainnet, and the crank will
not switch live mode on by itself, which is exactly how it was meant to be.

**What a local node cannot do, and it is worth knowing that in advance.**
The purchase goes through Jupiter, and Jupiter hands back a transaction
assembled for **mainnet**: it holds the addresses of the pools, the address
tables and the programs of that chain. They are not on a local node unless
you clone everything the route went through, and a route can be three
venues long. So what gets checked locally is the payout (the transfers,
creating the accounts, the journal, the batches), and the purchase gets
checked by simulation against the live node.

## About the holder list

The narrowest place in the whole crank. The list is read with a single
`getProgramAccounts` request on the token program.

Measured on October 14, 2026 against the coins of our own basket, the
public node `api.mainnet-beta.solana.com`:

| coin | accounts | answer | time |
|---|---|---|---|
| PUMP | 1 027 640 | 292 MB | 15.4 s |
| RAY | 1 131 296 | 321 MB | 15.2 s |
| KMNO | 282 847 | 80 MB | 4.0 s |
| arc | 182 731 | 52 MB | 2.7 s |
| HYPE, MU | n/a | refused with 413 | 0.4 s |

So the public node **does** give the list, and it gives it even for a
million accounts. The 413 refusal comes not from the size of the coin but
from the load: it arrived on the eighth and the ninth heavy request in a
row. That is load shedding, not a ceiling.

Two things follow from the measurement, and both are already in the code:

* **`dataSlice` is mandatory.** Without it the node gives back parsed JSON,
  and for a million accounts that is more than half a gigabyte of text, and
  node dies on it with `ERR_STRING_TOO_LONG` without getting as far as the
  parsing. With `dataSlice` forty bytes per account are taken: the owner
  and the balance, the rest is not needed.
* **An empty list for a live coin is a refusal, not an answer.** We have
  not seen one, but the price of a mistake is not symmetrical: taking
  emptiness for the truth means deciding that there are no holders and
  honestly reporting that there is nobody to pay.

A paid node is worth setting up all the same, but the reason is different
from how it looks: not because the public one cannot, but because it does
not have to. On launch day APEX will have thousands of accounts, and the
answer will weigh kilobytes, but a refusal from the load can arrive at any
moment, and then the epoch simply does not close until the next time.

```
APEX_RPC=https://… node crank/index.js
```

## The variables

| variable | what it is |
|---|---|
| `APEX_TOKEN` | the address of the coin. Usually taken from the database, where the console writes it |
| `APEX_OPERATOR` | the address of the working wallet. From the database too |
| `APEX_VAULT` | the account on which the creator fee accrues. Only for a line in the log |
| `APEX_WALLET_KEY` | **the private key of the working wallet, that is, the money itself.** Only a variable of the crank service, it never gets into the database |
| `APEX_RPC` | the node. The public live one by default |
| `APEX_JUP_KEY` | the key for the aggregator, if the free entrance is closed |
| `APEX_JUP_BASE` | the address of the aggregator, if the path changes |
| `APEX_DRY=1` | the off switch: it kills all the payouts |
| `DATABASE_URL` | the database. **A live run does not go without it**: the journal is the whole protection against a second payment |

## The checks

```
npm run check            # all four suites, 425 checks, no network needed
node crank/check.js --break        # make sure the checks are alive
node crank/check-send.js --break   # the same for the send layer
npm run check:journal    # needs DATABASE_URL: the journal is checked against the database
```

`crank/check-tick.js` is the suite that did not exist and because of which
the crank once did not work at all. It runs the pass **whole**, with the
node, the aggregator and the ten substituted. Every other suite calls the
parts separately, and not one of them runs `tick()` whole, and that is
exactly why a shadowed variable name inside `tick()` once made the crank
unusable while a hundred and fifty-six checks did not see it.
