# APEX

The index of Solana. Hold one token, own the ten most traded coins of the chain.

[apexindex.trade](https://www.apexindex.trade/)

This is the full source of the site and of the service behind it. Nothing is
minified and nothing is hidden: if the page shows a number, the code that
produced it is in this repository.

**Nothing is deployed yet.** There is no token, no operator wallet and no
settled epoch. Everything below is the intended design, not a description of
running code. The numbers become binding only once the mint exists and its
address is published on the site.

## What it does

`$APEX` launches on [pump.fun](https://pump.fun). Every trade there pays the
platform's fee, and a part of it, the **creator fee**, goes to the coin's
creator. That part funds the dividend. There is no tax on top: the token is a
plain SPL mint with no transfer fee and no owner who could add one.

Every three hours the collected fee buys the **ten** most traded coins of the
chain in equal weight and pays them out to holders in kind. Not in `$APEX`,
not in a wrapper: the actual ten coins.

The rate is not a constant, and this is the part people miss. pump.fun sets
the creator fee on a schedule tied to market cap, from 0.950% near the bottom
down to 0.050% at the top. We do not choose it and cannot change it. The
dividend per dollar of volume is therefore highest early and smallest when the
coin is large.

The three hours are a floor rather than a fixed length. The crank checks on the
three-hour UTC mark and settles only once the accrued fee covers the cost of
settling: ten swaps, a payout to every eligible wallet, and a token account for
every recipient who does not have one yet. Short epochs when volume is high,
longer ones when it is quiet.

Rewards are pushed, not claimed. There is no button, no proof to submit and no
deadline to miss.

## How the ten are chosen

The basket is not curated. It is re-read at every epoch close against one
published rule.

A seat is scored from the coin's share of four measures: 24h volume (30%), 24h
trade count (30%), market cap (25%) and pool depth (15%). Volume and trade
count sit together on purpose: apart, each of them can be drawn. A million in
volume made by two trades is high volume and no trades; a thousand tiny trades
are trades and no volume.

Before it is scored at all, a market has to clear four gates:

| gate | threshold |
|---|---|
| pool depth, summed across pools | at least $200,000 |
| that depth against the coin's own market cap | at least 0.5% |
| average trade, 24h volume over 24h trade count | under $5,000 |
| turnover, 24h volume against pool depth | between 10% and 12 times |

And four classes of coin are not constituents at all:

- **Dollars.** Stablecoins, SOL and wrapped majors, excluded by name and also
  by behaviour: a price within 2% of a dollar that moves less than 1% in a day
  is a dollar whatever its ticker says.
- **Tokenised equities.** They are among the deepest markets here, but the
  market being tracked is somewhere else.
- **Receipts for a pool.** An LP token is not a market.
- **Coins with a live owner.** If the mint authority or the freeze authority is
  still live, somebody can expand the supply or freeze an account at will. An
  index should not hold that.

That last gate is the newest one and it earned its place. The name-based rules
had let through SPCX, a tokenised SpaceX share, and HYPE, a wrapper for a coin
from another chain: the first does not end in `x` and the second is just called
HYPE. Measured against the hundred most traded coins, the authority gate also
removed SNDK, AMD, TTWO and DKNG (equities whose tickers look ordinary), INJ
and ORE (bridged), and JLP (a pool receipt). Four classes the name rules had
missed, caught by one property that cannot be disguised.

APEX excludes itself, because buying your own coin with your own fee is a
buyback rather than an index.

## Eligibility

A wallet must hold at least **0.01% of supply**, which is 100,000 APEX out of a
billion, at the snapshot slot. That floor is what makes on-chain distribution
possible at all: pushing ten coins to an unbounded holder set does not fit in a
batch of transactions at any price, and 0.01% caps the eligible set at 10,000
wallets by arithmetic.

The floor is applied to the **holder**, not to the account. On Solana a wallet
holds each coin in its own account, and some wallets open a fresh one on every
purchase; a person with two accounts of 0.006% each clears the floor with
0.012%, and gets one share, not two.

Receiving a coin needs an account for it, and the operator pays for that: on
Solana an account carries a small rent deposit. The deposit belongs to the
holder and comes back if they ever close the account. It comes out of the
operator's pocket, not out of the dividend.

## What is in here

| path | what it is |
|---|---|
| `index.html`, `app.js`, `css/` | the storefront |
| `core.js` | the shared core: chain constants, the selection rules, the formulas. Read by the browser and by the server, so there is only one of it |
| `chain.js` | the browser side of reading the chain: our API first, the chain directly as a fallback |
| `wallet.js` | wallet connection, Wallet Standard plus an injected fallback |
| `server/` | the API on Railway: it reads the chain on a timer and stores the settings |
| `crank/` | the crank: one pass of an epoch, from reading the chain to sending the payouts |
| `docs/` | the documentation page |
| `check.js`, `server/check.js`, `crank/check*.js` | the suites |

## The suites

```
npm install
npm run check
```

542 checks, no network needed. Five suites: the storefront, the server, the
crank rules, the send layer, and one that runs a whole epoch pass end to end
against a stubbed node.

Each suite also runs with `--break`, which deliberately breaks the thing being
checked and confirms the checks go red. A test that cannot fail is decoration,
and this project has had one of those before: it approved everything, because
it was comparing against the wrong grid.

```
node check.js --break
node server/check.js --break
node crank/check.js --break
node crank/check-send.js --break
```

`crank/check-journal.js` needs a real Postgres and is run separately with
`npm run check:journal`.

## The crank

`crank/RUNBOOK.md` is the operator's manual: how to run an epoch without
spending anything, what the dry run does and does not prove, what the holder
list costs to read, and every environment variable.

Two things worth knowing without opening it.

**A dry run is the default, and it now proves something.** It builds every
transaction with the same code the live run uses, signs it, and asks the node
whether it would land. The previous version only printed its intent, and a
mistake in a built call was discovered by the first live signature.

**A vanished transaction has a definite answer here.** A transaction is tied to
a recent blockhash; once the block height passes `lastValidBlockHeight` it can
never land, so retrying is safe. On the previous chain this was unanswerable
and the crank had to stop and call a human.

## The comments

They are long, and that is deliberate. A comment here says why a decision was
made, names the measurement that justified it, and says plainly when the
previous answer was wrong. Several of them exist because something broke in
production and the reasoning was worth more than the fix.

## Licence

MIT. See `LICENSE`.
