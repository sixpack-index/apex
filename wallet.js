/* =========================================================================
   The wallet. Solana.

   Everything to do with connecting lives here and nowhere else: the page
   knows how to draw, the core how to compute, and this file how to talk to a
   wallet.

   What it does once connected:
     shows the SOL balance and the balance of our token;
     substitutes the real balance into the calculator in place of the slider;
     says whether the wallet clears the 0.01% floor, that is, whether it will
     receive a dividend at all.

   WHAT IS NO LONGER HERE: switching the network. On EVM that was half the
   file: wallet_switchEthereumChain, wallet_addEthereumChain, the network
   parameters, the chainId check, the "Switch to Robinhood Chain" button and
   the "wrong network" branch all through the drawing. Solana has one network,
   there is nothing to switch, and that whole layer is thrown out rather than
   rewritten.

   HOW WALLETS ARE FOUND. The standard here is its own, Wallet Standard: an
   extension announces itself with a `wallet-standard:register-wallet` event
   instead of taking over one shared variable. It is the same trick as
   EIP-6963 on EVM, and for exactly the same reason: a person has several
   extensions, and they fight over `window.solana`. The fallback path for the
   ones that cannot do the standard is left below and marked.

   An ordinary script rather than a module, and wrapped in a function, like
   the core and chain.js: <script> tags share one lexical scope across the
   whole page.
   ========================================================================= */

(function () {

const C = globalThis.ApexCore;

const $ = (s, r = document) => r.querySelector(s);

/* ---------- the wallets found ---------- */

const WALLETS = new Map();

/* Registration by the standard. A wallet can announce itself both before our
   script and after it, so we both listen and ask them to announce
   themselves. */
function register(w) {
  if (!w || !w.name) return;
  const chains = w.chains || [];
  /* We are interested in Solana mainnet only. A wallet that can do nothing
     but test networks is only in the way in the list. */
  if (chains.length && !chains.some(c => String(c).startsWith('solana:'))) return;
  WALLETS.set(w.name, { info: { uuid: w.name, name: w.name, icon: w.icon || '' }, wallet: w });
}

window.addEventListener('wallet-standard:register-wallet', e => {
  try { e.detail(({ register: reg }) => reg && reg()); } catch (_) {}
  const w = e.detail && e.detail.wallet;
  if (w) register(w);
});
try {
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
    detail: { register: (...ws) => ws.forEach(register) },
  }));
} catch (_) {}

/* THE FALLBACK PATH. Wallets that put themselves into window the old way.
   It is also the reason the standard appeared: the wrong one may land here. */
function injected() {
  const out = [];
  const add = (name, p) => { if (p && typeof p.connect === 'function') out.push({ info: { uuid: name, name, icon: '' }, provider: p }); };
  add('Phantom', window.phantom && window.phantom.solana);
  add('Solflare', window.solflare);
  add('Backpack', window.backpack);
  if (!out.length && window.solana && typeof window.solana.connect === 'function') {
    add('Injected wallet', window.solana);
  }
  return out;
}

function available() {
  const std = [...WALLETS.values()].map(d => ({
    info: d.info,
    /* Under the standard a wallet has features; any one that can connect
       suits us. The same record gives access to the provider object. */
    provider: (d.wallet.features && d.wallet.features['standard:connect']) ? d.wallet : null,
    wallet: d.wallet,
  })).filter(d => d.provider || d.wallet);
  const seen = new Set(std.map(d => d.info.name.toLowerCase()));
  return std.concat(injected().filter(d => !seen.has(d.info.name.toLowerCase())));
}

/* ---------- state ---------- */

const S = {
  provider: null,
  info: null,
  account: '',
  sol: null,        // the SOL balance
  token: null,      // the balance of our token, in whole coins
  busy: false,
};

const LS = 'apex.wallet';

/* ---------- talking to the chain ----------

   We read through the node directly rather than through the wallet: the
   wallet has its own node, its own limits and its own confirmation windows,
   while all we need is to read two balances. The signature comes from the
   wallet, the reading from the node. */
async function rpc(method, params) {
  const r = await fetch(C.CHAIN.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'the node returned an error');
  return j.result;
}

async function readBalances() {
  S.sol = null;
  S.token = null;
  if (!S.account) return;

  try {
    const r = await rpc('getBalance', [S.account]);
    S.sol = Number(r && r.value) / 1e9;
  } catch (e) {
    console.warn('the SOL balance did not read:', e.message);
  }

  const token = window.ApexChain.launchAddress('token');
  if (!token) return;
  try {
    /* The token sits not on the wallet but on a separate account for this
       mint, and a wallet can have several accounts for one mint. We ask for
       all of them and add them up: showing the balance of one of them means
       one day showing less than the person has. */
    const r = await rpc('getTokenAccountsByOwner',
      [S.account, { mint: token }, { encoding: 'jsonParsed' }]);
    const accs = (r && r.value) || [];
    S.token = accs.reduce((sum, a) => {
      const amt = a.account.data.parsed.info.tokenAmount;
      return sum + Number(amt.uiAmount || 0);
    }, 0);
  } catch (e) {
    console.warn('the token balance did not read:', e.message);
  }
}

/* ---------- connecting ---------- */

async function connect(d) {
  if (S.busy) return;
  S.busy = true;
  try {
    let account = '';
    if (d.wallet && d.wallet.features && d.wallet.features['standard:connect']) {
      const res = await d.wallet.features['standard:connect'].connect();
      const acc = res && res.accounts && res.accounts[0];
      account = acc ? acc.address : '';
      S.provider = d.wallet;
    } else {
      const res = await d.provider.connect();
      account = String((res && res.publicKey) || d.provider.publicKey || '');
      S.provider = d.provider;
    }
    if (!account) throw new Error('the wallet did not hand out an address');
    S.account = account;
    S.info = d.info;
    try { localStorage.setItem(LS, d.info.uuid); } catch (_) {}
    await readBalances();
  } catch (e) {
    /* A refusal in the wallet window is not a breakage, it is an answer of
       "no". We keep quiet. */
    if (!/reject|denied|cancel/i.test(e.message || '')) {
      console.warn('the connection failed:', e.message);
    }
  } finally {
    S.busy = false;
  }
}

function disconnect() {
  try {
    if (S.provider && S.provider.features && S.provider.features['standard:disconnect']) {
      S.provider.features['standard:disconnect'].disconnect();
    } else if (S.provider && typeof S.provider.disconnect === 'function') {
      S.provider.disconnect();
    }
  } catch (_) {}
  S.provider = null; S.info = null; S.account = '';
  S.sol = null; S.token = null;
  try { localStorage.removeItem(LS); } catch (_) {}
  paint();
  pushBalanceToCalc();
}

/* ---------- drawing ---------- */

const nf = (v, d = 0) =>
  Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/* A Solana address is longer than an EVM one, so we cut more out of the
   middle: otherwise it does not fit into the button on a phone. */
const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';

const row = (k, v) => '<div class="wl-row"><span>' + k + '</span>' +
  (v.startsWith('<') ? v : '<b>' + v + '</b>') + '</div>';

const buyUrl = () => (window.ApexChain ? window.ApexChain.buyLink() : '');

function paint() {
  const btn = $('.wl .connect');
  if (!btn) return;
  btn.innerHTML = S.account
    ? '<i aria-hidden="true"></i>' + short(S.account)
    : '<i aria-hidden="true"></i>CONNECT WALLET';
}

function paintPop(pop) {
  const rows = [];

  if (!S.account) {
    const list = available();
    if (!list.length) {
      rows.push('<div class="wl-err">No Solana wallet found. Install Phantom, ' +
        'Solflare or another Solana wallet, then reload the page.</div>');
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
    rows.push(row('network', '<b class="ok">Solana</b>'));
    rows.push(row('SOL', S.sol === null ? '—' : nf(S.sol, 4)));

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
          '" target="_blank" rel="noopener">Buy on pump.fun</a>');
      }
    }
    /* The threshold is not plucked out of the air: at the current queue price
       one signature costs about 0.00002 SOL, and five thousandths are enough
       for hundreds of trades. Below that a person runs into "not enough SOL"
       on the very first one. */
    if (S.sol !== null && S.sol < 0.005) {
      rows.push('<div class="wl-err">Almost out of SOL. Every transaction on Solana ' +
        'needs a little, and a swap needs a little more.</div>');
    }
    rows.push('<button type="button" class="wl-act ghost" data-act="disconnect">Disconnect</button>');
  }

  pop.innerHTML = rows.join('');
}

/**
 * Substitute the real balance into the calculator.
 *
 * The slider stays: a visitor without a wallet has to see how this works. But
 * if a wallet is connected, it is more honest to show their own position than
 * an invented 19,650,000.
 */
function paintHolding() {
  const ann = $('.calc-in .calc-note');
  if (!ann) return;
  if (!S.account) { ann.textContent = 'drag, type or pick a preset'; return; }
  if (S.token === null) { ann.textContent = short(S.account); return; }
  ann.textContent = short(S.account) + ' · holds ' + nf(S.token);

  /* The MAX button appears only when there is something to put into it. An
     empty button that does nothing looks like it works and keeps quiet. */
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

function pushBalanceToCalc() {
  paintHolding();
  if (S.token !== null && S.token > 0 && typeof window.ApexCalc === 'function') {
    window.ApexCalc(S.token);
  }
}

/* ---------- wiring ---------- */

function wire() {
  const wl = $('.wl');
  if (!wl) return;
  const btn = $('.connect', wl);
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
    if (act.dataset.act === 'disconnect') { disconnect(); paintPop(pop); }
  });

  /* A click outside closes it. The event path is taken from composedPath
     rather than by asking `wl.contains(target)`: a handler inside the panel
     redraws its contents, the pressed button drops out of the tree in the
     process, and by the time of the check `contains` answers "no". The panel
     closed by itself right after a wallet was picked. */
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
    /* A quiet connect: the standard allows asking without a window, and if
       the permission has been revoked the wallet simply refuses. We keep
       quiet either way: this is a background attempt, not a person's
       action. */
    await connect(d);
    if (S.account) await afterConnect();
  } catch (_) {}
}

window.ApexWallet = {
  wire, restore, connect, disconnect, buyUrl,
  get state() { return { ...S }; },
};

})();
