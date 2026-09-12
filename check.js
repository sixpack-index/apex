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
   modules at once. The check silently stopped running - I noticed it by
   accident, which would have been the worst outcome of all: a test that
   does not run looks like a test that passed. */
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
