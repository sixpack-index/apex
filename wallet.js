/* =========================================================================
   The wallet.

   Everything to do with connecting lives here and nowhere else: the page
   knows how to draw, the core how to compute, and this file how to talk to a
   wallet.

   What it does once connected:
     - says whether the visitor is on the right network, and switches with one
       button;
     - shows the ETH balance (that is the gas) and the balance of our token;
     - substitutes the real balance into the calculator in place of the
       slider;
     - says whether the wallet clears the 0.01% cutoff, that is, whether it
       will receive a dividend at all.

   Why EIP-6963 and not `window.ethereum`: a person usually has several
   extensions, and they fight over one and the same variable. On the previous
   project Phantom intercepted the injection from the EVM wallets, and
   "connect" opened the wrong one. The standard solves this by having each
   extension announce itself, and we show the list.

   An ordinary script rather than a module, and wrapped in a function, like
   the core and chain.js: <script> tags share one lexical scope across the
   whole page.
   ========================================================================= */

(function () {

const C = globalThis.ApexCore;

/* Network parameters for wallet_addEthereumChain. They match ChainList and
   the Robinhood documentation, checked on 26 August. If a wallet does not
   know the chain, it will offer to add it from these fields. */
const NETWORK = {
  chainId: '0x1237',                    // 4663
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [C.CHAIN.rpc],
  blockExplorerUrls: [C.CHAIN.explorer],
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- the wallets found ---------- */

/* Each extension announces itself with an event. We collect them into a map
   keyed by uuid: one and the same wallet announces itself several times, and
   without a key the list fills up with duplicates. */
const WALLETS = new Map();

window.addEventListener('eip6963:announceProvider', e => {
  const d = e.detail;
  if (d && d.info && d.provider) WALLETS.set(d.info.uuid, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

/** The list of wallets. If not one announced itself, we try the old way. */
function available() {
  const list = [...WALLETS.values()];
  if (list.length) return list;
  /* The fallback path for extensions that cannot do EIP-6963. It is also the
     reason the standard appeared: the wrong wallet may turn up here. */
  if (window.ethereum) {
    return [{ info: { uuid: 'legacy', name: 'Injected wallet', icon: '' }, provider: window.ethereum }];
  }
  return [];
}

/* ---------- state ---------- */

const S = {
  provider: null,
  info: null,
  account: '',
  chainId: '',
  eth: null,        // the gas balance, in ether
  token: null,      // the balance of our token, in whole coins
  busy: false,
};

const LS = 'apex.wallet';        // the last wallet chosen

/* ---------- talking to the chain through the wallet ---------- */

const rpc = (method, params) => S.provider.request({ method, params });

const hexToNum = h => (typeof h === 'string' ? parseInt(h, 16) : Number(h));
const unwei = (hex, dec = 18) => Number(BigInt(hex || '0x0')) / Math.pow(10, dec);

/** balanceOf(address): the selector is worked out ahead of time so as not to pull in a library. */
function balanceOfData(addr) {
  return '0x70a08231' + '000000000000000000000000' + addr.replace(/^0x/, '').toLowerCase();
}

async function readBalances() {
  S.eth = null;
  S.token = null;
  if (!S.account) return;

  try {
    const wei = await rpc('eth_getBalance', [S.account, 'latest']);
    S.eth = unwei(wei);
  } catch (e) {
    console.warn('could not read the gas balance:', e.message);
  }

  const token = window.ApexChain.launchAddress('token');
  if (!token) return;
  try {
    const res = await rpc('eth_call', [{ to: token, data: balanceOfData(S.account) }, 'latest']);
    /* The denominator is not taken by eye: the launchpad token has 18
       decimals, but checking somebody else's contract from memory is a sure
       way to show a number off by a factor of a billion. */
    S.token = unwei(res, 18);
  } catch (e) {
    console.warn('the token balance did not read:', e.message);
  }
}

/* ---------- connecting ---------- */

async function connect(detail) {
  if (S.busy) return;
  S.busy = true;
  paint();
  try {
    S.provider = detail.provider;
    S.info = detail.info;
    const accounts = await rpc('eth_requestAccounts', []);
    S.account = (accounts && accounts[0]) || '';
    S.chainId = await rpc('eth_chainId', []);
    try { localStorage.setItem(LS, detail.info.uuid); } catch (_) {}

    /* The subscriptions are set on the provider once: if a person changes
       wallet or network, the page has to notice that itself rather than show
       the wrong balance until a reload. That is exactly how the wallet card
       once showed a balance two and a half times larger than the real one. */
    if (!detail._wired) {
      detail._wired = true;
      S.provider.on && S.provider.on('accountsChanged', accs => {
        S.account = (accs && accs[0]) || '';
        if (!S.account) disconnect();
        else readBalances().then(paint);
        paint();
      });
      S.provider.on && S.provider.on('chainChanged', id => {
        S.chainId = id;
        readBalances().then(paint);
        paint();
      });
    }

    if (onRightChain()) await readBalances();
  } catch (e) {
    /* 4001 means the person pressed "cancel". That is not an error, and there
       is nothing to go red about. */
    if (e && e.code !== 4001) console.warn('the connection failed:', e.message || e);
    if (!S.account) { S.provider = null; S.info = null; }
  } finally {
    S.busy = false;
    paint();
  }
}

function disconnect() {
  S.provider = null; S.info = null; S.account = '';
  S.chainId = ''; S.eth = null; S.token = null;
  try { localStorage.removeItem(LS); } catch (_) {}
  paint();
}

const onRightChain = () => hexToNum(S.chainId) === C.CHAIN.id;

/**
 * Switch the network, and if the wallet does not know it, offer to add it.
 * 4902 means "no such network"; then we add it from NETWORK and try again.
 */
async function switchChain() {
  if (!S.provider) return;
  try {
    await rpc('wallet_switchEthereumChain', [{ chainId: NETWORK.chainId }]);
  } catch (e) {
    if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
      try { await rpc('wallet_addEthereumChain', [NETWORK]); }
      catch (e2) { console.warn('the network was not added:', e2.message || e2); }
    } else if (e && e.code !== 4001) {
      console.warn('the network did not switch:', e.message || e);
    }
  }
  try { S.chainId = await rpc('eth_chainId', []); } catch (_) {}
  if (onRightChain()) await readBalances();
  paint();
}

/* ---------- drawing ---------- */

const short = a => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const nf = (v, d = 0) => Number(v).toLocaleString('en-US',
  { minimumFractionDigits: d, maximumFractionDigits: d });

function paint() {
  const btn = $('.connect');
  const pop = $('.wl-pop');
  if (!btn) return;

  if (S.busy) {
    btn.innerHTML = '<i aria-hidden="true"></i>CONNECTING…';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;

  if (!S.account) {
    btn.innerHTML = '<i aria-hidden="true"></i>CONNECT WALLET';
    btn.classList.remove('on');
  } else if (!onRightChain()) {
    btn.innerHTML = '<i aria-hidden="true"></i>WRONG NETWORK';
    btn.classList.remove('on');
  } else {
    btn.innerHTML = '<i aria-hidden="true"></i>' + short(S.account);
    btn.classList.add('on');
  }

  if (pop && !pop.hidden) paintPop(pop);
  paintHolding();
}

/** The contents of the dropdown: his layout, our strings. */
function paintPop(pop) {
  const rows = [];

  if (!S.account) {
    const list = available();
    if (!list.length) {
      rows.push('<div class="wl-err">No wallet found. Install MetaMask or another ' +
        'EVM extension, then reload the page.</div>');
    } else {
      list.forEach(d => {
        rows.push('<button type="button" class="wl-opt" data-uuid="' + d.info.uuid + '">' +
          (d.info.icon ? '<img src="' + d.info.icon + '" width="18" height="18" alt="">'
                       : '<span class="wl-dot"></span>') +
          (d.info.name || 'wallet') + '</button>');
      });
    }
  } else {
    rows.push(row('address', short(S.account)));
    rows.push(row('network', onRightChain()
      ? '<b class="ok">Robinhood Chain</b>'
      : '<b class="warn">chain ' + (hexToNum(S.chainId) || '?') + '</b>'));

    if (!onRightChain()) {
      rows.push('<div class="wl-err">Wrong network. Tap to switch — if your wallet ' +
        'does not know this chain, it will be added for you.</div>');
      rows.push('<button type="button" class="wl-act" data-act="switch">Switch to Robinhood Chain</button>');
    } else {
      rows.push(row('gas', S.eth === null ? '—' : nf(S.eth, 5) + ' ETH'));
      const token = window.ApexChain.launchAddress('token');
      if (!token) {
        rows.push(row('balance', '<b>—</b>'));
        rows.push('<div class="wl-err">The token is not launched yet, so there is no ' +
          'balance to read. Everything else here already works.</div>');
      } else {
        rows.push(row('balance', S.token === null ? '—'
          : '<b>' + nf(S.token) + '</b> ' + (window.ApexBrand || 'APEX')));
        const min = C.MODEL.supply * 0.0001;
        if (S.token !== null) {
          rows.push(row('eligible', S.token >= min
            ? '<b class="ok">yes</b>'
            : '<b class="warn">no — needs ' + nf(min) + '</b>'));
        }
        const buy = buyUrl();
        if (buy) {
          rows.push('<a class="wl-act" href="' + buy +
            '" target="_blank" rel="noopener">Buy on the launchpad</a>');
        }
      }
      if (S.eth !== null && S.eth < 0.0002) {
        rows.push('<div class="wl-err">Almost out of gas. ETH reaches this chain over ' +
          'the Arbitrum bridge — without it no trade goes through.</div>');
      }
    }
    rows.push('<button type="button" class="wl-act ghost" data-act="disconnect">Disconnect</button>');
  }

  pop.innerHTML = rows.join('');
}

const row = (k, v) => '<div class="wl-row"><span>' + k + '</span>' +
  (v.startsWith('<') ? v : '<b>' + v + '</b>') + '</div>';

/* Buying happens on the launchpad, but the address of its page is taken from
   the settings rather than assembled from a template. The Pons storefront is
   a single-page application: cards are opened by script, and the direct path
   `/token/0x…` serves the same home page. I checked that in a browser, which
   is why there is no template here.

   A friend has no such link on his site at all, and a person arriving from
   the storefront is forced to look for the coin themselves. We will have one,
   but only a real one. */
const buyUrl = () => (window.ApexChain ? window.ApexChain.buyLink() : '');

/**
 * Substitute the real balance into the calculator.
 *
 * The slider stays: a visitor without a wallet has to see how this works. But
 * if a wallet is connected, it is more honest to show their own position than
 * an invented 19,650,000.
 */
function paintHolding() {
  /* The caption moved together with the relaid calculator: it used to live in
     `.cbox .ann`, which no longer exists. A reference like that does not fall
     over and does not complain, it simply stops finding the element, and the
     caption about the wallet silently disappears. So the selector here is one
     and the same as in the markup, not "roughly the same". */
  const ann = $('.calc-in .calc-note');
  if (!ann) return;
  if (!S.account) { ann.textContent = 'drag, type or pick a preset'; return; }
  if (!onRightChain()) { ann.textContent = 'wrong network'; return; }
  if (S.token === null) { ann.textContent = short(S.account); return; }
  ann.textContent = short(S.account) + ' · holds ' + nf(S.token);

  /* The MAX button appears only when there is something to put into it. An
     empty button that does nothing looks like it works and keeps quiet: on
     this same code a "copy address" button already lived a month that way. */
  const max = $('.chip.wallet-max');
  if (max) {
    const has = Number.isFinite(S.token) && S.token > 0;
    max.hidden = !has;
    if (has && !max.dataset.wired) {
      max.dataset.wired = '1';
      max.addEventListener('click', () => {
        if (typeof window.ApexCalc === 'function') window.ApexCalc(S.token);
      });
    }
  }
}

/** Put the wallet balance into the slider once, after which the person moves it themselves. */
let pushedOnce = false;
function pushBalanceToCalc() {
  if (pushedOnce || S.token === null || S.token <= 0) return;
  const input = $('.calc input[type="range"]');
  if (!input || typeof window.ApexCalc !== 'function') return;
  pushedOnce = true;
  window.ApexCalc(S.token);
}

/* ---------- wiring ---------- */

function wire() {
  const btn = $('.connect');
  const wl = $('.wl');
  if (!btn || !wl) return;

  let pop = $('.wl-pop', wl);
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'wl-pop';
    pop.hidden = true;
    wl.appendChild(pop);
  }

  btn.addEventListener('click', e => {
    e.preventDefault();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) paintPop(pop);
  });

  pop.addEventListener('click', async e => {
    const opt = e.target.closest('[data-uuid]');
    if (opt) {
      const d = available().find(x => x.info.uuid === opt.dataset.uuid);
      if (d) { await connect(d); paintPop(pop); await afterConnect(); }
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'switch') { await switchChain(); paintPop(pop); await afterConnect(); }
    if (act.dataset.act === 'disconnect') { disconnect(); paintPop(pop); }
  });

  /* A click outside closes it: a dropdown that cannot be closed is more
     annoying than no dropdown at all.

     The event path is taken from composedPath rather than by asking
     `wl.contains(target)`. The difference is not obvious and cost an hour: a
     handler inside the panel redraws its contents, the pressed button drops
     out of the tree in the process, and by the time of this check `contains`
     answers "no", so the panel closed by itself right after a wallet was
     picked, and the network switch button ended up in the markup but
     invisible. composedPath is captured at the moment of the event and
     survives the redraw. */
  document.addEventListener('click', e => {
    if (pop.hidden) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(wl) || wl.contains(e.target)) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });

  paint();
}

async function afterConnect() {
  pushBalanceToCalc();
  paint();
}

/* A quiet restore: if this wallet has been connected on this device before
   and is still permitted, we connect silently, with no window. Asking for
   permission on every visit is a sure way to make people stop pressing the
   button at all. */
async function restore() {
  let saved = '';
  try { saved = localStorage.getItem(LS) || ''; } catch (_) {}
  if (!saved) return;
  /* Extensions do not announce themselves instantly, so give them a frame or two. */
  await new Promise(r => setTimeout(r, 350));
  const d = available().find(x => x.info.uuid === saved);
  if (!d) return;
  try {
    const accs = await d.provider.request({ method: 'eth_accounts' });
    if (!accs || !accs.length) return;          // permission revoked, keep quiet
    await connect(d);
    await afterConnect();
  } catch (_) { /* silently: this is a background attempt, not a person's action */ }
}

window.ApexWallet = {
  wire, restore, connect, disconnect, switchChain, buyUrl,
  get state() { return { ...S, onRightChain: onRightChain() }; },
};

})();
