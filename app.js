/* =========================================================================
   APEX. The layout and the typography repeat the original, the behaviour is
   written afresh: the figure spins in a real render, the numbers are read
   from the chain.

   The division that matters most here:
     READ FROM THE CHAIN: the basket, prices, the 24h change, liquidity,
       volumes. That is the truth.
     COMPUTED FROM THE MODEL: how much the treasury would collect and how
       much of it would reach a holder. Arithmetic over live numbers and one
       assumption, named out loud.
     DOES NOT EXIST: the $APEX price, holders, the payout history. None of
       that is on the page: a site must not promise more than its code can
       do.
   ========================================================================= */

const BRAND = {
  name: 'APEX',         // the project name, changed only here
  ticker: 'APEX',
};

/* The wallet lives in a file of its own and cannot reach BRAND, so we put
   the ticker into window ourselves. wallet.js used to read
   `window.DimehoodBrand`, which nobody ever set, and silently showed the
   fallback name written inside it: a second list of the same thing, bound to
   diverge on the first rename. */
window.ApexBrand = BRAND.ticker;

/* The API base. Empty means the same domain, `/api/*` is rewritten to
   Railway through vercel.json; the absolute address is needed only when the
   page is opened from file://.

   This constant used to live inside the block that loaded the order book and
   would have left together with it when the packaging was dropped. Token
   icons are pulled through the same relay, so it is needed without the order
   book too. */
const API_BASE = (location.protocol === 'file:')
  ? 'https://api-production-2cac.up.railway.app'
  : '';

/* Where this file lives.

   Needed for exactly one thing: loading stage.js on demand. A dynamic
   `import()` inside an ordinary (non-module) script resolves the path **from
   the address of the page**, not from the address of the script. While there
   is one page and it sits in the root there is no difference; on a page in a
   subfolder `./stage.js` turns into `/subfolder/stage.js`, which is not
   there, and the figure silently fails to start: what is left is the static
   drawing from the markup, and that looks like the real thing working.

   Exactly this happened on the variant drafts: the sphere was in place and
   did not rotate, and it went unnoticed on the screenshot. We count from the
   script itself. */
const HERE = (document.currentScript && document.currentScript.src) || location.href;

/* The rules of the mechanism live in core.js, one set of numbers for the
   whole project: the calculator here computes by them, the server sizes the
   epoch by them, and /docs describes those same numbers in words. A copy
   here would mean two lists of one and the same thing; they diverge on the
   first patch, and silently. */
const MODEL = globalThis.ApexCore.MODEL;

/* Seat weights in basis points: [1667, 1667, 1667, 1667, 1666, 1666].
   Computed by the core rather than retyped here as numbers. */
const WEIGHTS = globalThis.ApexCore.weightsBps();



let BASKET = [];
let DISP = null;
let SELF = null;   // our token: filled in as soon as there is an address
let META = { source: null, scanned: 0, priced: 0, at: 0, failed: null, via: null, age: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* =========================================================================
   Formatting
   ========================================================================= */

const nf = (v, d = 0) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Money. Nobody should have to read 249999.99999999997: on MAOMAO they did. */
function money(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + nf(v / 1e9, 2) + 'B';
  if (a >= 1e6) return '$' + nf(v / 1e6, 2) + 'M';
  if (a >= 1e3) return '$' + nf(v, 0);
  if (a >= 1)   return '$' + nf(v, 2);
  if (a > 0)    return '$' + nf(v, 4);
  return '$0';
}

/** Price: small change is written with a zero counter, as on the exchanges
    and as in the original. */
function price(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1) return '$' + nf(v, 2);
  if (v >= 0.0001) return '$' + Number(v.toPrecision(4));
  const [m, e] = v.toExponential(4).split('e');
  const zeros = Math.abs(Number(e)) - 1;
  const digits = m.replace('.', '').replace(/0+$/, '').slice(0, 4);
  const sub = String(zeros).replace(/\d/g, d => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]);
  return '$0.0' + sub + digits;
}

const pct = (v, d = 2) => (v >= 0 ? '+' : '') + nf(v, d) + '%';

function units(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return nf(v / 1e6, 2) + 'M';
  if (v >= 1e3) return nf(v / 1e3, 1) + 'K';
  if (v >= 1)   return nf(v, 2);
  // Trailing zeros on fractions lie about precision: 0.29 is 0.29, not 0.2900.
  return String(Number(v.toPrecision(3)));
}

const esc = s => String(s ?? '').replace(/[<>&"]/g, c =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

/* =========================================================================
   Derived
   ========================================================================= */
const totalLiq = () => BASKET.reduce((s, t) => s + t.liq, 0);
const totalVol = () => BASKET.reduce((s, t) => s + t.vol24, 0);

/** A constituent's weight is its share of the basket's liquidity. */
function weights() {
  const L = totalLiq();
  return L > 0 ? BASKET.map(t => t.liq / L) : BASKET.map(() => 1 / (BASKET.length || 1));
}

const NA = '—';



/* =========================================================================
   The tape
   ========================================================================= */
function paintTape() {
  if (!BASKET.length) return;
  const html = BASKET.map(t =>
    '<span class="tk"><b>' + esc(t.sym) + '</b>' +
    '<span class="p">' + price(t.price) + '</span>' +
    '<span class="' + (t.chg24 >= 0 ? 'up' : 'dn') + '">' + pct(t.chg24) + '</span></span>'
  ).join('');
  /* The tape runs endlessly only while one of its halves is wider than the
     screen.

     The trick goes like this: two identical halves, the tape travels exactly
     50% and comes back, and the seam is invisible because a copy stands in
     its place. But that works only while a half covers the screen entirely.
     When the seats went from ten down to six, the half narrowed by almost
     half, and on a wide monitor emptiness opened up behind its tail: the
     tape literally "ended" and rode on empty.

     So the list repeats as many times as it takes for a half to outgrow the
     screen. We do not judge by eye: we measure the width and top it up until
     it is enough, with a ceiling in case the measurement returns zero (a
     hidden tab reports zero sizes, and the loop would have been eternal). */
  $$('.tape-half').forEach(h => { h.innerHTML = html; });
  padTape();
}

/**
 * Top the tape up until it is endless.
 *
 * The two-halves trick works only while one half is wider than the screen:
 * the tape travels exactly 50% and comes back, and a copy stands in the
 * place of the seam. When the seats went from ten down to six, the half
 * narrowed by almost half, and on a wide monitor emptiness opened up behind
 * its tail: the tape literally ended and rode on empty.
 *
 * Called twice: right away on load, off the markup, and once more after the
 * data arrives. The first call matters no less than the second: if the chain
 * answers slowly or does not answer at all, a person is looking at a short
 * tape the whole time, and "the data is not here yet" reads as "the site is
 * broken".
 */
function padTape() {
  const halves = $$('.tape-half');
  const first = halves[0];
  if (!first) return;
  const seed = halves.map(h => h.innerHTML);
  if (!seed[0]) return;

  /* The ceiling is mandatory: on a hidden tab and before the fonts load the
     browser reports zero sizes, and a loop driven by measurement would never
     have stopped. */
  const need = Math.max(window.innerWidth, 1) * 1.2;
  for (let k = 0; k < 8 && first.scrollWidth > 0 && first.scrollWidth < need; k++) {
    halves.forEach((h, i) => { h.innerHTML += seed[i]; });
  }
}

/* =========================================================================
   Section 1, the summary. Eight cards, headings and captions are his, word
   for word. All of them are about our token: market cap, the liquidity of
   its pool, its turnover, holders, payouts. There is no token, so a dash
   everywhere except the clock. He does the same himself with holders:
   "— / not indexed yet".
   ========================================================================= */
function paintSummary() {
  const k = $$('.kpi');
  if (k.length < 8) return;

  const set = (el, key, val, sub) => {
    if (!el) return;
    $('.k', el).textContent = key;
    const v = $('.v', el);
    v.textContent = val;
    v.removeAttribute('data-cu');       // we do not need the original's counter
    $('.s', el).innerHTML = sub;
  };

  const S = SELF || {};
  const has = v => Number.isFinite(v) && v > 0;

  set(k[0], 'market cap', has(S.marketCap) ? money(S.marketCap) : NA,
      has(S.marketCap)
        ? '<b>' + nf(MODEL.supply) + '</b> supply, fully circulating'
        : 'no token deployed');

  set(k[1], 'liquidity', has(S.liq) ? money(S.liq) : NA,
      'across <b>' + (S.pools || '—') + '</b> pools');

  set(k[2], 'total volume', has(S.vol24) ? money(S.vol24) : NA,
      has(S.vol24) ? 'last 24h' : 'not trading yet');

  set(k[3], BRAND.name.toLowerCase() + ' holders',
      Number.isFinite(S.holders) ? nf(S.holders) : NA,
      Number.isFinite(S.holders) ? 'read from the explorer' : 'not indexed yet');

  /* FOUR CARDS ABOUT EPOCHS, ONE THOUGHT RATHER THAN FOUR DASHES

     Until the first epoch these four cards know nothing, and each of them
     used to say so in its own way: "across — epochs", "— per constituent",
     "— qualified at snapshot". Three different ways of saying "nothing yet"
     read as three different breakages.

     Now they share one counter and one caption: the first three report that
     they are waiting for the first epoch, and the fourth says when it will
     be. The clock stands in one place for the whole block: five identical
     counters in a row would have looked no more informative than one, only
     fussier.

     As soon as the epochs start running, the captions return to numbers on
     their own, in the branch below. */
  const paid = (S.epochs || []).length;
  set(k[4], 'dividends paid out', NA,
      paid ? 'across <b>' + paid + '</b> epochs, in kind'
           : 'in kind · starts with the first epoch');
  set(k[5], 'last epoch paid', NA,
      paid ? '<b>—</b> per constituent, equal weight'
           : 'no epoch has settled yet');
  set(k[6], 'eligible supply', NA,
      paid ? '<b>—</b> qualified at snapshot'
           : 'counted at the first snapshot');

  /* The clock runs for real, driven by tick(). Only the caption is here, and
     before the launch it names out loud what exactly we are waiting for: not
     the "next" distribution but the first. */
  $('.k', k[7]).textContent = paid ? 'next distribution' : 'first distribution';
  $('.s', k[7]).innerHTML = paid
    ? 'checked every <b>three hours</b> · closes once the pot covers settlement'
    : 'the three cards to the left fill in when this reaches <b>00:00:00</b>';

  // The 24h dispersion lives in the basket: computed here, shown there.
  const best = BASKET.length ? BASKET.reduce((a, b) => (b.chg24 > a.chg24 ? b : a)) : null;
  const worst = BASKET.length ? BASKET.reduce((a, b) => (b.chg24 < a.chg24 ? b : a)) : null;
  DISP = best ? { pts: nf(best.chg24 - worst.chg24, 0), best, worst } : null;
}

/* =========================================================================
   Section 2, the basket. On his left is how much was handed out over nine
   epochs; we have no epochs, so a dash. On the right are two metrics about
   the basket pools themselves: 24h turnover and dispersion. Those are read
   from the chain both for him and for us, so we show them live.
   ========================================================================= */
function paintBasket() {
  const big = $('.big-g');
  if (!big) return;

  const hdrs = $$('.hdr span', big);
  const nums = $$('.n-xxl, .n-xl, .n-l', big);
  const fns = $$('.fn', big);

  /* The same two lines about epochs as in the summary: while there are none,
     we say so in words rather than with a third dash in a row. The clock does
     not go here: it is in the summary and in the ledger, and a third counter
     on one page stops being an event. */
  const settled = (SELF && SELF.epochs && SELF.epochs.length) || 0;
  const rows = [
    ['distributed to holders', NA,
     (settled ? 'across <b>' + settled + '</b> settled epochs · ' : 'no epoch has settled yet · ')
     + MODEL.seats + ' constituents · <b>equal weight</b>, '
     + nf(100 / MODEL.seats, 1) + '% each'],
    ['eligible supply, last epoch', NA,
     settled ? '<b>—</b> of supply qualified at the snapshot'
             : 'counted at the first snapshot'],
    /* "across all ten pools" is the same lie as "10 rows": there are as many
       pools as were found, not as many as there are seats. */
    ['24h basket volume', BASKET.length ? money(totalVol()) : NA,
     BASKET.length ? 'across all ' + BASKET.length + ' pools' : 'across the basket pools'],
    ['dispersion, 24h', DISP ? DISP.pts + 'pts' : NA,
     DISP ? 'best <b>' + pct(DISP.best.chg24, 2) + '</b> · worst <b>' + pct(DISP.worst.chg24, 2) + '</b>'
          : 'reading chain…'],
  ];
  rows.forEach((r, i) => {
    if (hdrs[i]) hdrs[i].textContent = r[0];
    if (nums[i]) { nums[i].textContent = r[1]; nums[i].removeAttribute('data-cu'); }
    if (fns[i]) fns[i].innerHTML = r[2];
  });

  // The "last epoch" and "all epochs" bars: there were no epochs, so empty.
  $$('.bvm .lb').forEach((lb, i) => {
    lb.innerHTML = '<span>' + (i ? 'all epochs' : 'last epoch') + '</span><b>' + NA + '</b>';
    const trk = lb.parentElement.querySelector('.trk i');
    if (trk) { trk.style.width = '0%'; trk.removeAttribute('data-fill'); }
  });
}

/* =========================================================================
   Section 3, the calculator
   ========================================================================= */
const MIN_HOLD = 100_000, MAX_HOLD = 500_000_000;

/* Rounding to something round: one significant digit, a step of 1 / 2.5 / 5.
   A person dragging a slider expects 10,000,000, not 9,970,000, and an
   unround number reads to them as an error rather than as precision. */
function roundNice(v) {
  if (!Number.isFinite(v) || v <= 0) return MIN_HOLD;
  const mag = 10 ** Math.floor(Math.log10(v));
  const r = v / mag;
  const step = r < 1.5 ? 0.1 : r < 3 ? 0.25 : 0.5;
  return Math.round(v / (mag * step)) * (mag * step);
}

const s2a = s => {
  const lo = Math.log10(MIN_HOLD), hi = Math.log10(MAX_HOLD);
  const raw = 10 ** (lo + (hi - lo) * (s / 1000));
  return Math.min(Math.max(roundNice(raw), MIN_HOLD), MAX_HOLD);
};
const a2s = a => {
  const lo = Math.log10(MIN_HOLD), hi = Math.log10(MAX_HOLD);
  const c = Math.min(Math.max(a, MIN_HOLD), MAX_HOLD);
  return Math.round(((Math.log10(c) - lo) / (hi - lo)) * 1000);
};

/* How many coins are in the calculator right now.

   Kept apart from the position of the slider, and that is not a spare
   variable. The slider is discrete: a thousand steps on a logarithmic scale.
   Pressing "1M" set the position, and what was shown was whatever that
   position worked back out to: 997,000 instead of a million. The exact value
   now lives here, and the slider stays what it always was, a way of changing
   it. */
let HOLD = 19_650_000;

/** Set the amount from outside: a chip, a wallet balance, anything. */
function setHold(amount, { moveSlider = true } = {}) {
  HOLD = Math.min(Math.max(Number(amount) || 0, 0), MAX_HOLD);
  const input = $('.calc input[type="range"]');
  if (input && moveSlider) input.value = a2s(HOLD);
  paintCalc();
}

function paintCalc() {
  const input = $('.calc input[type="range"]');
  if (!input) return;
  const amount = HOLD;
  /* The core computes it: the same thing the server computes, and the thing
     the tests check. All that is left here is to show it. While the formula
     lived inside this function, swapping the multiplier in it slipped past
     every check. */
  const D = globalThis.ApexCore.dividendFor(amount, SELF && SELF.vol24, SELF && SELF.price);

  /* We do not touch the input field while somebody is typing in it:
     overwriting the text moves the caret to the end, and typing a number
     longer than two digits becomes impossible. */
  const field = $('.calc-amount');
  if (field && document.activeElement !== field) field.value = nf(amount);
  const unit = $('.calc-unit');
  if (unit) unit.textContent = BRAND.ticker;
  input.setAttribute('aria-valuetext', nf(amount) + ' ' + BRAND.ticker);

  const put = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };

  put('.cs-value', D.value ? money(D.value) : NA);
  put('.cs-share', nf(D.share * 100, 3) + '%');

  /* Three horizons instead of one. Per epoch is what gets paid; per day and
     per thirty days are what a person is actually asking about when they look
     at a three-hour payout. All three are computed by the core. */
  put('.calc-big', D.mine === null ? NA : money(D.mine));
  put('.cs-day', D.perDay === null ? NA : money(D.perDay));
  put('.cs-30d', D.per30d === null ? NA : money(D.per30d));
  put('.cs-yield', D.yieldPerEpoch === null ? NA : nf(D.yieldPerEpoch * 100, 2) + '%');
  put('.cs-apr', D.yieldAnnual === null ? NA : nf(D.yieldAnnual * 100, 0) + '%');
  put('.calc-per', 'per epoch · every ' + MODEL.epochHours + 'h');

  const caveat = $('.caveat');
  if (caveat) {
    caveat.innerHTML = D.mine === null
      ? '<b>No token address is set,</b> so there is no volume to compute from. '
        + 'The moment the contract is live this fills in by itself.'
      : '<b>Model, not a record.</b> Computed from live 24h volume at the '
        + 'published rate: the pool charges ' + nf(MODEL.poolFeeBps / 100, 0)
        + '%, the venue keeps ' + nf(MODEL.venueShare * 100, 0)
        + '% of it, and the remaining ' + nf(MODEL.wedgeBps / 100, 1)
        /* The number of seats is taken from MODEL rather than written out as
           a word. "split six ways" stood here from the days when the basket
           held six, and it survived the move to ten: the storefront carried
           "0.7% split six ways" next to ten rows of the breakdown. Caught on
           a screenshot, not by a check: the checks read numbers, not prose. */
        + '% goes to holders in full, split ' + MODEL.seats
        + ' ways every ' + MODEL.epochHours
        + ' hours. Day and month figures assume this volume holds. '
        + 'No epoch has settled yet.';
  }

  /* The breakdown by token: the wedge is split between the seats evenly,
     "equal weight", as in the rules. The number of coins is computed from
     each constituent's live price. */
  const perSeat = D.perSeat;

  /* The "10 rows" caption was written into the markup as a number.

     There are ten seats in the basket, but fewer may be found: the network is
     young, and the collector takes only the pools that really exist. At that
     moment the storefront carried "10 rows" above six rows, that is, the page
     claimed one thing and showed another, and that did nothing for the trust
     its other numbers deserved.

     We count by fact: however many rows were shown, that is what gets
     written. The only number that has the right to stand here is the one a
     person can recount with their eyes. */
  const rows = stretchTo($$('.crow'), MODEL.seats);
  const shown = Math.min(rows.length, BASKET.length);
  const rowsAnn = $$('.ann').find(el => /^[\d—]+\s+rows?$/i.test(el.textContent.trim()));
  if (rowsAnn) rowsAnn.textContent = BASKET.length ? shown + (shown === 1 ? ' row' : ' rows')
                                                  : '— rows';

  rows.forEach((row, i) => {
    const t = BASKET[i];
    if (!t) { row.hidden = true; return; }
    row.hidden = false;
    const name = $('span > b', row);
    if (name) name.textContent = t.sym;
    const q = $('.q', row), d = $('.d', row);
    if (q) q.textContent = perSeat === null ? NA : units(perSeat / t.price);
    if (d) d.textContent = perSeat === null ? NA : money(perSeat);
    setRowIcon(row, t);
  });
}

/* =========================================================================
   FONTS AND THE OLD SWITCHES

   Five switches used to live here: ?bg= for the texture of the cards, ?fig=
   for the figure, ?render= for the way it was shown, ?type= and ?mono= for
   the fonts. They were needed while the decisions were made by eye on a live
   page: arguing about a texture over messages is pointless, it has to be
   seen.

   The decisions are made: foil, a six-can pack, Azeret Mono. Everything
   spare is deleted: every unused variant is code that must not be broken by
   any edit nearby, for the sake of a look nobody will ever see.

   WHY THE KEYS ARE WIPED. The choice was remembered in localStorage, and
   that memory outlives a deploy. Anyone who had ever opened `?render=ascii`
   had "ascii" remembered by their browser, and after the parameters were
   removed they would still have seen the old figure made of characters
   instead of the pack. That is exactly what happened. Ceasing to read the
   keys is not enough, they have to be removed.
   ========================================================================= */
(function forgetOldChoices() {
  try {
    for (const k of ['apex.bg', 'apex.fig', 'apex.render',
                     'apex.type', 'apex.mono', 'apex.theme']) {
      localStorage.removeItem(k);
    }
  } catch (_) { /* private mode: there was nowhere to store it anyway */ }
})();

(function loadFonts() {
  /* preconnect before the link itself: without it the browser first resolves
     the domain and shakes hands, and only then learns that it needs a font. */
  for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const l = document.createElement('link');
    l.rel = 'preconnect'; l.href = href;
    if (href.includes('gstatic')) l.crossOrigin = 'anonymous';
    document.head.appendChild(l);
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Azeret+Mono:wght@300;400;500&display=swap';
  document.head.appendChild(link);
})();

/**
 * The real token icon in the breakdown row under the calculator.
 *
 * The rows read as mini-cards of the same basket as the six large ones
 * above, which means the coin in them has to be the same one too, not our
 * abstract mark. The mark stays under the picture and becomes visible on its
 * own if the picture did not load.
 *
 * The two traps here are exactly the ones that were on the large cards, and
 * both cost an evening each, so they are repeated word for word rather than
 * "from memory":
 *
 *   1. The redraw key is the symbol AND the address of the picture. Keyed on
 *      the symbol alone, a row remembered "drawn" on the first read, where
 *      there were no icons yet, and skipped the next read, the one that had
 *      them.
 *   2. No loading="lazy". The picture is created outside the document and
 *      gets into it only after onload; a lazy one does not load until it is
 *      in the document, that is, never. The event does not arrive at all,
 *      neither onload nor onerror, and the console is empty.
 */
/* =========================================================================
   THE TONE OF A TOKEN

   The window with the icon on a card is painted in the colour of the token
   itself, taken down into shadow. The colour is stored nowhere and cannot be
   written in by hand: the composition of the basket changes every three
   hours, and a list of six colours would be out of date the same day. So it
   has to be MEASURED off the icon itself.

   THE MAIN RULE: a colour counts only if there is A LOT of it in the icon.

   The first version took the most saturated shade, and on CASHCAT that gave
   brown, even though the icon is almost entirely white. The measurement
   explains why: coloured pixels are 11.5% of it at a saturation of 0.17,
   that is, all the "colour" is fur and shadows on a white photo. For
   comparison, STONKBROKER has 54% coloured at a saturation of 1.00, DOGO has
   25% at 0.90.

   So what decides is the share multiplied by the saturation:
     STONKBROKER 0.54 × 1.00 = 0.54     AI      0.73 × 0.34 = 0.25
     DOGO        0.25 × 0.90 = 0.23     PIPEDOG 0.23 × 0.39 = 0.09
     CASHCAT     0.12 × 0.17 = 0.02     PONS    0.00        = 0.00
   A threshold of 0.05 cuts off CASHCAT and PONS and keeps PIPEDOG, whose
   brown is honest: it is a dog's fur across the whole icon. Between CASHCAT
   and PIPEDOG there is almost a fivefold gap, so the threshold is not on a
   knife edge.

   HOW THE HUE IS COMPUTED. The icon is scaled down to 32×32. Pixels that lie
   about colour are thrown away: the near-grey ones (a channel spread below
   0.12), the near-black and the near-white ones, whose "hue" is compression
   noise, and the transparent ones. What is left is spread over twenty-four
   hue bins weighted by saturation, and inside the winning bin the hue is
   averaged AROUND THE CIRCLE, through a sine and a cosine: an ordinary mean
   between 350° and 10° would give 180°, that is, red would come out
   turquoise.

   The saturation of the result is taken from the measurement too rather than
   set: a weak colour has to come out muted, otherwise a pale icon gets a
   window as bright as STONKBROKER's.

   The icon has to go through our /api/icon: a foreign CDN sends no CORS, and
   getImageData on a tainted canvas throws an exception instead of a colour.
   ========================================================================= */
const TONES = new Map();

/* The "there is enough colour in the icon" threshold. Derived from measuring
   the six basket icons, see the table above. */
const TONE_MIN = 0.05;

/* The neutral tone is written with theme variables rather than numbers:
   there are fifteen themes, and a grey window has to be grey in the tone of
   the current one. */
const NEUTRAL_TONE = {
  base: 'color-mix(in srgb, var(--color-block-2) 62%, #000)',
  hi:   'color-mix(in srgb, var(--color-block) 70%, transparent)',
};

function dominantTone(img) {
  const N = 32;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return NEUTRAL_TONE;

  let px;
  try {
    g.drawImage(img, 0, 0, N, N);
    px = g.getImageData(0, 0, N, N).data;
  } catch (_) {
    return NEUTRAL_TONE;               // the canvas is tainted, at least give an even tone
  }

  const BINS = 24;
  const w = new Float64Array(BINS), hx = new Float64Array(BINS), hy = new Float64Array(BINS);
  const sats = [];
  let opaque = 0;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    if (a < .5) continue;
    opaque++;

    const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), d = mx - mn;
    if (d < .12) continue;                       // grey
    const l = (mx + mn) / 2;
    if (l < .06 || l > .96) continue;            // near-black and near-white

    const s = d / (1 - Math.abs(2 * l - 1));
    sats.push(s);

    let hh;
    if (mx === r) hh = ((gg - b) / d + 6) % 6;
    else if (mx === gg) hh = (b - r) / d + 2;
    else hh = (r - gg) / d + 4;
    hh *= 60;

    const k = Math.floor(hh / (360 / BINS)) % BINS;
    w[k] += s;
    hx[k] += Math.cos(hh * Math.PI / 180) * s;
    hy[k] += Math.sin(hh * Math.PI / 180) * s;
  }

  if (!opaque || !sats.length) return NEUTRAL_TONE;

  /* A median, not a mean: one bright red pixel on a white photo would shift a
     mean noticeably, a median not at all. */
  sats.sort((a, b) => a - b);
  const medS = sats[sats.length >> 1];
  const share = sats.length / opaque;
  if (share * medS < TONE_MIN) return NEUTRAL_TONE;

  let best = 0;
  for (let k = 1; k < BINS; k++) if (w[k] > w[best]) best = k;
  const hue = (Math.atan2(hy[best], hx[best]) * 180 / Math.PI + 360) % 360;
  const sat = Math.round(Math.min(70, Math.max(14, medS * 90)));

  /* The lightness is set here rather than taken from the icon. The card is
     dark, and the window has to stay dark no matter how bright the token is:
     otherwise a glowing rectangle would hang next to a black card. */
  return {
    base: `hsl(${hue.toFixed(0)} ${sat}% 9%)`,
    hi:   `hsl(${hue.toFixed(0)} ${Math.min(78, sat + 8)}% 21%)`,
  };
}

function tokenTone(url) {
  if (!url) return Promise.resolve(null);
  if (TONES.has(url)) return TONES.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(dominantTone(img));
    img.onerror = () => resolve(null);
    img.src = API_BASE + '/api/icon?u=' + encodeURIComponent(url);
  });
  TONES.set(url, p);
  return p;
}

function setRowIcon(row, t) {
  const host = $('.sv', row);
  if (!host) return;
  if (host.dataset.sym === t.sym && host.dataset.icon === (t.icon || '')) return;
  host.dataset.sym = t.sym;
  host.dataset.icon = t.icon || '';
  host.classList.remove('has-icon');
  const old = $('img', host);
  if (old) old.remove();
  if (!t.icon) return;

  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => { host.classList.add('has-icon'); host.appendChild(img); };
  img.onerror = () => { /* our mark stays */ };
  img.src = t.icon;
}

function wireCalc() {
  const input = $('.calc input[type="range"]');
  if (!input) return;

  /* Typing by hand. The slider is logarithmic and rounds to something round,
     so "19,650,000" cannot be entered with it, and that is exactly how many
     coins a person holds. While there was no field, the only way to set your
     own number was one of the four presets. */
  const field = $('.calc-amount');
  if (field) {
    const read = () => {
      const raw = field.value.replace(/[^\d]/g, '');
      const n = Number(raw || 0);
      HOLD = Math.min(Math.max(n, 0), MAX_HOLD);
      input.value = a2s(HOLD);
      paintCalc();
    };
    field.addEventListener('input', read);
    /* On leaving the field we draw the separators back in and pull the value
       to the limits: the correction is shown at once rather than the number
       being changed silently under their fingers. */
    field.addEventListener('blur', () => {
      HOLD = Math.min(Math.max(HOLD, 0), MAX_HOLD);
      field.value = nf(HOLD);
      paintCalc();
    });
    field.addEventListener('keydown', e => { if (e.key === 'Enter') field.blur(); });
  }
  /* The slider is the source of the value only while it is being dragged.
     The rest of the time the value is exact and arrives from outside. */
  input.addEventListener('input', () => { HOLD = s2a(Number(input.value)); paintCalc(); });
  const map = [1e6, 1e7, 5e7, 2.5e8];
  $$('.chip').forEach((chip, i) => {
    chip.addEventListener('click', () => {
      setHold(map[i]);
      $$('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      chip.setAttribute('aria-pressed', 'true');
    });
  });
}

/* =========================================================================
   Section 4, the basket cards
   ========================================================================= */

/** A sparkline out of what is actually known: the 5m, 1h, 6h and 24h changes. */
function sparkPoints(t) {
  const past = [t.chg24, t.chg6, t.chg1, t.chg5, 0];
  const vals = past.map(c => 1 / (1 + (c || 0) / 100));   // the price relative to the current one
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  return vals.map((v, i) =>
    (i * (100 / (vals.length - 1))).toFixed(1) + ',' +
    (35 - ((v - min) / span) * 30).toFixed(1)
  ).join(' ');
}

/**
 * Stretch a list to the required length by cloning the last element.
 *
 * WHY. The markup came down from a basket of SIX seats: six cards in "The
 * ten" and six rows in the share breakdown. The seats became ten, and the
 * markup stayed as it was, and the site silently showed six out of ten. The
 * heading said "The ten", the ranks counted "01/10", the caption promised
 * "10 rows", and all of that stood above six positions.
 *
 * Checks cannot catch this: they ask the code for the number of seats, they
 * do not count rectangles on a screen. Seen with the eyes, on a screenshot.
 *
 * Writing them into the HTML by hand is even less of an option: then the next
 * change to the number of seats repeats the same story. The markup is drawn
 * from MODEL.seats, that is, from the only place where that number lives.
 */
function stretchTo(nodes, want) {
  if (!nodes.length || nodes.length >= want) return nodes;
  const last = nodes[nodes.length - 1];
  const parent = last.parentElement;
  for (let i = nodes.length; i < want; i++) {
    const copy = last.cloneNode(true);
    copy.removeAttribute('hidden');
    parent.appendChild(copy);
  }
  return [...parent.children].filter(el => el.matches(last.tagName + '.' + last.classList[0]));
}

function paintBasketCards() {
  const cards = stretchTo($$('.tc'), MODEL.seats);
  const w = weights();
  cards.forEach((card, i) => {
    const t = BASKET[i];
    /* A seat without data is not hidden. A hidden card reads as "there are
       five of them", and on a site with a six in its name that is the first
       thing a person notices, and they would be right: what went missing is
       not the styling, it is a position in the basket. The seat stays and
       says that it is being read. */
    if (!t) {
      card.hidden = false;
      card.classList.add('waiting');
      const bw = $('.tc-top b', card);
      if (bw) bw.textContent = '—';
      const nw = $('.nm', card);
      if (nw) nw.textContent = 'reading chain…';
      const pw = $('.pr', card);
      if (pw) pw.textContent = NA;
      const rkw = $('.rk', card);
      if (rkw) rkw.innerHTML = String(i + 1).padStart(2, '0') + '<b>/' + MODEL.seats + '</b>';
      card.onclick = null;
      card.style.cursor = 'default';
      return;
    }
    card.hidden = false;
    card.classList.remove('waiting');

    const b = $('.tc-top b', card);
    if (b) b.textContent = t.sym;
    /* The number with a denominator: "01" on its own does not say out of how
       many. The denominator is taken from the model rather than written in as
       a six: a hard-coded number would have survived a change to the size of
       the basket and lied silently. */
    const rk = $('.rk', card);
    if (rk) rk.innerHTML = String(i + 1).padStart(2, '0') + '<b>/' + MODEL.seats + '</b>';
    const nm = $('.nm', card);
    if (nm) nm.textContent = t.name;
    const pr = $('.pr', card);
    if (pr) pr.textContent = price(t.price);

    const ch = $('.ch span:first-child', card);
    if (ch) {
      ch.className = t.chg24 >= 0 ? 'up' : 'dn';
      ch.textContent = (t.chg24 >= 0 ? '▲ ' : '▼ ') + pct(t.chg24);
    }
    /* The art of the card is the real token icon, not our abstract mark. That
       is what turns a table row into a card: a card has to have an object
       people recognise.

       The icons live on foreign CDNs (DexScreener and CoinGecko through the
       explorer), and every one of them has to be treated as one that will not
       load: the domain goes down, the picture gets deleted, a new constituent
       does not have one at all. So our mark always lies under the picture,
       and it is what stays alone if onerror fired. An empty frame instead of
       the art looks like broken layout rather than like "there is no icon". */
    let art = $('.tc-art', card);
    if (!art) {
      art = document.createElement('span');
      art.className = 'tc-art';
      art.setAttribute('aria-hidden', 'true');
      card.insertBefore(art, card.firstChild);
    }
    /* We compare both the symbol and the address of the icon. At first it was
       the symbol alone, and the icons did not appear at all: the first read
       came out of the database, where the records had been made before icons
       were collected at all. The card remembered "PIPEDOG is drawn" and on
       the next read, the one that had the icon, decided there was nothing to
       redraw. The data arrived later than the drawing decided it was done. */
    if (art.dataset.sym !== t.sym || art.dataset.icon !== (t.icon || '')) {
      art.dataset.sym = t.sym;
      art.dataset.icon = t.icon || '';
      art.classList.remove('has-icon');
      const mark = $('.tc-top .sv svg', card);
      art.innerHTML = '<span class="tc-art-in">' + (mark ? mark.outerHTML : '') + '</span>';
      if (t.icon) {
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        /* No loading="lazy", and that is not forgetfulness.

           The picture is created outside the document and gets into it only
           after onload. The browser defers loading lazy images until they end
           up in the markup near the viewport, and this one never will, because
           it is waiting for its own onload. Measured: with lazy the event does
           not arrive at all, neither onload nor onerror, and the card stands
           there forever with the mark instead of an icon.

           No error, no trace in the console: it looks exactly like "there is
           no icon". */
        /* We show it only after a successful load: an <img> substituted in at
           once with a broken link draws the broken-image icon over our mark,
           which is worse than showing nothing. */
        img.onload = () => { art.classList.add('has-icon'); art.appendChild(img); };
        img.onerror = () => { /* the mark stays */ };
        img.src = t.icon;

        /* The tone of the window is the measured colour of the icon itself.
           Checking the dataset before applying it is mandatory: the basket is
           re-read every minute, and by the time the colour has been computed
           there may already be a different token in this card. It would then
           get somebody else's colour. */
        const want = t.icon;
        tokenTone(want).then(tone => {
          if (!tone || art.dataset.icon !== want) return;
          card.style.setProperty('--tone', tone.base);
          card.style.setProperty('--tone-hi', tone.hi);
          card.classList.add('has-tone');
        });
      } else {
        card.classList.remove('has-tone');
      }
    }

    const poly = $('.spark polyline', card);
    if (poly) poly.setAttribute('points', sparkPoints(t));

    /* Equal weight is a rule of the basket, not a measurement. The number is
       taken from weightsBps: six seats do not divide into ten thousand basis
       points, and the top seats get one point more. Writing "10.00%" by hand
       would mean lying by four hundredths and diverging from the contract. */
    const bar = $('.wbar .t i', card);
    if (bar) bar.style.width = (w[i] * 100).toFixed(1) + '%';
    const em = $('.wbar + em, .tc-foot em', card);
    if (em) em.textContent = nf(WEIGHTS[i] / 100, 2) + '%';
    /* In the footer is the liquidity of the pool, that is, exactly what the
       seat was given for. There used to be a dash here where "how much was
       bought" would go: honest but useless, because nothing will be bought
       until the first epoch, while the seat in the basket is earned already,
       and the depth is where you can see it. */
    const val = $('.val', card);
    if (val) val.textContent = t.liq > 0 ? money(t.liq) : NA;

    // The card leads to the explorer: the address can be checked without trusting the page.
    card.style.cursor = 'pointer';
    card.onclick = () => window.open(t.url, '_blank', 'noopener');
    card.title = t.address;
  });

  const foot = $('.tc-foot-note') || null;
  if (foot) foot.textContent = 'scanned ' + META.scanned + ' tokens · ' + META.priced + ' priced';
}

/* =========================================================================
   Section 5, the ledger. There were no payouts, so there are no rows and
   inventing them is not allowed. The empty state says why it is empty.
   ========================================================================= */
/**
 * The captions in the section footers. In the original his own totals stand
 * there: "total cost $312,880", "5 epochs", "paid in kind … total $128,470".
 * We have not one of those numbers, and leaving them would mean promising
 * more than the code can do.
 */
function paintFootlines() {
  /* His captions are not rewritten, they are part of the layout. Only the
     places with his numbers change: where he has the money of closed epochs,
     we have a dash. We compare by the whole text: the captions are set with
     <b> inside, and a filter over childless nodes skipped them, so three
     numbers went on standing at the bottom of the calculator, the basket and
     the ledger. */
  const swap = (re, text) => {
    $$('.corners span, .mid, .ann, .fn, .btm span').forEach(el => {
      if (el.closest('.prev') || $('.src', el)) return;
      if (re.test(el.textContent.trim())) el.innerHTML = text;
    });
  };
  const spot = SELF && SELF.price;
  swap(/^supply [\d,]+ · spot .*/i,
       'supply <b>' + nf(MODEL.supply) + '</b> · spot <b>' +
       (spot ? price(spot) : '—') + '</b>');
  /* The footers of the sections about epochs. A dash where he has money reads
     as a broken field; words read as an honest "there has not been one yet".
     The clock does not go here: it is in the summary and in the ledger, and
     the footer is set at 9px, where ticking digits would be noise rather than
     information. */
  const settled = (SELF && SELF.epochs && SELF.epochs.length) || 0;
  swap(/^last epoch bought .*/i,
       settled ? 'last epoch bought <b>—</b> · <b>—</b> per seat'
               : 'first epoch has not closed yet');
  swap(/^total \$[\d,]+$/i, settled ? 'total <b>—</b>' : 'nothing distributed yet');
  swap(/^constituents · as of.*/i,
       'constituents · as of ' + new Date().toISOString().slice(0, 10));
  swap(/^\d+ epochs?$/i, settled ? settled + ' epochs' : 'none yet');
}

function paintLedger() {
  const rows = $$('.lr');
  if (!rows.length) return;
  const head = rows[0];                       // the table header
  rows.slice(1).forEach(r => r.remove());
  /* A clock instead of a paragraph.

     The paragraph explained why it is empty here, and it was right, but it
     answered the wrong question. A person who has scrolled down to the ledger
     is asking "when", not "why": the empty table is visible enough by itself.
     The clock answers exactly that and shows at the same time that the page
     is alive rather than abandoned.

     The time is the same as in the "next distribution" card: one clock for
     the project, counted from UTC in tick(). If they diverge, a buyer will
     notice.

     The "treasury" is no longer here: the word was left over from an early
     scheme and outlived it; caught on a screenshot. */
  head.insertAdjacentHTML('afterend',
    '<div class="ledger-empty ledger-wait">' +
      '<span class="lw-k">first epoch and first payout in</span>' +
      '<span class="lw-t" id="ledgerClock">··:··:··</span>' +
      '<span class="lw-s">Epochs close every <b>' + MODEL.epochHours +
      ' hours</b>. The first row appears when one settles: a transaction ' +
      'hash on Robinhood Chain, not a number typed into this page.</span>' +
    '</div>');
  head.remove();                              // a header with no rows reads as a breakage

  const ann = $$('.ann').find(el => /epochs?$/i.test(el.textContent.trim()));
  if (ann) ann.textContent = 'none yet';
}

/* =========================================================================
   The epoch clock. Counted from real UTC, not from a variable somebody will
   forget to move.
   ========================================================================= */
function tick() {
  const now = new Date();
  const ms = MODEL.epochHours * 3600 * 1000;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const left = ms - ((now.getTime() - start) % ms);
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const text = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');

  const k = $$('.kpi')[7];   // the eighth card, the last one across the two rows
  if (k) $('.v', k).textContent = text;

  /* The same clock in the empty ledger. Computed once and placed in both
     spots: two copies of this calculation would one day diverge by a second,
     and there would be nothing to explain it with. */
  const lc = $('#ledgerClock');
  if (lc) lc.textContent = text;
}

/* =========================================================================
   The state of the source, said out loud rather than in the console
   ========================================================================= */
function paintStatus() {
  let box = $('.src');
  if (!box) {
    box = document.createElement('span');
    box.className = 'src';
    box.innerHTML = '<i class="dot"></i><span class="txt"></span>';
    /* In the corner of the order book the original has "index · rotating",
       and we do not take it over. The source label lives in the badge by the
       heading of the first section, next to his line rather than in place of
       it: clearing somebody else's node means erasing the very thing the
       layout was copied for. */
    const host = $('.prev') || $('.corners');
    if (host) host.appendChild(box); else document.body.appendChild(box);
  }
  const txt = $('.txt', box);
  if (META.failed) {
    box.className = 'src bad';
    txt.textContent = '· chain did not answer';
    return;
  }
  if (!BASKET.length) { box.className = 'src'; txt.textContent = '· reading…'; return; }
  box.className = 'src ok';
  const bits = [];
  if (META.source === 'fallback') bits.push('partial list');
  /* Who went for the data is part of the truth about it. When the service is
     unavailable the page reads the chain itself: it works the same way, but
     free foreign APIs fall over more often, and "partial list" is then not an
     accident but a consequence. Keeping quiet about it means passing one off
     for the other. */
  if (META.via === 'direct') bits.push('read in-browser');
  /* We show the server-side age: if the collector is stuck, "2s ago" by the
     browser clock would lie about freshness, because what refreshed was the
     page, not the data. */
  const seenMs = Number.isFinite(META.age) ? Date.now() - META.age : META.at;
  bits.push(ago(seenMs));
  txt.textContent = '· ' + bits.join(' · ');
}

/* =========================================================================
   The X and GitHub links. There are no accounts yet, so the buttons say so
   honestly instead of leading nowhere. Once the addresses exist, write them
   into SOCIAL and the buttons become ordinary links, nothing else needs
   changing.
   ========================================================================= */
const SOCIAL = {
  x: '',        // https://x.com/…
  /* The GitHub button is deliberately off.

     The source mirror exists and carries the whole current code, but
     filling this line lights up a public button on the storefront, and
     under it stands "source, open at launch", a promise somebody will have
     to answer for. That is the owner's call, not the code's.

     Write the address in and the button becomes an ordinary link, nothing
     else needs changing. While it is empty the same mechanism as for X
     shows a hint instead of a dead link. */
  github: '',
};

function wireSocial() {
  $$('.soc').forEach(el => {
    const key = el.dataset.soc;
    const href = SOCIAL[key];
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; return; }
    el.classList.add('soon');
    el.addEventListener('click', e => {
      e.preventDefault();
      /* On an icon button there is no text to substitute, it has none. So
         "soon" is said with a hint and a short blink of the border rather
         than by swapping a string: a button must not behave silently. */
      const icon = !el.textContent.trim();
      if (icon) {
        const was = el.getAttribute('title');
        el.setAttribute('title', 'link goes live at launch');
        el.classList.add('blink');
        setTimeout(() => { el.classList.remove('blink'); if (was) el.setAttribute('title', was); }, 1400);
        return;
      }
      const prev = el.textContent;
      el.textContent = 'SOON';
      setTimeout(() => { el.textContent = prev; }, 1400);
    });
  });
}

/* The wallet lives in wallet.js: connecting, the network, balances. All we do
   here is hand it the button. It used to answer "NO CONTRACT YET" honestly,
   which was true while there was nothing to connect to, but the network and
   the gas exist without our token too, and looking at them is already
   useful. */
function wireConnect() {
  if (window.ApexWallet) {
    window.ApexWallet.wire();
    window.ApexWallet.restore();
  }
}

/* The wallet substitutes the real balance in here once, after which the
   person moves the slider themselves. We hand out a function rather than the
   slider itself: let the rule for how a number turns into a position stay in
   one place. */
window.ApexCalc = function (amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  /* The wallet balance is substituted as it is, without rounding: it is their
     real number, and replacing it with a "pretty" one is not allowed. */
  setHold(Math.min(amount, MODEL.supply));
  $$('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
};

/* The contract address under the heading: the first thing people look for
   when they arrive from an exchange or a feed. It appears together with the
   address and disappears without it: an empty "contract: —" line helps
   nobody.

   The copy button has to answer a press. On loothood a button just like it
   lived for a month looking flawless and copying nothing: nobody saw the
   error, because it kept quiet. */
function paintContract() {
  const box = $('.ca');
  if (!box) return;
  const token = window.ApexChain.launchAddress('token');
  if (!token) { box.hidden = true; return; }
  box.hidden = false;
  const v = $('.ca-v', box);
  const scan = $('.ca-scan', box);
  if (v) v.textContent = token;
  if (scan) scan.href = window.ApexChain.CHAIN.explorer + '/token/' + token;
}

function wireContract() {
  const btn = $('.ca-copy');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const token = window.ApexChain.launchAddress('token');
    if (!token) return;
    const say = (text, ok) => {
      const prev = btn.textContent;
      btn.textContent = text;
      btn.classList.toggle('bad', !ok);
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('bad'); }, 1400);
    };
    try {
      await navigator.clipboard.writeText(token);
      say('copied', true);
    } catch (_) {
      /* The clipboard is closed, for instance because the page was not opened
         over https. Then we select the text so the person can copy it
         themselves instead of guessing. */
      const v = $('.ca-v');
      if (v) {
        const r = document.createRange();
        r.selectNodeContents(v);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        say('select+C', false);
      } else say('copy failed', false);
    }
  });
}

/* The buy link. It appears only once the token address is known: a "buy"
   button leading nowhere is worse than a missing one, and on the previous
   project one like that sent a buyer to a 404. */
function paintBuy() {
  const token = window.ApexChain.launchAddress('token');
  const url = window.ApexChain.buyLink();
  let a = $('.acts .btn.buy');
  /* No token address or no link means no button.

     The link now appears by itself: as soon as the token has a pool, chain.js
     assembles the address of its page on the storefront. There used to be no
     button until somebody typed the link into the console by hand, and that
     made the launch depend on whether a live person remembered to do it in
     the first minutes.

     It stays empty here only until launch, while there is no pool yet. */
  if (!token || !url) { if (a) a.remove(); return; }
  if (!a) {
    a = document.createElement('a');
    a.className = 'btn f buy';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Buy $' + BRAND.ticker;
    const acts = $('.acts');
    if (acts) acts.insertBefore(a, acts.firstChild);
  }
  a.href = url;
}

/* =========================================================================
   The first-screen metrics

   Four numbers under the orb. Not one of them is written into the markup: it
   holds dashes, and they stay dashes until the chain answers. The rule is the
   same as for the ledger and the summary, and for the same reason: a
   storefront that promises money must not show invented figures even for half
   a second.

   The share and the number of seats are taken from MODEL, that is, from the
   same core the calculator and the server compute by. Liquidity and turnover
   are the sum over the basket, read from the chain.
   ========================================================================= */
function paintHero3d() {
  const put = (k, v) => { const el = $('[data-k="' + k + '"]'); if (el) el.textContent = v; };

  const wedge = MODEL.wedgeBps / 100;
  put('wedge', (Number.isInteger(wedge) ? wedge : wedge.toFixed(1)) + '%');
  put('seats', String(MODEL.seats));

  if (!BASKET.length) { put('liq', '—'); put('vol', '—'); return; }
  const sum = (f) => BASKET.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const liq = sum('liq'), vol = sum('vol24');
  put('liq', liq > 0 ? money(liq) : '—');
  put('vol', vol > 0 ? money(vol) : '—');
}

/* =========================================================================
   Places without data

   While there is no token, almost every number on the page is a dash, and
   that is right: inventing them is not allowed. But a dash set in the same
   size as a number reads not as "the data is not here yet" but as "a stroke
   instead of a digit". There are eight of them in a row in the summary, and
   the section looked like broken layout rather than like honestly empty.

   Here the places with a dash get a class, and CSS gives them their look: the
   small monospaced tone of a rule. The meaning does not change: the caption
   beside them already says in words what exactly is missing, "no token
   deployed", "not trading yet", "not indexed yet".

   By a pass over a list rather than by an edit to every output site: a dozen
   different functions put dashes in, and adding the class to each of them
   would mean a dozen places where it is easy to forget.
   ========================================================================= */
const NA_SEL = [
  '.kpi .v', '.n-xxl', '.n-xl', '.n-l', '.amt',
  '.calc-big', '.calc-rows dd', '.stat3d dd',
  '.tc-foot .val', '.crow .q', '.crow .d',
].join(',');

function markPlaceholders() {
  $$(NA_SEL).forEach(el => {
    el.classList.toggle('na', el.textContent.trim() === NA);
  });
}

/* =========================================================================
   Assembly
   ========================================================================= */
function paintAll() {
  paintTape();
  paintHero3d();
  paintSummary();
  paintBasket();
  paintBasketCards();
  paintCalc();
  paintFootlines();
  paintBuy();
  paintContract();
  paintStatus();
  markPlaceholders();
}

async function load() {
  /* Our own token is read separately and quietly: while there is no address,
     an object of zeros comes back and the page shows dashes. Write the address
     in and those same fields fill from the chain, with nothing else to fix. */
  window.ApexChain.readLaunch(part => { SELF = part; paintAll(); })
    .then(s => { SELF = s; paintAll(); })
    .catch(e => console.warn('could not read our own token:', e));

  try {
    const d = await window.ApexChain.readChain();
    BASKET = d.basket;
    META = { source: d.source, scanned: d.scanned, priced: d.priced, at: d.at, failed: null, via: d.via, age: d.age };
    if (!BASKET.length) throw new Error('the basket came back empty');
  } catch (e) {
    console.error('reading the chain failed:', e);
    META.failed = e.message || 'unknown error';
  }
  paintAll();
}

document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = BRAND.name; });
/* The tape is topped up right away, off the markup, without waiting for the
   chain: while there is no data a person is looking at the tape anyway, and a
   short one reads as a breakage rather than as "still loading". */
padTape();
window.addEventListener('resize', padTape, { passive: true });
wireCalc();
setHold(HOLD);
wireConnect();
wireSocial();
wireContract();
/* Invented numbers are blanked BEFORE the network, not after.

   The layout came down with somebody else's totals inside it: "$128,305
   dividends paid out", "across 9 epochs", "last epoch paid $7,254", "eligible
   supply 870.0M". All of it is covered by dashes, but the covering lived
   inside `paintAll()`, that is, only after the server answered. Measured: 0.8
   seconds on a fast connection, and for all that time a visitor sees a
   history of payouts that never happened. On a phone it is longer, and with a
   broken script it is forever.

   The worst possible first screen: a token that has paid nobody anything
   showing $128,305 handed out. One screenshot on launch day and the
   explaining takes a long time.

   So three paints run here, synchronously, on empty data: the page starts
   with dashes and fills in from the chain rather than the other way round.
   The ledger on the line below has been done exactly this way from day one.

   The tape and the coin cards are deliberately NOT added here: those carry
   real prices of real coins, out of date but not invented, and an empty tape
   on the first screen reads as a breakage. */
paintHero3d();
paintSummary();
paintBasket();
paintFootlines();
paintLedger();
paintCalc();
paintStatus();
markPlaceholders();
tick();
setInterval(tick, 1000);
setInterval(() => { if (BASKET.length) paintStatus(); }, 15000);
load();
