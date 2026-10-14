/* =========================================================================
   The rules for writing settings.

   This was pulled out of the server into a file of its own for exactly one
   reason: so it can be checked without bringing up either the server or the
   database. As long as a check needs everything running, nobody runs it.
   ========================================================================= */

import './../core.js';

const C = globalThis.ApexCore;

/* An allowlist, not "whatever came in": otherwise the console will put any
   key at all into the database, and one day it will put in a typo instead of
   an address, silently, and that will be found out only when the site shows
   a dash while the console is full. */
export const WRITABLE = new Set(['token', 'vault', 'note', 'buy', 'operator']);

/* The operator address lives in the settings too.

   Under the scheme adopted on 29 August, the operator is Alexander's own
   wallet, and the ether sits on it in advance: a friend forwards the fee,
   and the wallet itself is topped up by hand. Earlier the fee landed on the
   same address and topped it up by itself; now the reserve will run out one
   day, and between "ran out" and "noticed" the epochs simply stop closing,
   silently.

   That is why the server needs the address: it reads the balance and shows
   it on the console. There is no key here and there cannot be: only an
   address, only reading.

   The buy link lives in the settings, not in the code.

   The address of a token page on Pons cannot be guessed: their storefront is
   a single page application, the cards are opened by script, and `/token/0x…`
   serves the same home page. I checked that in a browser rather than
   assuming it.

   Hardcoding a guessed path means putting a "buy" button on the storefront
   that leads nowhere with some probability. On the previous project a button
   like that sent a buyer to a 404, and that is the worst possible first
   step.

   So: after the launch you open your own coin on Pons, copy the address out
   of the browser bar and paste it into the console. While the field is empty
   there is no button at all: the same off switch as with the token
   address. */
const BUY_RE = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i;

/**
 * Checks the body of a settings write request.
 * Returns either { ok: true, clean } or { ok: false, error } with the reason
 * in human words: there must be no silent refusals.
 */
export function validateConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'an object with fields was expected' };
  }
  const entries = Object.entries(body);
  if (!entries.length) return { ok: false, error: 'nothing to change' };

  const clean = {};
  for (const [k, v] of entries) {
    if (!WRITABLE.has(k)) return { ok: false, error: 'the key "' + k + '" cannot be written' };
    if (v !== null && v !== undefined && typeof v !== 'string') {
      return { ok: false, error: 'the field "' + k + '" has to be a string' };
    }
    const val = (v ?? '').trim();

    /* A private key never gets into the settings.

       The question "let us type the key in the console too, so everything is
       in one place" is asked first thing, and it sounds reasonable. But the
       console writes into the database, and the database stands next to the
       server that faces outward. A private key there is money one leak away
       from somebody else's hands, and no amount of correctness in the rest
       of the code changes that.

       The key lives only in a variable of the crank service: that one has
       not a single port open to the outside.

       ON SOLANA A KEY LOOKS DIFFERENT, AND THE OLD CHECK DID NOT CATCH IT.
       It used to be: sixty four hexadecimal characters, with `0x` or
       without. That is an EVM key. A Solana key is sixty four bytes, and it
       travels in messages in three shapes:

         base58, 87 or 88 characters         the most common, wallets give it
         an array of 64 numbers in brackets  this is how id.json holds it
         128 hexadecimal characters          rarer, but it happens

       We catch all three, and we keep the old EVM shape: somebody may paste
       a key from the old chain in here, and they have to be told as well.

       WHAT THIS CHECK DOES NOT CATCH, AND THIS HAS TO BE KNOWN. Sometimes a
       key is handed over as the thirty two bytes of a seed, also base58. By
       its look that is EXACTLY THE SAME THING as a public address: the same
       alphabet, the same length. They cannot be told apart by shape, and no
       regular expression will help here.

       What actually protects us: we sign nothing with anything out of the
       database. The token, vault and operator fields are addresses, they are
       only read from. Signing lives in APEX_WALLET_KEY on the crank service,
       and that one has not a single port open to the outside. Which means a
       seed typed into the console by mistake will lie there as an address
       and will give nobody anything beyond the bare fact that it has been
       exposed. That is why the refusal is loud everywhere the shape can be
       seen. */
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(val)
        || /^[0-9a-fA-F]{128}$/.test(val)
        || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(val)
        || /^\s*\[\s*\d{1,3}\s*(,\s*\d{1,3}\s*){31,}\]\s*$/.test(val)) {
      return { ok: false, error:
        'this looks like a PRIVATE KEY, not an address. It never goes into '
        + 'the settings: the database stands next to the server that faces outward. '
        + 'The key is set by the APEX_WALLET_KEY variable on the crank service. '
        + 'If you have just pasted a real key in here, treat it as '
        + 'compromised and start a new wallet.' };
    }

    /* The address is checked here and not only in the browser: the browser
       can be bypassed, and a typo in the vault address costs the launch. An
       empty string is allowed on purpose: it is the off switch, erase the
       address and the calculation goes dark while the site lives on. */
    if ((k === 'token' || k === 'vault' || k === 'operator') && val !== '' && !C.isAddress(val)) {
      return { ok: false, error: 'the "' + k + '" address has to be base58 between 32 and 44 characters long, right now it is ' + val.length };
    }
    if (k === 'note' && val.length > 500) {
      return { ok: false, error: 'the note is longer than five hundred characters' };
    }
    /* Only https and only something that looks like an address. The button
       leads outward from our storefront: javascript: and data: must never
       get in here. */
    if (k === 'buy' && val !== '' && !BUY_RE.test(val)) {
      return { ok: false, error: 'the buy link has to start with https:// and look like a page address' };
    }
    if (k === 'buy' && val.length > 300) {
      return { ok: false, error: 'the link is longer than three hundred characters' };
    }
    clean[k] = val;
  }
  return { ok: true, clean };
}


/* =========================================================================
   Who counts as "one and the same" when attempts are counted.

   Counting by the exact address turned out to be too fine grained: a
   measurement showed that the same client arrives now from 2.26.13.2, now
   from 2.26.13.4, because there is a pool of addresses at the exit. It ends
   up with twice as many attempts as it should have, and the counter quietly
   stops being a counter. Behind a mobile operator the address wanders in
   exactly the same way.

   So the key is the subnet: /24 for IPv4, /64 for IPv6. That is precisely
   the trade off needed here: one's own pool of addresses collapses into a
   single counter, while a neighbouring provider stays separate.
   ========================================================================= */
export function clientBucket(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '?';
  /* ::ffff:1.2.3.4 is an ordinary IPv4 wrapped into IPv6. */
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = mapped ? mapped[1] : raw;

  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return v4[1] + '.' + v4[2] + '.' + v4[3] + '.0/24';

  if (addr.includes(':')) {
    /* The first four groups are the /64, the usual size of what is handed to
       a single subscriber. We do not expand the shortened form: for a key it
       is enough that identical addresses give identical keys. */
    const head = addr.split(':').slice(0, 4).join(':');
    return head + '::/64';
  }
  return addr;
}


/**
 * Let them in or not, as a pure decision, with no network and no database.
 *
 * This was pulled out on its own for exactly one reason: so that a check
 * covers it. This is a trust boundary, and it has already broken once
 * silently. While the decision was woven into the handler, the only way to
 * check it was with a live request, which is to say no way at all.
 */
export function iconVerdict(raw, { hosts, published } = {}) {
  if (!raw) return { ok: false, code: 400, why: 'the u parameter is needed' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, code: 400, why: 'a broken address' }; }
  if (u.protocol !== 'https:') return { ok: false, code: 400, why: 'https only' };
  if (hosts && hosts.has(u.hostname)) return { ok: true, via: 'host' };
  if (published && published.has(raw)) return { ok: true, via: 'basket' };
  return { ok: false, code: 403, why: 'we did not publish this picture' };
}


/**
 * What kind of picture this is, by the first bytes and not by the header.
 *
 * Returns the type, or null if this is not a picture. Null means a refusal:
 * a proxy that serves something which is not a picture will one day serve
 * somebody's script from our own domain.
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  const is = (...bytes) => bytes.every((v, i) => b[i] === v);

  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (is(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (is(0x42, 0x4d)) return 'image/bmp';
  if (is(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  /* RIFF….WEBP */
  if (is(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45
      && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';

  /* SVG is text, and it is recognised by its beginning. We look in the first
     two hundred bytes: before the tag there may be an xml declaration, a
     comment or whitespace. */
  const head = b.subarray(0, 200).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))
      || (head.startsWith('<!doctype svg'))) return 'image/svg+xml';

  return null;
}


/* =========================================================================
   THE VALUE OF AN HTTP HEADER

   Headers are Latin-1. To a Russian letter in a value Node answers "Invalid
   character in header content" and brings down the WHOLE response, not the
   header: the request serves a five hundred.

   Caught by my own mistake: I put the values for "cache" and "origin" into
   the diagnostic header `x-apex-icon` in Russian, the way all the rest of
   the text of the project is, and all ten icons started serving five
   hundreds. Which is to say that fixing a breakage became a new breakage.

   All the text of the project is in Russian, and habit puts it everywhere.
   That is why the rule is pulled out into a function and covered by a check
   rather than resting on being careful.
   ========================================================================= */
export function headerSafe(v) {
  const s = String(v ?? '');
  /* The printable Latin-1 characters without the control ones. The line feed
     and the carriage return especially: they are used to cut a response into
     two, and that is somebody else's injection. */
  return /^[\x20-\x7e\xa0-\xff]*$/.test(s);
}
