/* =========================================================================
   The server. Bare http, no framework: there are six routes, and express
   would add forty dependencies to them for the sake of parsing a path.

   What it serves:
     GET  /api/state            the last good read of the chain and the settings
     GET  /api/epochs           the register of payouts out of the database
     GET  /api/probe?token=…    a read of an arbitrary address, saving nothing
     GET  /api/icon?u=…         a relay for a token icon, for CORS, see below
     GET  /api/health           the state of the collector and the database
     POST /api/auth             a key check, the console asks it on the way in
     POST /api/config           writing settings, needs the key
     GET  /                     a short note, so that the address does not stay silent

   The write key lives in an environment variable on Railway and nowhere
   else: not in the repository, not in a document. A document ends up in a
   commit one day.

   still accepted for now. The rename is done in two steps on purpose: take
   the old name away at the same time as the code change, and between the
   server rollout and the variable being fixed the console stops letting
   anybody in. That is exactly how it once went with the request header.

   And separately, because confusion here costs money: this is NOT the key
   the crank has. Here is the password for writing in the console, it cannot
   spend a penny. The crank has the private key of the wallet in
   `APEX_WALLET_KEY`, which is the money itself. Two different secrets, and
   they must not be confused.
   ========================================================================= */

import http from 'node:http';
import './../core.js';
import { migrate, q, settings, setSetting, pool } from './db.js';
import { startCollector, health, jobs } from './collect.js';
import { validateConfig, clientBucket } from './rules.js';

const C = globalThis.ApexCore;
const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.APEX_CONSOLE_KEY || '';

/* ---------- responses ---------- */

function send(res, code, body, extra) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    /* The site lives on Vercel and comes here through a rewrite of /api/*,
       that is, from the same domain, and CORS is not needed. The header is
       there anyway: while the domain is not attached, the console is opened
       straight at the Railway address, and without it the console would
       silently not work. */
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-apex-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...(extra || {}),
  });
  res.end(text);
}

const bad = (res, code, why) => send(res, code, { ok: false, error: why });

/* =========================================================================
   Limiting the attempts.

   The key is checked by a route of its own, and that opens the door to
   guessing: before, you could only get it wrong on a write, now you can do
   it as many times in a row as you like. We count the failures per address
   and after ten we close the door for fifteen minutes.

   The counter is in memory, not in the database: a restart resets it, and
   that is a deliberate trade off. A database for the sake of an attempt
   counter is an extra trip on every login, and the single service restarts
   rarely as it is.
   ========================================================================= */
const TRIES = new Map();
const MAX_TRIES = 10;
const LOCK_MS = 15 * 60_000;

function keyFrom(req) {
  /* One header name, and it is `x-apex-key`.

     There used to be three: the project was renamed twice, and the key lives
     in the browser's localStorage and survives a rename, so the old names
     were kept for the sake of anyone with an old tab open.

     Checked on 29 August: both `chain.js` and the console send only the new
     name, there is not a single old sender left. A header nobody sends is
     not compatibility but one more door on the allowed list. */
  return req.headers['x-apex-key'] || '';
}

function whoFrom(req) {
  /* Railway puts the real address into x-forwarded-for; socket.remoteAddress
     here is always the address of their proxy, that is, one for everybody.
     After that the address is folded down to a subnet, why is written in
     rules.js. */
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '?').trim();
  return clientBucket(ip);
}

/** How many seconds to wait if the door is closed. Zero means you may try. */
function lockedFor(who) {
  const rec = TRIES.get(who);
  if (!rec || rec.until < Date.now()) return 0;
  return Math.ceil((rec.until - Date.now()) / 1000);
}

function noteFailure(who) {
  const rec = TRIES.get(who) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_TRIES) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
  TRIES.set(who, rec);
  return rec;
}

const forgive = who => TRIES.delete(who);

/**
 * The key check. It answers only "yes" or "no": not a hint about the length,
 * nor about how close you were. And it counts the failures.
 */
function checkKey(req, res, given) {
  if (!KEY) { bad(res, 503, 'no key is set on the server'); return false; }
  const who = whoFrom(req);
  const wait = lockedFor(who);
  if (wait) {
    bad(res, 429, 'too many attempts. Wait ' +
      (wait > 60 ? Math.ceil(wait / 60) + ' min' : wait + ' s'));
    return false;
  }
  if (!given || given !== KEY) {
    const rec = noteFailure(who);
    const left = MAX_TRIES - rec.n;
    bad(res, 403, 'the key did not fit' + (rec.until ? '. The attempts are over, the door is closed for 15 minutes'
      : '. Attempts left: ' + left));
    return false;
  }
  forgive(who);
  return true;
}

/* ---------- reading the body ---------- */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    /* A ceiling just in case: the body here is three short fields. */
    if (size > 64 * 1024) throw new Error('the request body is too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ---------- routes ---------- */

/**
 * Everything the page needs in a single request. It serves the last
 * successful read together with its age: deciding whether that is fresh or
 * not is the page's job, it knows what it is showing. The server does not
 * pretend the data is always good.
 */
async function state() {
  const s = await settings();

  const basketRow = (await q('select * from basket order by at desc limit 1')).rows[0];
  const selfRow = s.token
    ? (await q('select * from market where token = $1 order by at desc limit 1', [s.token])).rows[0]
    : null;
  const holdRow = s.token
    ? (await q('select * from holders where token = $1 order by at desc limit 1', [s.token])).rows[0]
    : null;
  const epochCount = Number((await q('select count(*)::int as n from epochs')).rows[0].n);

  const age = row => (row ? Date.now() - new Date(row.at).getTime() : null);

  return {
    ok: true,
    now: Date.now(),
    model: C.MODEL,
    chain: { id: C.CHAIN.id, key: C.CHAIN.key, explorer: C.CHAIN.explorer },
    config: {
      token: s.token || '',
      vault: s.vault || '',
      note: s.note || '',
      buy: s.buy || '',
      operator: s.operator || '',
    },
    basket: basketRow ? {
      rows: basketRow.rows,
      source: basketRow.source,
      scanned: basketRow.scanned,
      priced: basketRow.priced,
      at: new Date(basketRow.at).getTime(),
      age: age(basketRow),
    } : null,
    self: selfRow ? {
      token: selfRow.token,
      price: selfRow.price,
      marketCap: selfRow.market_cap,
      liq: selfRow.liq,
      vol24: selfRow.vol24,
      pools: selfRow.pools,
      pairId: selfRow.pair_id || null,
      holders: holdRow ? holdRow.count : null,
      at: new Date(selfRow.at).getTime(),
      age: age(selfRow),
    } : null,
    epochs: epochCount,
    /* The balance on the working wallet. It lives in the collector's memory
       and not in the database: this is not history but "how much right now",
       and after a restart it is read again by itself within a minute. Until
       it has been read it is null, and the dashboard will say "not read"
       rather than "zero". */
    gas: {
      address: s.operator || '',
      eth: health.gas.eth,
      epochs: health.gas.epochs ?? null,
      at: health.gas.at,
      ok: health.gas.ok,
      why: health.gas.why,
    },
  };
}

async function epochs(limit) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const r = await q(
    'select hash, at, block, symbol, token, amount from epochs order by at desc limit $1', [n]);
  return { ok: true, rows: r.rows };
}

/**
 * A check of somebody else's address, or of one not saved yet. It writes
 * nothing into the database: this is how the console tries an address on
 * before it becomes everybody's.
 */
async function probe(token) {
  if (!C.isAddress(token)) return { ok: false, error: 'an address of 42 characters is needed' };
  const [m, h] = await Promise.all([
    C.marketOf(token).catch(e => ({ error: e.message })),
    C.holdersOf(token),
  ]);
  return { ok: true, token, market: m, holders: h, pot: C.epochPot(m && m.vol24) };
}

async function config(req, res) {
  /* An ordinary comparison, not a constant time one: the key is long and
     random, and guessing it by response time over the internet is unreal
     here. If the key ever becomes short, rewrite this to timingSafeEqual. */
  if (!checkKey(req, res, keyFrom(req))) return;

  const v = validateConfig(await readBody(req));
  if (!v.ok) return bad(res, 400, v.error);

  const changed = [];
  for (const [k, val] of Object.entries(v.clean)) {
    await setSetting(k, val);
    changed.push(k);
  }

  /* We reread the chain under the new address straight away: otherwise after
     the token is typed in the site would show dashes for up to a minute, and
     a person would decide it had not worked. Waiting is not required, the
     errors will go into health. */
  jobs.collectSelf();
  jobs.collectHolders();
  jobs.collectVault();
  /* And the gas balance too: otherwise after the operator is typed in the
     dashboard would say "not read yet" for up to five minutes, which is
     exactly what the person has only just tried to find out. */
  jobs.collectGas();

  return send(res, 200, { ok: true, changed, config: (await state()).config });
}

/* =========================================================================
   Token icons.

   WHAT FOR. The icons live on cdn.dexscreener.com, and on the first screen
   they have to land as textures on the 3D cans. Checked with a request: the
   CDN serves the picture with code 200 but WITHOUT an
   access-control-allow-origin header. For an <img> on the page that does not
   matter, but a canvas a picture like that was drawn onto becomes "tainted",
   and WebGL refuses to take a texture from it. Hence the relay through
   ourselves: our own response goes with CORS.

   WHAT IS GUARDED HERE. An open relay to any address at all is a hole:
   through it the outside world walks around Railway's internal network. So
   there is a list of allowed hosts, and it is small.
   ========================================================================= */

/* The list is closed and short. Icons in the basket come from two venues:
   DexScreener keeps its own, and for some tokens it substitutes a picture
   from CoinGecko, which is how DOGO arrived, and on a closed list of one
   host it silently ended up with no icon. Opening the relay to "anywhere at
   all" for the sake of that is not allowed: it is a hole into Railway's
   internal network. */
const ICON_HOSTS = new Set([
  'cdn.dexscreener.com',
  'dd.dexscreener.com',
  'assets.coingecko.com',
  'coin-images.coingecko.com',
]);
const ICON_TTL = 60 * 60 * 24;          // a day: token icons do not change

async function icon(res, raw) {
  if (!raw) return bad(res, 400, 'the u parameter is needed');

  let u;
  try { u = new URL(raw); } catch { return bad(res, 400, 'a broken address'); }
  if (u.protocol !== 'https:') return bad(res, 400, 'https only');
  if (!ICON_HOSTS.has(u.hostname)) return bad(res, 403, 'the host is not allowed: ' + u.hostname);

  /* A timeout of our own: without it a hung CDN would hold our connection to
     the very end, and Railway counts requests like that as alive. */
  const stop = AbortSignal.timeout(8000);
  const r = await fetch(u, { signal: stop, headers: { accept: 'image/*' } });
  if (!r.ok) return bad(res, 502, 'the CDN answered ' + r.status);

  const type = r.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return bad(res, 502, 'this is not a picture: ' + type);

  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, {
    'content-type': type,
    'content-length': buf.length,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=' + ICON_TTL + ', immutable',
  });
  res.end(buf);
}

/* ---------- parsing the request ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    if (path === '/api/state' && req.method === 'GET') return send(res, 200, await state());
    if (path === '/api/epochs' && req.method === 'GET') return send(res, 200, await epochs(url.searchParams.get('limit')));
    if (path === '/api/probe' && req.method === 'GET') return send(res, 200, await probe(url.searchParams.get('token')));
    if (path === '/api/icon' && req.method === 'GET') return await icon(res, url.searchParams.get('u'));
    if (path === '/api/config' && req.method === 'POST') return await config(req, res);

    if (path === '/api/auth' && req.method === 'POST') {
      /* The key arrives in a header, not in the body and least of all in the
         address: in the address bar it would settle into the proxy logs and
         into the browser history. */
      if (!checkKey(req, res, keyFrom(req))) return;
      return send(res, 200, { ok: true });
    }

    if (path === '/api/health' && req.method === 'GET') {
      let db = 'ok';
      try { await q('select 1'); } catch (e) { db = e.message; }
      return send(res, db === 'ok' ? 200 : 503, {
        ok: db === 'ok',
        db,
        /* How the server sees whoever came in. The attempt counter counts by
           this value, and when "attempts left" behaves oddly this is the
           first thing to look at: there may be several exit addresses behind
           one person. */
        youAre: whoFrom(req),
        forwarded: req.headers['x-forwarded-for'] || null,
        uptimeSec: Math.round((Date.now() - health.startedAt) / 1000),
        collector: health,
        keySet: Boolean(KEY),
      });
    }

    if (path === '/') {
      /* A bare address must not stay silent: when somebody comes here by
         hand, and they will on launch day, they have to see straight away
         what this is and whether it is alive. */
      return send(res, 200, {
        ok: true,
        what: 'apex api',
        routes: ['/api/state', '/api/epochs', '/api/probe?token=0x…', '/api/icon?u=…', '/api/health', 'POST /api/auth', 'POST /api/config'],
      });
    }

    return bad(res, 404, 'no such route: ' + path);
  } catch (e) {
    console.error(req.method + ' ' + path + ' — ' + e.message);
    return bad(res, 500, e.message);
  }
});

/* ---------- the start ---------- */

async function main() {
  await migrate();
  startCollector();
  server.listen(PORT, () => console.log('listening on ' + PORT + '; the key is ' + (KEY ? 'set' : 'NOT SET')));
}

/* Close down carefully: Railway sends SIGTERM on every deploy, and broken
   connections to the database hang for minutes, eating the small pool away
   from the new version. */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

main().catch(e => { console.error('the start failed:', e); process.exit(1); });
