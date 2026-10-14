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
     GET  /                     a short note, so the address does not stay silent

   The write key lives in an environment variable on Railway and nowhere
   else: not in the repository, not in a document. A document ends up in a
   commit one day.

   The name of the variable is `APEX_CONSOLE_KEY`.

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
import { validateConfig, clientBucket, iconVerdict, sniffImage } from './rules.js';

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
  /* A record that has served its time starts afresh. Without this `until`
     stayed the old one forever, and the very next mistake answered "the door
     is closed for fifteen minutes", although the door was open and there had
     been nine attempts. */
  if (rec.until && rec.until < Date.now()) rec.until = 0;
  rec.n += 1;
  rec.seen = Date.now();
  if (rec.n >= MAX_TRIES) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
  TRIES.set(who, rec);
  sweepTries();
  return rec;
}

/* SWEEPING THE COUNTER. Every new subnet is a record in memory, and without
   a sweep a guessing run from a thousand addresses leaves a thousand records
   forever. Swept out are those who have served their time and have not shown
   up for a long while; once every hundred failures, so as not to run over
   the map on each one. */
let sweeps = 0;
function sweepTries() {
  if (++sweeps % 100) return;
  const old = Date.now() - LOCK_MS * 2;
  for (const [k, r] of TRIES) if ((r.until || r.seen || 0) < old) TRIES.delete(k);
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

/* A VISITOR'S MISTAKE ANSWERS WITH A FOUR HUNDRED, NOT A FIVE HUNDRED.

   There were two places here where a crooked request fell into the common
   catcher and left as a five hundred: a body over the ceiling, and a body
   that does not parse as JSON. A five hundred means "the server broke", and
   in the console it reads exactly like that, although what is broken is the
   input. Both cases are now marked and answer 400 and 413. */
class BadRequest extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    /* A ceiling just in case: the body here is three short fields. */
    if (size > 64 * 1024) throw new BadRequest(413, 'the request body is too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new BadRequest(400, 'the body did not parse as JSON');
  }
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
       it has been read it is null, and the console will say "not read"
       rather than "zero". */
    gas: {
      address: s.operator || '',
      /* It was eth, it became sol: on Solana the settlement is paid in it.
         Next to it are two new fields that did not exist on the previous
         chain: how much it costs, one off, to open the recipients' accounts,
         and whether the balance is enough for that. Without them "how long
         it will last" would be misleading, because the main cost here is a
         one off and not a per epoch one. */
      sol: health.gas.sol,
      epochs: health.gas.epochs ?? null,
      rentSol: health.gas.rentSol ?? null,
      rentOk: health.gas.rentOk ?? null,
      at: health.gas.at,
      ok: health.gas.ok,
      why: health.gas.why,
    },
  };
}

async function epochs(limit) {
  /* Rounding down is mandatory. `Number('1.5')` is 1.5, and Postgres falls
     over on a fractional LIMIT, so the request `?limit=1.5` served a five
     hundred with the text of the database error on the outside. Whole,
     negative and junk strings were handled by the rules below even before
     that. */
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 200);
  const r = await q(
    'select signature, at, slot, symbol, token, amount from epochs order by at desc limit $1', [n]);
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
  /* The rate is counted off the live market cap of the token: on pump.fun it
     goes in steps. No market cap, no rate, and no estimate of an epoch
     either. */
  const rate = m && Number.isFinite(m.mcapSol) ? C.creatorFeeAt(m.mcapSol) : null;
  return { ok: true, token, market: m, holders: h, rate,
           pot: C.epochPot(m && m.vol24, rate) };
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
     console would say "not read yet" for up to five minutes, which is
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
/* =========================================================================
   THE ICON PROXY: WHO IS ALLOWED, AND WHY A LIST OF HOSTS WAS NOT ENOUGH

   The icons of coins go through us rather than straight from the browser,
   for two reasons: some of the sources do not serve the header that permits
   another domain, and some lead to IPFS, which without a proxy takes
   seconds to open.

   IT USED TO BE: a list of four hosts, DexScreener and CoinGecko. It worked
   while the numbers and the icons came from DexScreener.

   WHAT BROKE. The source of the ten became the aggregator, and it serves the
   icons from whoever happens to have them: static.jup.ag,
   static.datapi.jup.ag, cdn.kamino.finance, assets.meteora.ag,
   githubusercontent, several IPFS gateways. I checked the live storefront:
   ten requests, ten 403 refusals, and ten empty circles instead of icons in
   the grid of the basket. The list of hosts cannot be written out again:
   tomorrow a coin will have an eleventh host.

   IT IS NOW: what is allowed is WHAT WE PUBLISHED OURSELVES. The server
   holds the basket in the database, and in every row there is a link to an
   icon. A request is let through if such a link is in the latest basket or
   in the market of our own token.

   That is strictly better than a list of hosts in both directions:

     it works with any source we chose ourselves;
     it closes the hole the list of hosts left open: we cannot be asked to go
     for an arbitrary picture on an allowed host, which means we cannot be
     used as cover.

   The list of hosts stayed as the fast path: the sources we read the market
   from go through it, and for their sake there is no need to go into the
   database. */
const ICON_HOSTS = new Set([
  'cdn.dexscreener.com',
  'dd.dexscreener.com',
  'assets.coingecko.com',
  'coin-images.coingecko.com',
]);
const ICON_TTL = 60 * 60 * 24;          // a day: token icons do not change

/* What we published ourselves. Read out of the database and held in memory
   for a minute: the basket is refreshed once a minute, and there are ten
   icon requests to one paint of the page. */
let ICON_OK = { set: new Set(), at: 0 };
const ICON_OK_TTL = 60_000;

async function iconPublished() {
  if (Date.now() - ICON_OK.at < ICON_OK_TTL) return ICON_OK.set;

  const set = new Set();
  try {
    const b = (await q('select rows from basket order by at desc limit 1')).rows[0];
    for (const r of (b && b.rows) || []) if (r && r.icon) set.add(String(r.icon));
  } catch (_) { /* without the database only the list of hosts is left */ }
  ICON_OK = { set, at: Date.now() };
  return set;
}

/* =========================================================================
   THREE REASONS AN ICON DID NOT ARRIVE, AND ALL THREE ARE MEASURED

   After the proxy began letting our own links through, six icons out of ten
   arrived. I checked every one of the rest by hand.

   1. IPFS GATEWAYS SERVE A 429. Three icons out of ten lie on IPFS, and the
      link goes through ipfs.io or nftstorage.link. A measurement over nine
      gateways with one and the same content:

        ipfs.io, dweb.link, w3s.link, nftstorage.link    429
        ipfs.filebase.io                                 200, 715 ms
        4everland.io                                     200, 1394 ms
        gateway.pinata.cloud                             200, 6944 ms
        cf-ipfs.com                                      does not answer at all
        flk-ipfs.xyz                                     a timeout

      The first four are one and the same operator, and their limit is
      shared. Which means it is not about us and not about how often: over
      those gateways we simply will not be given anything. We take the
      content by its own address through a gateway that answers.

   2. ARWEAVE DOES NOT SEND A TYPE. The response is 200, content-type is
      empty, and in the bytes there is ff d8 ff e0, which is a JPEG. The
      check "the type starts with image/" rejected a real picture because of
      a missing header.

      We look into the bytes, not into the header. That is stricter at the
      same time: a host that signed a script as image/png would pass the
      header check and will not pass the byte check.

   3. WE WENT FOR EVERY ICON EVERY TIME. Ten requests to one paint of the
      page, and not a single cache on our side: the cache-control header
      saves a repeat visit, but not a new visitor. Half of the 429 refusals
      were our own work.
   ========================================================================= */

/* The IPFS gateways in the order of the measurement. The first one to answer
   with a picture wins. */
const IPFS_GATES = [
  'https://ipfs.filebase.io/ipfs/',
  'https://4everland.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

/* A ceiling on the size. An icon of a megabyte and a half is already met
   with (arweave), one of thirty is not an icon. */
const ICON_MAX_BYTES = 4 * 1024 * 1024;

/* A cache on our side. There are ten icons, they live for days, which is why
   the cache is small and simple too: a map that throws out the oldest. */
const ICON_CACHE = new Map();
const ICON_CACHE_MAX = 64;
const ICON_CACHE_TTL = 6 * 60 * 60 * 1000;

function iconCached(key) {
  const hit = ICON_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ICON_CACHE_TTL) { ICON_CACHE.delete(key); return null; }
  return hit;
}

function iconStore(key, type, buf) {
  if (ICON_CACHE.size >= ICON_CACHE_MAX) {
    ICON_CACHE.delete(ICON_CACHE.keys().next().value);
  }
  ICON_CACHE.set(key, { type, buf, at: Date.now() });
}

/** The address of the same content through another IPFS gateway, or empty. */
function ipfsElsewhere(href, gate) {
  const m = String(href).match(/\/ipfs\/([A-Za-z0-9]+)/);
  if (m) return gate + m[1];
  /* The shape "<cid>.ipfs.<gateway>", which is how nftstorage serves it. */
  const sub = String(href).match(/^https:\/\/([a-z0-9]{40,})\.ipfs\.[^/]+/i);
  if (sub) return gate + sub[1];
  return '';
}

async function iconFetch(href) {
  /* A timeout of our own: without it a hung CDN would hold our connection to
     the very end, and Railway counts requests like that as alive. */
  let r;
  try {
    r = await fetch(href, { signal: AbortSignal.timeout(9000),
                            headers: { accept: 'image/*' } });
  } catch (e) {
    return { why: 'did not answer: ' + (e.name === 'TimeoutError' ? 'a timeout' : e.message) };
  }
  if (!r.ok) return { why: 'answered ' + r.status, status: r.status };

  /* We check the length before reading, if it was stated: there is no point
     reading thirty megabytes only to refuse afterwards. */
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > ICON_MAX_BYTES) {
    return { why: 'too large: ' + len + ' bytes' };
  }

  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > ICON_MAX_BYTES) {
    return { why: 'too large: ' + buf.length + ' bytes' };
  }

  const type = sniffImage(buf);
  if (!type) {
    const said = r.headers.get('content-type') || 'nothing';
    return { why: 'this is not a picture (the header said: ' + said + ')' };
  }
  return { type, buf };
}

async function icon(res, raw) {
  /* Either a host we read the market from anyway, or exactly the link we
     put into the basket ourselves. Everything else is a refusal: a proxy
     that goes for any picture at all will one day go for something that is
     not a picture.

     We go into the database only if the host did not let it through: one
     paint of the page brings ten icon requests. */
  let v = iconVerdict(raw, { hosts: ICON_HOSTS });
  if (!v.ok && v.code === 403) {
    v = iconVerdict(raw, { hosts: ICON_HOSTS, published: await iconPublished() });
  }
  if (!v.ok) return bad(res, v.code, v.why);

  const hit = iconCached(raw);
  if (hit) return iconSend(res, hit.type, hit.buf, 'cache');

  let got = await iconFetch(raw);

  /* An IPFS gateway refused on the rate or broke, so we take the same
     content through another one. Content in IPFS is addressed by its own
     hash, so through any gateway the very same thing arrives byte for
     byte. */
  if (got.why && (got.status === 429 || got.status >= 500 || !got.status)) {
    for (const gate of IPFS_GATES) {
      const alt = ipfsElsewhere(raw, gate);
      if (!alt || alt === raw) continue;
      const again = await iconFetch(alt);
      if (again.type) { got = again; break; }
    }
  }

  if (!got.type) return bad(res, 502, 'the source ' + got.why);

  iconStore(raw, got.type, got.buf);
  return iconSend(res, got.type, got.buf, 'origin');
}

/* THE VALUE OF A HEADER IN LATIN LETTERS ONLY, AND THIS IS NOT A QUIBBLE.
 *
 * The values for "cache" and "origin" stood here in Russian, the way all
 * the rest of the text of the project is. To that Node answers "Invalid
 * character in header content" and brings down the whole response: all ten
 * icons served a five hundred, which is to say that fixing a breakage
 * became a new breakage.
 *
 * HTTP headers are Latin-1, and the place for Russian text is in the body
 * of the response, not in a header. The check for this is in the suite:
 * headerSafe. */
function iconSend(res, type, buf, from) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': buf.length,
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=' + ICON_TTL + ', immutable',
    'x-apex-icon': from,
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
        routes: ['/api/state', '/api/epochs', '/api/probe?token=…', '/api/icon?u=…', '/api/health', 'POST /api/auth', 'POST /api/config'],
      });
    }

    return bad(res, 404, 'no such route: ' + path);
  } catch (e) {
    console.error(req.method + ' ' + path + ' — ' + (e && e.message));
    /* A visitor's mistake answers with its own code and its own text.
       Everything else is our own breakage, and one word goes to the
       outside: the text of a Postgres or fetch exception explains nothing
       to a visitor, while it does show how the database is built. The
       details are in the log above. */
    if (e instanceof BadRequest) return bad(res, e.code, e.message);
    return bad(res, 500, 'an internal error, look in the server log');
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
