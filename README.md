# APEX

The index of Robinhood Chain. Hold one token, own the top ten.

[apexindex.trade](https://www.apexindex.trade/)

This is the full source of the site and the service behind it. Nothing is
minified and nothing is hidden: if the page shows a number, the code that
produced it is in this repository.

Nothing is deployed yet. There is no token, no distributor and no settled
epoch. Everything below is the intended design, not a description of running
code. The numbers become binding only once the contract is on-chain and its
address is published on the site.

## What it does

`$APEX` launches on [Pons](https://pons.fun), on a Uniswap V3 pool. Pons pools
charge a **1% fee** on every trade. The launchpad keeps 30% of that fee; the
rest, **0.7% of turnover**, is what this project distributes.

Every three hours the collected fee buys the **ten** largest tokens on the
chain in equal weight and pays them out to holders in kind. Not in `$APEX`,
not in a wrapper: the actual ten tokens.

The three hours are a floor rather than a fixed length. The crank checks on
the three-hour UTC mark and settles only once the accrued fee covers the cost
of settlement, which is ten swaps plus a payout to every eligible wallet.
Short epochs when volume is high, longer ones when it is quiet.

The basket is not curated. It is re-read at every epoch close against one
published rule: a place is scored from the token's share of 24h volume (30%),
24h trade count (30%), market cap (25%) and pool depth (15%), and a market has
to clear three gates before it is scored at all. Stablecoins, wrapped ETH and
tokenised stocks are excluded: an index of the chain's own markets that holds
USDC is not an index of the chain's own markets. APEX excludes itself, because
buying your own token with your own fee is a buyback rather than an index.

Rewards are pushed, not claimed. There is no button, no proof to submit and no
deadline to miss.

## The numbers

| | |
|---|---|
| chain | Robinhood Chain, id 4663 |
| total supply | 1,000,000,000 APEX |
| pool fee | 1%, set by the factory at creation |
| launchpad share | 30% of the fee, **frozen per token when liquidity locks** |
| dividend wedge | 0.7% of turnover, all of it to holders |
| operator take | none |
| constituents | 10, equal split, 1,000 bps each |
| epoch | checked every 3 hours, variable length |
| minimum holding | 0.01% of supply, or 100,000 APEX |
| payout | in kind, airdropped on-chain |
| liquidity | permanently locked, there is no withdraw function |

## What is provably fixed

Three things cannot be changed after launch, and that is the whole reason to
launch on Pons rather than write our own token:

| | |
|---|---|
| pool fee | 1%, set when the pool is created and charged for its whole life |
| launchpad share | 30%, written into the locker once, when the position locks |
| liquidity | permanently locked, the locker has no function that returns it |

Everything else, the fee recipient and the contents of the basket, is visible
on chain at any moment. Epoch length is the one mutable parameter, and every
change is on-chain and visible before the epoch it applies to.

Settlement is operated, not autonomous. The pool fee is collected by an
operator key on the three-hour schedule, and that key routes it to the
distributor. Between collection and payout the funds are under a key rather
than under a contract that cannot do otherwise. Every step is a public
transaction, so what was collected and what was paid can be checked against
each other for any epoch.

## Layout

```
index.html      the page
css/            the styles: base, hero, hero3d, cards, calc, page, type
app.js          rendering, the calculator, the basket cards
chain.js        talking to our API, wallet-side overrides
wallet.js       connecting a wallet, the network guard
core.js         the model: fee, epoch size, weights, formatting
                shared verbatim by the browser, the server and the crank
intro.js        the splash and the reveals, deliberately not a module
hero3d.js       the first-screen scene: the orb in metal palms, three.js
server/         API and the collector: reads the chain, stores snapshots
crank/          the epoch engine: collect, buy the ten, distribute
docs/           how it works, in plain English
check.js        tests for the model
```

`core.js` is the piece worth reading first. The fee rate, the epoch length and
the seat weights live there and nowhere else: the page, the server and the
crank all import the same numbers. A second copy of a rule is a rule that
drifts, silently.

## Running it

```
npm install
npm run check      # the model, the server rules, the crank
npm start          # the API; needs DATABASE_URL
```

`npm run check` runs `check.js`, `server/check.js`, `crank/check.js` and
`crank/check-send.js` in that order. The journal checks are separate and slow,
so they have their own script: `npm run check:journal`.

The site is static. Open `index.html`, or serve the folder. It works without
the API too, falling back to reading the chain directly from the browser.

## Notes on the code

The comments explain *why*, not *what*: most of them record a measurement or a
bug that cost an evening, so that the next person does not repeat it. If you
are reading this to check whether the mechanism is honest, `docs/` and
`core.js` are the two places to look.

`hero3d.js` is a module, and three.js arrives from a CDN through an importmap
in `index.html`. If that CDN does not answer the module will not run at all,
which is why everything the page stops being a page without lives in
`intro.js` and does not depend on three.js.

## Risks

Read the `docs/` page. The short version: no volume means no dividend; ten
tokens on one chain are not diversification and fall together; constituents
can go to zero and so can APEX; the contract is a buyer in thin pools and
moves prices against itself; the 1% fee is a real cost of roughly 2% to
round-trip a position; the wedge is 0.7% rather than the several percent a
Uniswap V4 hook would allow, so at the same volume our dividend is several
times smaller; and settlement depends on an operator key that can stop or
route funds elsewhere.

## Third-party

three.js is BSD-3, loaded from a CDN rather than vendored.

## Licence

MIT, see `LICENSE`.
