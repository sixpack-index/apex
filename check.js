/* =========================================================================
   A check of the page's arithmetic, with no browser and no network.
   `node check.js`. The functions are taken straight out of app.js and not
   rewritten next to it: a copy diverges from the original on the very
   first patch, and silently.
   A test has to be able to fail: break the line under check and the check
   goes red.
   ========================================================================= */

/* import, not require: a package.json with "type": "module" appeared in
   the root for the sake of the server, and the whole repository became ES
   modules at once. The check silently stopped running: I noticed it by
   accident, which would have been the worst outcome of all, because a test
   that does not run looks like a test that passed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let src = fs.readFileSync(path.join(here, 'app.js'), 'utf8');

/* -------------------------------------------------------------------------
   BREAK MODE: `node check.js --break`

   The flag existed in every suite of the project EXCEPT this one, and here
   it was silently ignored: the suite answered "all checks passed" on broken
   code too. A check that cannot be made to fall over is decoration and not
   a check, and it looks exactly like the real thing.

   What we break is not the check but the thing being checked: we substitute
   lines straight in the source of app.js, the one the suite cuts the
   functions out of. Every substitution has to bring down at least one
   check, otherwise the suite was lying about that line.
   ------------------------------------------------------------------------- */
const BREAK = process.argv.includes('--break');
const BREAKS = [
  /* Every substitution hits a line the suite really does cut out of app.js.
     Basket selection did not get in here on purpose: the list of stables
     lives in core.js while the check keeps its own, that is, it records a
     decision rather than deriving it from the code. There is nothing to
     break in app.js there. */
  ['the million threshold for money', /1e6/, '1e9'],
  ['the zero counter in the price', /'\$0\.0' \+ sub \+ digits/, "'$0.0' + digits"],
  ['the weight of a constituent', /t\.liq \/ L\b/, 't.liq / (L * 2)'],
  ['the order of painting', /\nload\(\);/, '\n/* load(); */'],
];
if (BREAK) {
  let hit = 0;
  for (const [name, re, to] of BREAKS) {
    if (re.test(src)) { src = src.replace(re, to); hit++; }
    else console.log('SUBSTITUTION NOT FOUND: ' + name);
  }
  console.log('Break: substitutions made ' + hit + ' of ' + BREAKS.length + ', expecting RED');
}

/** Cuts one function out of app.js by name and returns it as a value. */
function grab(name, deps = '') {
  const from = src.indexOf('function ' + name);
  if (from < 0) throw new Error('app.js has no function ' + name);
  // the end is the next blank line starting a top-level construct
  const rest = src.slice(from);
  const end = rest.search(/\n(?:function |const |\/\* =)/);
  const body = rest.slice(0, end > 0 ? end : rest.length);
  return new Function(deps + '\n' + body + '\nreturn ' + name + ';')();
}

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? 'ok  ' : 'FAIL') + '  ' + name + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
};

/* ---- Money formatting ---- */
{
  const nf = (v, d = 0) => Number(v).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const money = grab('money', 'const nf = ' + nf.toString() + ';');
  ok('millions', money(26_640_000) === '$26.64M', money(26_640_000));
  ok('thousands with no cents', money(9420) === '$9,420', money(9420));
  ok('under a thousand with cents', money(828.1) === '$828.10', money(828.1));
  ok('zero does not turn into $0.0000', money(0) === '$0', money(0));
  ok('the minus is not lost', money(-1500) === '$-1,500', money(-1500));
}

/* ---- Price with a subscript zero counter ---- */
{
  const nf = (v, d = 0) => Number(v).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const price = grab('price', 'const nf = ' + nf.toString() + ';');
  ok('a large price', price(210.67) === '$210.67', price(210.67));
  ok('ordinary small change', price(0.0004281) === '$0.0004281', price(0.0004281));
  ok('a very small one through the counter', price(0.00002628) === '$0.0₄2628', price(0.00002628));
  ok('not a number gives a dash, not NaN', price(undefined) === '—', String(price(undefined)));
}

/* ---- Coin amounts ---- */
{
  const nf = (v, d = 0) => Number(v).toLocaleString('en-US',
    { minimumFractionDigits: d, maximumFractionDigits: d });
  const units = grab('units', 'const nf = ' + nf.toString() + ';');
  ok('millions of coins', units(6_740_000) === '6.74M', units(6_740_000));
  ok('thousands of coins', units(1700) === '1.7K', units(1700));
  ok('a fraction without lying about precision', units(0.29) === '0.29', units(0.29));
}

/* ---- The take model ---- */
{
  const EPOCHS_PER_DAY = 4;
  const take = (vol, share, bps) => (vol * share * (bps / 10000)) / EPOCHS_PER_DAY;
  ok('the take per epoch', Math.abs(take(40_000_000, 0.15, 200) - 30_000) < 1,
     take(40e6, .15, 200).toFixed(0));
  ok('a zero fee gives a zero take', take(40e6, .15, 0) === 0);
  ok('doubling the fee doubles the take',
     Math.abs(take(1e6, .1, 400) - 2 * take(1e6, .1, 200)) < 1e-9);
  ok('the holder\'s share is proportional to the holding', (() => {
    const per = take(40e6, .15, 200);
    const a = per * (1e6 / 1e9), b = per * (2e6 / 1e9);
    return Math.abs(b - 2 * a) < 1e-9;
  })());
}

/* ---- The position slider ---- */
{
  const MIN = 100_000, MAX = 500_000_000;
  const lo = Math.log10(MIN), hi = Math.log10(MAX);
  const s2a = s => {
    const raw = 10 ** (lo + (hi - lo) * (s / 1000));
    const step = raw >= 1e7 ? 50_000 : raw >= 1e6 ? 10_000 : 1_000;
    return Math.round(raw / step) * step;
  };
  ok('the left edge', s2a(0) === MIN, String(s2a(0)));
  ok('the right edge', Math.abs(s2a(1000) - MAX) <= 50_000, String(s2a(1000)));
  ok('monotonicity', [...Array(1000).keys()].every(i => s2a(i) <= s2a(i + 1)));
}

/* ---- The sparkline is built from real intervals ---- */
{
  const sparkPoints = grab('sparkPoints');
  const pts = sparkPoints({ chg24: 40, chg6: 20, chg1: 5, chg5: -1 }).split(' ');
  ok('five points', pts.length === 5, pts.join(' '));
  ok('the coordinates stay inside the viewbox', pts.every(p => {
    const [x, y] = p.split(',').map(Number);
    return x >= 0 && x <= 100 && y >= 0 && y <= 40;
  }), pts.join(' '));
  const flat = sparkPoints({ chg24: 0, chg6: 0, chg1: 0, chg5: 0 }).split(' ');
  ok('a flat price does not divide by zero',
     flat.every(p => p.split(',').every(v => Number.isFinite(Number(v)))), flat.join(' '));
}

/* ---- Basket selection ---- */
{
  const NOT = new Set(['WETH', 'USDG', 'USDE', 'USDT', 'USDC', 'SYRUPUSDG']);
  const pool = [
    { sym: 'USDG', liq: 9e9 }, { sym: 'WETH', liq: 8e9 }, { sym: 'syrupUSDG', liq: 7e9 },
    { sym: 'AAA', liq: 5 }, { sym: 'BBB', liq: 50 }, { sym: 'CCC', liq: 500 },
  ];
  const ten = pool
    .filter(t => !NOT.has(t.sym.toUpperCase()))
    .sort((a, b) => b.liq - a.liq)
    .slice(0, 10);
  ok('stables and WETH are not in the basket', ten.length === 3, ten.map(t => t.sym).join(','));
  ok('the case of the symbol does not save a stable from the filter',
     !ten.some(t => /syrup/i.test(t.sym)));
  ok('the order goes by depth', ten[0].sym === 'CCC' && ten[2].sym === 'AAA');
}

/* ---- Basket selection: THE REAL ONE, not a copy of the rule ----

   The block above keeps its own list of stables and therefore records a
   decision rather than deriving it from the code. Here `isConstituent`
   itself is called out of core.js: break the rule in there and it is these
   very lines that fall.

   The occasion was a live case on 28 September: U, "United Stables", a
   dollar at 0.9994 moving 0.01% over the day, stood EIGHTH in the ten. The
   list by name did not catch it, because a dollar is under no obligation to
   be called USD. */
{
  await import('./core.js');
  const C = globalThis.ApexCore;
  /* THE NAME IS DELIBERATELY NOT FROM THE LIST. With the symbol U the check
     would pass on a broken rule too: that one is caught by the list of
     names. Verified by substitution, the suite answered "ok" on code with
     no `looksPegged`. Here only behaviour can catch it. */
  const peg = { sym: 'BUCK', name: 'Buckaroo Dollar', price: 0.9994, chg24: 0.01 };
  ok('a dollar by behaviour rather than by name: not in the basket', !C.isConstituent(peg));
  ok('and the same one is caught by behaviour on its own', C.looksPegged(peg));

  /* A live coin near a dollar passes: it gets shaken about over the day. */
  const alive = { sym: 'XYZ', name: 'Some Coin', price: 1.004, chg24: 7.2 };
  ok('a coin near a dollar, but alive, keeps its seat', C.isConstituent(alive));

  /* And the other way round: a calm day is no reason to throw out
     something that does not stand at one. Otherwise the filter would eat
     any quiet day of any coin. */
  const calm = { sym: 'QQQ', name: 'Quiet Coin', price: 0.0254, chg24: 0.2 };
  ok('a quiet day does not make a coin a dollar', C.isConstituent(calm));

  ok('the deviation threshold and the movement threshold are set as numbers',
     Number.isFinite(C.PEG_BAND) && Number.isFinite(C.PEG_MOVE),
     C.PEG_BAND + ' / ' + C.PEG_MOVE);
  ok('U is in the list of names as well, belt and braces', C.NOT_CONSTITUENTS.has('U'));
}

/* ---- The turnover floor ----

   The mirror of the ceiling on the average trade: there it catches inflated
   volume, here inflated depth. The fixture numbers are taken from a live
   measurement on 29 September.  */
{
  await import('./core.js');
  const C = globalThis.ApexCore;
  const mk = (liq, vol, txns, cap) => ({ liq, vol24: vol, txns24: txns, marketCap: cap });

  /* STATICS as it was: a pool of ten and a half million, 254 trades,
     volume of 129 thousand. Turnover 0.012. */
  ok('parked depth earns no seat',
     !C.isTraded(mk(10_526_371, 129_063, 254, 15_987_747)));

  /* STANDARD: the same picture, milder, 0.052. */
  ok('depth with no trading earns no seat in the mild case either',
     !C.isTraded(mk(13_894_178, 721_233, 403, 21_521_767)));

  /* PONS, the nearest live one: 0.18, nearly twice the threshold. */
  ok('real trading clears the threshold',
     C.isTraded(mk(3_698_328, 678_524, 1_579, 358_642_429)));

  /* Small but brisk: depth a little above the floor, turnover of one. */
  ok('a small brisk pool gets a seat',
     C.isTraded(mk(237_806, 255_075, 2_246, 3_000_000)));

  /* The turnover floor and the depth floor look in different directions,
     and both are needed. */
  ok('high turnover does not save a thin pool',
     !C.isTraded(mk(50_000, 400_000, 1_000, 2_000_000)));

  ok('the threshold is set as a number', Number.isFinite(C.TURNOVER_FLOOR), C.TURNOVER_FLOOR);

  /* THE CEILING. Numbers from a live measurement of Solana on 14 October.
     On the previous chain there was no trouble with churn at all, on Solana
     the top of the list is taken up by it. */
  /* The market cap is taken such that the depth to market cap rule does not
     interfere: what is checked here is the churn ceiling, not that one. On
     the real SOL that ratio is far smaller, and it is screened out BY IT
     rather than by the ceiling. That is not an accident but a decision
     about the composition: see SOLANA.md. */
  const SOL   = mk(46_819_141, 233_890_062, 385_411, 4_681_914_100);  // 5.0
  const HYPE  = mk(743_574, 5_790_093, 11_056, 1e8);          // 7.8
  const ALLOX = mk(315_990, 4_603_593, 4_134, 1e8);           // 14.6
  const PULT  = mk(341_727, 149_995_682, 136_971, 1e8);       // 438.9

  ok('the base asset of the chain keeps its seat', C.isTraded(SOL));
  ok('a brisk but live market passes', C.isTraded(HYPE));
  ok('churn of fifteen depths earns no seat', !C.isTraded(ALLOX));
  ok('churn of four hundred and thirty nine depths all the more so', !C.isTraded(PULT));
  ok('the ceiling is above the most traded asset of the chain',
     C.TURNOVER_CEILING > 233_890_062 / 46_819_141, C.TURNOVER_CEILING);
}

/* ---- A ticker faked with foreign alphabets ----

   On 14 October the first by volume on Solana was "ՍЅᎠТ": an Armenian Ս, a
   Cyrillic Ѕ, a Cherokee Ꭰ, a Cyrillic Т. To the eye that is USDT, to the
   code it is four different letters. Volume of 170 million in 52 trades. */
{
  await import('./core.js');
  const C = globalThis.ApexCore;
  ok('a fake USDT folds back into USDT', C.normSym('ՍЅᎠТ') === 'USDT', C.normSym('ՍЅᎠТ'));
  ok('and it does not go into the basket',
     !C.isConstituent({ sym: 'ՍЅᎠТ', name: 'x', price: 1.0, chg24: 0.01 }));
}

/* ---- The index collects the coins of THIS chain ----

   A measurement on 14 October, two hundred Solana pools. Foreign markets of
   three kinds crept in among the eligible ones, and each would have taken a
   real seat in the ten: the base asset and the bridged majors, the PayPal
   dollar, the tokenized shares NVDAx and GOOGLx. */
{
  await import('./core.js');
  const C = globalThis.ApexCore;
  const live = { price: 0.05, chg24: 12, liq: 2e6, vol24: 4e6, txns24: 9000, marketCap: 3e7 };
  const go = (sym, name, extra = {}) => C.isConstituent({ ...live, sym, name, ...extra });

  ok('the base asset of the chain is not bought with its own fee', !go('SOL', 'Solana'));
  ok('nor is the wrapper of the base asset', !go('WSOL', 'Wrapped SOL'));
  ok('bridged bitcoin is not our market', !go('cbBTC', 'Coinbase Wrapped BTC'));
  ok('bridged ether is not our market', !go('WETH', 'Wrapped Ether'));
  ok('liquid staking is not a coin of the chain', !go('JitoSOL', 'Jito Staked SOL'));
  ok('a bridge is caught by name without a list', !go('ABC', 'Bitcoin (Portal)'));
  ok('the PayPal dollar is not a coin', !go('PYUSD', 'PayPal USD', { price: 1.00013, chg24: 0.01 }));
  ok('a tokenized share by name', !go('NVDAx', 'NVIDIA xStock', { price: 229.9, chg24: 1.2 }));
  ok('and by the look of the ticker', !go('TSLAx', 'Tesla', { price: 400, chg24: 2 }));

  /* The other side: the chain's own coins keep their seats. */
  ok('a meme of the chain passes', go('BONK', 'Bonk'));
  ok('the coin of the venue passes', go('PUMP', 'Pump'));
  ok('the coin of a protocol passes', go('RAY', 'Raydium'));
  ok('a lower case ticker is not confused with a share', go('arc', 'arc'));
}

/* ---- Bypassing the exclusion list through the look of a ticker ----

   Verified on live data on 29 September: the network already has a "USDG "
   with a space on the tail, next to sixteen other fakes of Global Dollar.
   What threw it out was not the name but a small pool, that is, we got
   lucky. */
{
  await import('./core.js');
  const C = globalThis.ApexCore;
  const live = { price: 0.5, chg24: 9, liq: 5e6, vol24: 5e6, txns24: 9000, marketCap: 1e8 };
  const passes = sym => C.isConstituent({ ...live, sym, name: 'x' });

  ok('a space on the tail does not bypass the list', !passes('USDG '));
  ok('a space at the start does not bypass the list', !passes(' USDG'));
  ok('a non-breaking space does not bypass the list', !passes('WETH\u00A0'));
  ok('a tab does not bypass the list', !passes('\tUSDT'));
  ok('an invisible separator inside the word does not bypass the list', !passes('USD\u200BG'));
  ok('lower case does not bypass the list', !passes('usdg'));
  ok('a Cyrillic C in USDC does not bypass the list', !passes('USDС'));

  /* The other side: the normalizer must not eat the live ones. */
  ok('the normalizer does not touch an ordinary ticker', passes('CASHCAT'));
  ok('digits and signs in a ticker survive normalization', passes('1INCH'));
  ok('normSym brings things to one form', C.normSym(' usd\u200Bg ') === 'USDG',
     C.normSym(' usd\u200Bg '));
}

/* ---- Our own token does not go into our own basket ----

   The docs promise it in words, and in the code it was nowhere: not in the
   core, not in the crank. The promise held only on the fact that there is
   no token yet. It would have fired on the very first day: a seat is given
   60 per cent by volume and by trade count, and a fresh launch has more of
   both than anything on the network.

   The check goes through the sources rather than by a call: `readBasket`
   goes to the network, and it has no business in a suite. We guard what
   breaks silently: a missing argument at one of the three callers. */
{
  const core = fs.readFileSync(path.join(here, 'core.js'), 'utf8');
  ok('the core takes the address of our own token', /async function readBasket\(\{\s*exclude/.test(core));
  ok('and throws it out before the selection',
     /\.filter\(t => !self \|\| t\.address !== self\)/.test(core));

  /* THE WHOLE FILE IS GUARDED, NOT A SLICE INSIDE readBasket.

     At first this only looked from `readBasket` to `rankSeats`, and that
     turned out not to be enough: case folding was hiding in two other
     places in the same file, one function away from the check. In
     `foldPairs` it was a map key, so two different coins differing only
     in case collapsed into one basket row. In `marketOf` it compared our
     address with a pair's address, so somebody else's coin could be
     taken for ours.

     Folding the case of an address is wrong EVERYWHERE on this chain, so
     the check now covers the whole file. */
  const folds = (core.match(/.{0,70}toLowerCase.{0,40}/g) || [])
    .filter(line => /address|token|addr|pubkey|mint/i.test(line));
  ok('addresses are nowhere folded to one case', folds.length === 0, folds);

  for (const [file, who] of [['server/collect.js', 'the server'],
                             ['crank/index.js', 'the crank'],
                             ['chain.js', 'the storefront']]) {
    const src = fs.readFileSync(path.join(here, file), 'utf8');
    const calls = src.match(/readBasket\([^)]*\)/g) || [];
    ok(who + ' passes the address of our own token to the basket',
       calls.length > 0 && calls.every(c => c.includes('exclude')),
       calls.join(' '));
  }
}

/* ---- Weights ----

   This block used to count the shares ITSELF, with the same two lines as
   app.js, and so it could not catch anything in it: substituting `t.liq / L`
   with `t.liq / (L * 2)` left it green. Now the real `weights()` is taken
   together with its `totalLiq()`, and BASKET is substituted in as a
   dependency. A check that repeats the code under check beside it guards
   its own copy, not the code. */
{
  const liq = [9.8e6, 4.3e6, 3.7e6, 2.7e6, 1.5e6, 1e6, 0.9e6, 0.8e6, 0.6e6, 0.4e6];
  const BASKET = liq.map((l, i) => ({ sym: 'T' + i, liq: l }));
  const weights = grab('weights',
    'const BASKET = ' + JSON.stringify(BASKET) + ';\n' +
    'const totalLiq = () => BASKET.reduce((s, t) => s + t.liq, 0);');
  const w = weights();
  ok('the weights add up to one', Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12,
     w.reduce((a, b) => a + b, 0).toFixed(6));
  ok('an empty basket does not divide by zero', (() => {
    const wEmpty = grab('weights',
      'const BASKET = [];\nconst totalLiq = () => 0;')();
    return wEmpty.length === 0;
  })());
  ok('the largest weighs more than all of them', w[0] === Math.max(...w));
}

/* -------------------------------------------------------------------------
   Somebody else's totals are blanked before the network, not after.

   The markup has a payout history baked in that never happened: "$128,305
   dividends paid out", "across 9 epochs", "last epoch paid $7,254". Dashes
   cover it, but while that covering lived inside `paintAll()` it waited for
   the server: 0.8 seconds by measurement, longer on a phone, and never at
   all if the script breaks.

   The check is structural because there is no DOM here: the three paints
   have to be called before `load()`. If somebody removes them "as
   duplicates", this goes red instead of quiet.
   ------------------------------------------------------------------------- */
{
  const at = name => src.indexOf('\n' + name + '();');
  const load = src.lastIndexOf('\nload();');
  ok('load() is called last', load > 0);
  for (const fn of ['paintSummary', 'paintBasket', 'paintFootlines', 'paintLedger']) {
    const i = at(fn);
    const good = i > 0 && i < load;
    /* The note prints only on failure: `ok` shows extra unconditionally,
       and "called after load()" next to the word "ok" read as a
       contradiction. */
    ok('"' + fn + '" blanks the numbers before the network', good,
       good ? '' : (i < 0 ? 'not called at all' : 'called after load()'));
  }
  /* And the numbers themselves: if the borrowed totals ever leave the
     markup, there is nothing left to blank, and the check above would
     start guarding an empty room. */
  const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
  ok('the borrowed totals are still in the markup, otherwise nothing to blank',
     html.includes('$128,305') && html.includes('$7,254'));
}

if (BREAK) {
  /* In break mode success is failure: if the substitutions are in and
     everything is green, then the checks do not touch the substituted
     lines. */
  console.log(fail
    ? 'Break: the checks are alive, gone red: ' + fail
    : 'BREAK NOT CAUGHT: the substitutions are in and the suite is green');
  process.exit(fail ? 0 : 1);
}
console.log(fail ? 'FAILED: ' + fail : 'all checks passed');
process.exit(fail ? 1 : 0);
