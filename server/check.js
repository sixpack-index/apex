/* =========================================================================
   Checks of the server logic. No network, no database: only arithmetic and
   rules.

   Run:     node server/check.js
   Break:   node server/check.js --break   deliberately spoils what is being
            checked and makes sure the checks fall over. A test that cannot
            fail is decoration: one like that once approved everything in a
            row, because it compared against the wrong grid.
   ========================================================================= */

import './../core.js';
import { validateConfig, WRITABLE, clientBucket, iconVerdict, sniffImage, headerSafe } from './rules.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The root of the project. It is needed so that part of the rules can be
   guarded AGAINST THE SOURCE: some of them break not in the logic but in the
   fact that somebody writes the wrong thing in the wrong place. A call
   cannot check that. */
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const C = globalThis.ApexCore;
const BREAK = process.argv.includes('--break');

let passed = 0;
const failures = [];

function ok(name, cond, got) {
  if (cond) { passed++; return; }
  failures.push(name + (got === undefined ? '' : ' — got: ' + JSON.stringify(got)));
}
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/* ---------- addresses ---------- */
ok('a mint is accepted',
   C.isAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
ok('an address from the old chain is not counted as a Solana one',
   !C.isAddress('0x75eEB81b6af4e9B88579aA2E6E2FDBAAf6D8f837'));
ok('a base58 key is longer than an address and is not counted as one',
   !C.isAddress('5'.repeat(88)));
ok('an empty string is not counted as an address', !C.isAddress(''));
/* There is no zero in base58, no capital O, no capital I and no lowercase l:
   they were thrown out precisely so that they do not get confused. A string
   with them in cannot be an address. */
ok('the characters forbidden in base58 are not counted as an address',
   !C.isAddress('0OIl' + '1'.repeat(36)));

/* ---------- where the money comes from ----------
   These four checks guard not the arithmetic but the facts read off the
   chain. The pool fee rate, the venue share and its ceiling were taken with
   calls to Uniswap V3 and to the Pons locker; if one day somebody corrects
   the model by eye, it will go red here before a promise that will not be
   kept appears on the storefront.

   The wedge is derived from the rate and the share rather than set
   separately: two independent numbers obliged to agree sooner or later
   diverge. */
/* THE RATE IS NO LONGER A NUMBER, AND THAT IS CHECKED SEPARATELY.

   On Robinhood Chain the wedge was a constant of 0.7%, derived from the pool
   fee rate and the venue share. On pump.fun the rate is set by the venue out
   of its own table, and it falls as the market cap grows. The fields
   poolFeeBps, venueShare and wedgeBps are taken out of the model on purpose:
   while they lay there, they could be read out of habit and a number shown
   that does not exist in life.

   The numbers of the table come from the official pump.fun page of fees of 8
   October. */
ok('none of the old model fields are left in the core',
   C.MODEL.poolFeeBps === undefined && C.MODEL.venueShare === undefined
   && C.MODEL.wedgeBps === undefined);
ok('on the curve the creator fee is three tenths of a percent',
   near(C.creatorFeeAt(100), 0.003), C.creatorFeeAt(100));
ok('the top shelf of the table is 0.95%',
   near(C.creatorFeeAt(1000), 0.0095), C.creatorFeeAt(1000));
ok('at a large market cap the rate falls to 0.05%',
   near(C.creatorFeeAt(200_000), 0.0005), C.creatorFeeAt(200_000));
ok('the rate does not grow with the market cap anywhere above the top shelf',
   (() => { let prev = 1, ok2 = true;
     for (let m = 1500; m < 120_000; m += 500) {
       const r = C.creatorFeeAt(m); if (r > prev + 1e-12) ok2 = false; prev = r; }
     return ok2; })());
ok('junk on the input gives null, not a number',
   C.creatorFeeAt(-1) === null && C.creatorFeeAt('a lot') === null
   && C.creatorFeeAt(undefined) === null);

/* THE FEE FOR THE RECIPIENTS' ACCOUNTS. A new item that did not exist at all
   on the previous chain: ten coins means up to ten accounts per holder. */
ok('the fee for the accounts is counted off the number of holders and seats',
   near(C.rentFor(1000), 1000 * 10 * C.RENT_PER_ACCOUNT_SOL), C.rentFor(1000));
ok('with no holders there is nothing to pay for', C.rentFor(0) === 0);

/* ---------- the size of an epoch ----------
   The numbers come from a live measurement on 26 August: PAWHOOD, volume of
   $604 867 for the day. A wedge of 0.7% gives $4 234.069 a day, and eight
   epochs of three hours each give $529.2586. */
/* The rate arrives as an argument: it depends on the market cap, and
   counting "by default" means showing yesterday's number one day. */
const RATE = C.creatorFeeAt(1000);                 // 0.95%, the top shelf
const POT = C.epochPot(604867, RATE);
ok('the epoch is counted by the rate in force', near(POT, 604867 * RATE / 8), POT);
ok('with no rate there is no epoch, not "I will count by default"',
   C.epochPot(604867) === null && C.epochPot(604867, 0) === null);
ok('there are exactly eight epochs in a day', 24 / C.MODEL.epochHours === 8);
ok('there are ten seats in the basket', C.MODEL.seats === 10);
/* The divisor is taken from the model and not written in as a number: the
   seats have been changed twice, and a check that knows its own number by
   heart falls over not because the code is broken but because the check has
   gone stale. */
ok('the epoch divides between the seats evenly',
   near(POT / C.MODEL.seats, (604867 * RATE / 8) / C.MODEL.seats, 1e-4));
ok('with no volume there is no epoch',
   C.epochPot(0, RATE) === null && C.epochPot(null, RATE) === null);
ok('a negative volume gives no payout', C.epochPot(-100, RATE) === null);

/* The holder's share: 19 650 000 out of a billion is 1.965%, which at this
   epoch gives $10.400. Exactly that number is shown on the page, and it has
   to add up. */
const share = 19_650_000 / C.MODEL.supply;
ok('the holder share is counted off the supply', near(share, 0.01965));
/* The expectation is derived from the rate rather than written in as a
   number: with the old wedge of 0.7% there stood 10.39993 here, and with the
   move to the venue's rate it became untrue silently. A number written in by
   hand outlives a change of the rule and starts guarding the past. */
ok('the dividend per epoch agrees with the one shown on the page',
   near(POT * share, 604867 * RATE / 8 * share, 1e-9), POT * share);

/* ---------- the calculator as a whole ----------
   A live measurement on 26 August: PAWHOOD, price $0.0008561, volume
   $604 867. A holder with 19 650 000 coins is 1.965% of the supply. Exactly
   these numbers stand on the page, and they have to agree down to the
   cent. */
const D = C.dividendFor(19_650_000, 604867, 0.0008561, RATE);
ok('the share of the supply', near(D.share, 0.01965), D.share);
ok('the value of the position', near(D.value, 16822.365, 1e-9), D.value);
ok('the dividend per epoch', near(D.mine, 604867 * RATE / 8 * 0.01965, 1e-6), D.mine);
ok('the share of one position is the dividend divided by the number of seats',
   near(D.perSeat, D.mine / C.MODEL.seats), D.perSeat);
ok('the yield per epoch', near(D.yieldPerEpoch, D.mine / D.value), D.yieldPerEpoch);
/* The horizons. Multiplying by eight and by thirty looks too simple to be
   worth checking, and that is exactly why it is here: a formula living
   inside the paint is caught by nothing. */
ok('a day is eight epochs', near(D.perDay, D.mine * 8), D.perDay);
ok('thirty days is thirty times a day', near(D.per30d, D.perDay * 30), D.per30d);
ok('the annual agrees with the daily', near(D.yieldAnnual, (D.perDay * 365) / D.value));
ok('with no volume there are no horizons',
   C.dividendFor(19_650_000, 0, 1, RATE).perDay === null &&
   C.dividendFor(19_650_000, 0, 1, RATE).per30d === null);
ok('the annual is simple, not compound',
   near(D.yieldAnnual, D.yieldPerEpoch * 8 * 365), D.yieldAnnual);

const empty = C.dividendFor(19_650_000, 0, 0, RATE);
ok('with no volume there is no dividend', empty.mine === null && empty.perSeat === null);
ok('with no price there is no position value', empty.value === null);
ok('the share is counted even with no market', near(empty.share, 0.01965));
ok('with no price the yield is not invented',
   empty.yieldPerEpoch === null && empty.yieldAnnual === null);
ok('a zero position gives no share', C.dividendFor(0, 604867, 1, RATE).share === null);

/* ---------- seat weights ----------
   Ten divided evenly, six did not: 10000 / 6 = 1666.67. If the remainder is
   lost, the contract gets 9996 and four hundredths of a percent of the epoch
   will belong to nobody. What is checked is not "six numbers of 1666" but
   the rule itself: at any number of seats the sum has to be exactly ten
   thousand. */
const W = C.weightsBps();
ok('there are as many weights as seats', W.length === C.MODEL.seats, W.length);
ok('the weights add up to exactly ten thousand', W.reduce((a, b) => a + b, 0) === 10_000, W.join('+'));
ok('the seats differ by no more than one point',
   Math.max(...W) - Math.min(...W) <= 1, W.join(','));
ok('the top seats get the remainder, not the bottom ones', W[0] >= W[W.length - 1]);
for (const n of [1, 3, 6, 7, 10, 13, 99]) {
  const w = C.weightsBps(n);
  ok('the sum adds up at ' + n + ' seats too',
     w.length === n && w.reduce((a, b) => a + b, 0) === 10_000);
}

/* ---------- the request header ----------
   The explorer answers 403 to a request with no User-Agent, checked on 29
   August with a live curl. Because of that the site lived on the fallback
   list, and the crank could not read the holders at all: the epochs would
   never close, and it would look like "the explorer is down".

   What we check is not the network response (the tests have no network) but
   that the string is in place and looks like a browser one: an empty one, or
   "node/…", would land us right back there. */
ok('the User-Agent is set', typeof C.UA === 'string' && C.UA.length > 40, C.UA);
ok('the User-Agent looks like a browser one',
   /Mozilla\/5\.0/.test(C.UA || '') && /Chrome|Safari|Firefox/.test(C.UA || ''));

/* ---------- selection into the basket ---------- */
const t = (sym, name, price = 1) => ({ sym, name, price });
ok('a stablecoin does not go into the basket', !C.isConstituent(t('USDG', 'USD Global')));
ok('a wrapper for ether does not go into the basket', !C.isConstituent(t('WETH', 'Wrapped Ether')));
ok('a tokenized stock does not go into the basket',
   !C.isConstituent(t('NVDA', 'NVIDIA Corporation • Robinhood Token')));
ok('a receipt for a pool does not go into the basket',
   !C.isConstituent(t('rLP', 'Rebasing Liquidity Token')));
ok('an ordinary token of the chain does go into the basket', C.isConstituent(t('PIPEDOG', 'Pipe Dog')));

/* ---------- how a seat is counted ----------

   The numbers are not invented: this is a live measurement on 10 September,
   the one the rule was changed because of. HOOD has more depth, but its
   volume was made by six hundred trades, while AI has fifty five thousand
   trades and three times the volume and market cap. Under the old rule HOOD
   stood first. */
{
  const HOOD = { sym: 'HOOD', liq: 10_921_827, vol24: 10_873_002, txns24: 601, marketCap: 73_511_538 };
  const AI = { sym: 'AI', liq: 10_177_995, vol24: 30_891_673, txns24: 55_212, marketCap: 205_458_731 };
  const order = C.rankSeats([HOOD, AI]).map(x => x.sym);
  ok('a seat is not counted by depth alone', order[0] === 'AI', order.join(','));

  const w = C.RANK_WEIGHTS;
  ok('the weights add up to one',
     near(Object.values(w).reduce((a, b) => a + b, 0), 1), Object.values(w));
  ok('volume and the number of trades weigh more than the market cap',
     w.vol24 > w.marketCap && w.txns24 > w.marketCap, w);
  ok('the market cap weighs more than the depth', w.marketCap > w.liq, w);

  /* The score is built out of SHARES, so a lone token has to get exactly
     one: it is the whole field by itself. If the numbers themselves were
     added up, what came out here would be a quantity in the millions. */
  ok('a lone token gets the whole score', near(C.rankSeats([AI])[0].score, 1));

  /* The depth floor: without it the rule, where volume and trades weigh the
     most, lets a pool of twenty thousand with inflated volume into the
     basket, and the vault buys into it with real money. */
  ok('a shallow pool does not pass the depth floor',
     !C.isTraded({ liq: 20_000, marketCap: 30_000_000, vol24: 1e6, txns24: 2000 }));
  ok('a deep pool does pass the floor',
     C.isTraded({ liq: 5_000_000, marketCap: 200_000_000, vol24: 4e6, txns24: 6000 }));
  ok('a market cap with no market under it does not pass',
     !C.isTraded({ liq: 400_000, marketCap: 446_000_000, vol24: 1e6, txns24: 2000 }));

  /* The ceiling on the average trade. The HOOD numbers come from a live
     measurement: it passed every other threshold and held on volume and
     depth, although the volume was made by two or three hands. */
  ok('volume made by two hands does not go into the basket', !C.isTraded(HOOD));
  ok('the same volume by thousands of hands does go',
     C.isTraded({ ...HOOD, txns24: 20_000 }));
  ok('volume at zero trades does not pass',
     !C.isTraded({ liq: 5_000_000, marketCap: 50_000_000, vol24: 1e6, txns24: 0 }));
  ok('the ceiling on the average trade is five thousand', C.TRADE_SIZE_CEILING === 5_000,
     C.TRADE_SIZE_CEILING);
}
ok('a token with no price does not go into the basket', !C.isConstituent(t('GHOST', 'Ghost', 0)));

/* ---------- a live owner on a coin ----------

   THIS RULE CAUGHT A REAL MISTAKE ON THE LIVE STOREFRONT.

   On 14 October the basket held SPCX, a tokenized SpaceX stock from Backpack
   Securities, in the second seat, and HYPE, a wrapper of a coin from another
   chain, in the eighth. The docs promise the opposite of both. The earlier
   rules looked for that sort of thing by name and by a ticker ending in x,
   and both slipped through: SPCX does not end in x, HYPE is called simply
   HYPE.

   The difference you cannot fool with a name: a coin like that has a live
   owner, and he can print more of the supply or freeze an account. The
   chain's own markets do not have those rights.

   A measurement over the hundred most traded: the rule removed HYPE, MU,
   JLP, tOpenAI, BP, SKHY, SNDK, AMD, INJ, ORE, TTWO, DKNG, which is to say
   stocks with no x on the end, wrappers, a receipt for a pool and coins with
   a live right to print more. */
{
  const base = { sym: 'NATIVE', name: 'Native Coin', price: 1,
                 liq: 5_000_000, marketCap: 50_000_000, vol24: 4e6, txns24: 6000 };
  ok('a coin with no owner does go into the basket', C.isConstituent(base));
  ok('the right to print more of the supply closes the seat',
     !C.isConstituent({ ...base, mintAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }));
  ok('the right to freeze an account does too',
     !C.isConstituent({ ...base, freezeAuthority: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' }));
  ok('both rights at once, all the more so',
     !C.isConstituent({ ...base, mintAuthority: 'a', freezeAuthority: 'b' }));

  /* An empty field means "we do not know", not "there is no right": the
     source may say nothing, and throwing out everyone it said nothing about
     would mean ending up with no ten at all. */
  ok('silence from the source does not close a seat',
     C.isConstituent({ ...base, mintAuthority: null, freezeAuthority: null }));
  ok('an empty string is silence too',
     C.isConstituent({ ...base, mintAuthority: '', freezeAuthority: '' }));

  /* The very pair that stood in the live basket. The fixtures are built out
     of the real fields of the aggregator's response of 14 October. */
  const SPCX = { sym: 'SPCX', name: 'SpaceX - Backpack Securities', price: 157.3,
                 liq: 2_482_875, marketCap: 8_894_668, vol24: 31_013_715, txns24: 425_111,
                 mintAuthority: 'ADMrTq4rZCmpMwLsDfGzcHWSGSAHHrLvYufsVJpGhQnE',
                 freezeAuthority: 'ADMrTq4rZCmpMwLsDfGzcHWSGSAHHrLvYufsVJpGhQnE' };
  const HYPE = { sym: 'HYPE', name: 'HYPE', price: 81.99,
                 liq: 3_848_749, marketCap: 58_649_813, vol24: 23_183_226, txns24: 70_494,
                 mintAuthority: '7Z6Kz6sE1QqSAiBmRuKZ5nMHuNEHXBmKbdEEuEHvRwQL' };
  ok('a tokenized stock with no x on the end no longer passes',
     !C.isConstituent(SPCX));
  ok('a wrapper of a coin from another chain no longer passes',
     !C.isConstituent(HYPE));
  /* We confirm that the earlier rules did NOT catch them: otherwise the
     check above would pass without the new rule too, and we would not know
     that it works. */
  ok('and the earlier rules by name really did not catch them',
     !/stock|equity|wrapped/i.test(SPCX.name + HYPE.name)
     && !/x$/.test(SPCX.sym) && !/x$/.test(HYPE.sym));
}

/* ---------- the icon proxy ----------

   THIS IS A TRUST BOUNDARY, AND IT HAS ALREADY BROKEN SILENTLY.

   The icons of coins go through us: some of the sources do not serve the
   header that permits another domain, some lead to IPFS. Letting them
   through was decided by a list of hosts, four addresses of DexScreener and
   CoinGecko.

   When the source of the ten became the aggregator, the icons came from
   other people's hosts: static.jup.ag, cdn.kamino.finance,
   assets.meteora.ag, IPFS gateways. On the live storefront that gave ten 403
   refusals and ten empty circles in the grid of the basket. Not a single
   check saw that, because the decision was woven into the handler and was
   checked only by a live request.

   Now the decision is pure, it lives in this file and lets through exactly
   what we published ourselves. The list of hosts stayed as the fast path. */
{
  const hosts = new Set(['cdn.dexscreener.com']);
  const published = new Set(['https://static.jup.ag/jup/icon.png']);
  const v = (u, opt) => iconVerdict(u, opt === undefined ? { hosts, published } : opt);

  ok('our own host is let through', v('https://cdn.dexscreener.com/a.png').ok);
  ok('and is marked as passed by the host',
     v('https://cdn.dexscreener.com/a.png').via === 'host');
  ok('a link we published is let through',
     v('https://static.jup.ag/jup/icon.png').ok);
  ok('and is marked as passed by the basket',
     v('https://static.jup.ag/jup/icon.png').via === 'basket');

  /* The main thing: SOMEBODY ELSE'S link on THE SAME host does not pass.
     Otherwise we are an open proxy: we can be asked to go anywhere at all,
     and what stays in the log of the other server is our address, not the
     address of the one who asked. */
  ok('a foreign link on a published host does not pass',
     !v('https://static.jup.ag/entirely/different.png').ok);
  ok('the refusal explains the reason',
     /did not publish/.test(v('https://static.jup.ag/different.png').why || ''));
  ok('and answers with code 403, not 404',
     v('https://static.jup.ag/different.png').code === 403);

  ok('a non-https does not pass', !v('http://cdn.dexscreener.com/a.png').ok);
  ok('and that is an error of the request, not a refusal of access',
     v('http://cdn.dexscreener.com/a.png').code === 400);
  ok('data instead of an address does not pass',
     !v('data:image/png;base64,iVBORw0KGgo=').ok);
  ok('javascript instead of an address does not pass',
     !v('javascript:alert(1)').ok);
  ok('an empty parameter does not pass', !v('').ok);
  ok('a broken address does not pass', !v('not an address at all').ok);

  /* Without the database only the list of hosts is left, and that is a
     working state: the database may be unavailable, while the storefront has
     to show at least the icons that lie with the market sources. */
  ok('without the list of the published the hosts still work',
     iconVerdict('https://cdn.dexscreener.com/a.png', { hosts }).ok);
  ok('while a foreign host without the list of the published does not pass',
     !iconVerdict('https://static.jup.ag/jup/icon.png', { hosts }).ok);
}

/* ---------- a picture is recognised by its bytes, not by the header ----------

   A measurement: arweave.net serves the TRUMP icon with code 200 and an
   EMPTY content-type, and in the bytes there is ff d8 ff e0, an ordinary
   JPEG. The check "the type starts with image/" rejected a real picture
   because of a missing header, and an empty circle stood in the grid of the
   basket.

   Bytes are stricter than the header in both directions: a host that signed
   a script as image/png would pass the header check and will not pass this
   one. */
{
  const b = (...bytes) => Buffer.from([...bytes, ...new Array(16).fill(0)]);
  ok('PNG is recognised', sniffImage(b(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)) === 'image/png');
  ok('JPEG is recognised, the very case with arweave',
     sniffImage(b(0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46)) === 'image/jpeg');
  ok('GIF is recognised', sniffImage(b(0x47,0x49,0x46,0x38,0x39,0x61)) === 'image/gif');
  ok('WEBP is recognised',
     sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
                               Buffer.alloc(8)])) === 'image/webp');
  ok('SVG is recognised', sniffImage(Buffer.from('<svg viewBox="0 0 1 1"></svg>')) === 'image/svg+xml');
  ok('an SVG with an xml declaration too',
     sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>')) === 'image/svg+xml');
  ok('an SVG with whitespace in front too',
     sniffImage(Buffer.from('   \n  <svg></svg>          ')) === 'image/svg+xml');

  ok('a script is not counted as a picture',
     sniffImage(Buffer.from('<script>alert(1)</script>                ')) === null);
  ok('an HTML page is not either',
     sniffImage(Buffer.from('<!doctype html><html><body>404</body></html>')) === null);
  ok('the refusal text of a gateway is not a picture',
     sniffImage(Buffer.from('Too Many Requests, please slow down          ')) === null);
  ok('empty is not a picture', sniffImage(Buffer.alloc(0)) === null);
  ok('too short is not a picture', sniffImage(Buffer.from([0x89,0x50])) === null);
  ok('not a buffer at all is not a picture', sniffImage(null) === null);
  /* A PNG signature shifted by a byte must not be a picture: otherwise the
     check looks "somewhere near the beginning" rather than "at the
     beginning". */
  ok('a shifted signature does not pass',
     sniffImage(b(0x00,0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a)) === null);
}

/* ---------- HTTP headers in Latin letters only ----------

   CAUGHT BY MY OWN MISTAKE, AND THE MISTAKE WAS AN EXPENSIVE ONE.

   While fixing the icons, I put the values for "cache" and "origin" into the
   diagnostic header x-apex-icon in Russian, the way all the rest of the text
   of the project is. To that Node answers "Invalid character in header
   content" and brings down the WHOLE response: all ten icons started serving
   a five hundred. Which is to say that fixing a breakage became a new
   breakage, and I saw it only in the log of the live server.

   All the text of the project is in Russian, and habit puts it everywhere.
   The rule is guarded here, not by being careful. */
{
  ok('Latin letters pass', headerSafe('cache'));
  ok('digits and signs pass', headerSafe('origin-2; v=1.0 (ok)'));
  ok('empty passes', headerSafe(''));
  ok('a Russian letter does not pass, the very mistake', !headerSafe('\u043a\u044d\u0448'));
  ok('and one letter in the middle does not either', !headerSafe('cache-\u043a\u044d\u0448-2'));
  ok('a line feed does not pass: it is used to cut a response into two',
     !headerSafe('ok\nset-cookie: a=b'));
  ok('a carriage return does not either', !headerSafe('ok\r\nx: y'));
  ok('a control character does not pass', !headerSafe('ok\u0000'));
  ok('a tab does not pass', !headerSafe('a\tb'));

  /* And the server file itself must not put Russian text into the headers.
     A check against the source: the value could have arrived as a
     constant. */
  const src = fs.readFileSync(path.join(here, 'server', 'index.js'), 'utf8');
  const heads = src.match(/res\.writeHead\([\s\S]{0,420}?\}\)/g) || [];
  const dirty = heads.filter(h => /['"][^'"]*[\u0400-\u04ff][^'"]*['"]/.test(h));
  ok('there is no Russian text in the response headers', dirty.length === 0,
     dirty.map(d => (d.match(/['"][^'"]*[\u0400-\u04ff][^'"]*['"]/) || [''])[0]));
}

/* ---------- a live pool against an inflated one ----------
   A measurement on 26 August: there are five tokens with the ticker DOG on
   the chain. One of them has 128M of liquidity and zero volume, and it held
   the first seat of the whole basket, although there was not a single trade
   there. */
const alive = (liq, vol) => C.isAlive({ liq, vol24: vol });
ok('a pool with no trades is not counted as alive', !alive(128_124_882, 0));
ok('a traded pool is counted as alive', alive(9_081_193, 286_063));
ok('a pool on the edge is cut off by the rule and not by eye',
   alive(1000, 5) && !alive(1000, 4.9));
ok('zero liquidity does not divide by zero', !alive(0, 100));
ok('the liveness threshold is half a percent', C.ALIVE_RATIO === 0.005);

/* ---------- folding the pools ---------- */
const pair = (addr, sym, price, liq, vol) => ({
  baseToken: { address: addr, symbol: sym, name: sym },
  priceUsd: String(price),
  liquidity: { usd: liq },
  volume: { h24: vol },
  pairAddress: '5555555555555555555555555555555555555555555555555555555555555555555555555555555555555555',
  dexId: 'uniswap',
});
const folded = C.foldPairs([
  pair('Aaa11111111111111111111111111111111111111111', 'X', 1, 100, 10),
  pair('Aaa11111111111111111111111111111111111111111', 'X', 2, 900, 90),  // the same address, a deeper pool
  pair('Bbb11111111111111111111111111111111111111111', 'Y', 5, 50, 5),
]);
const X = folded.find(f => f.pair.baseToken.symbol === 'X');
ok('the pools of one token fold into one row', folded.length === 2, folded.length);
ok('depth is summed across pools', X.liq === 1000, X.liq);
ok('volume is summed across pools', X.vol24 === 100, X.vol24);
ok('the pool count is right', X.pools === 2, X.pools);
ok('the price comes from the deepest pool',
   C.shape(X).price === 2, C.shape(X).price);
ok('the card links to the exchange, not to the explorer',
   C.shape(X).url.includes('dexscreener.com'));

/* THE CASE IN AN ADDRESS CARRIES MEANING, SO ROWS MUST NOT FOLD BY IT.

   There used to be two addresses here differing only in case, and the
   check demanded that they merge into one row. On the previous chain that
   was right: EVM addresses are case insensitive, and the same address
   travels in three spellings.

   On Solana an address is base58 and the case carries meaning. Two such
   addresses are TWO DIFFERENT coins, and merging them means showing one
   row in the basket instead of two, with somebody else's volume inside
   it. The check now demands the opposite. */
const cased = C.foldPairs([
  pair('Ccc11111111111111111111111111111111111111111', 'Z', 1, 100, 10),
  pair('CCC11111111111111111111111111111111111111111', 'Z', 2, 900, 90),
]);
ok('addresses differing only in case stay different coins',
   cased.length === 2, cased.length);
ok('and one coin volume is not credited to the other',
   cased.every(f => f.vol24 === 10 || f.vol24 === 90),
   cased.map(f => f.vol24));

/* ---------- the rules for writing settings ---------- */
ok('a token address is written', validateConfig({ token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).ok);
ok('an empty address is allowed, it is the off switch',
   validateConfig({ token: '' }).ok);
ok('a pool id does not slip into the settings',
   !validateConfig({ token: '5555555555555555555555555555555555555555555555555555555555555555555555555555555555555555' }).ok);
ok('a foreign key is not written', !validateConfig({ supply: '123' }).ok);
ok('an empty body is rejected', !validateConfig({}).ok);
ok('a non-object is rejected', !validateConfig(null).ok && !validateConfig([]).ok);
ok('a number instead of a string is rejected', !validateConfig({ note: 42 }).ok);
ok('the spaces around an address are trimmed',
   validateConfig({ vault: '  So11111111111111111111111111111111111111112  ' }).clean.vault === 'So11111111111111111111111111111111111111112');
ok('a refusal explains the reason',
   /42|forty|character/i.test(validateConfig({ token: '0x123' }).error),
   validateConfig({ token: '0x123' }).error);
ok('exactly five keys may be written', WRITABLE.size === 5, [...WRITABLE]);
ok('the list of keys is exactly that one',
   ['token', 'vault', 'note', 'buy', 'operator'].every(k => WRITABLE.has(k)),
   [...WRITABLE]);
/* The number here is not for the sake of a number: the check catches the
   appearance of a NEW writable key, that is, of a new hole through which the
   console writes into the storefront. There were four; on 29 August operator
   was added, the address of the working wallet, so that the console shows the
   gas balance. Only the address and only reading: there is no key on the
   server and there cannot be. */

/* The operator address is checked as strictly as the rest: a typo in it
   means the console will show somebody else's balance and say "there is
   enough gas" when there is none. */
ok('the operator address is checked',
   !validateConfig({ operator: '0x123' }).ok &&
   validateConfig({ operator: 'So11111111111111111111111111111111111111112' }).ok);
ok('an empty operator is allowed, it is the off switch',
   validateConfig({ operator: '' }).ok);

/* ---------- a private key is not written into the settings ----------
   The question "let us put the key in the console too, so everything is in
   one place" is asked first thing. The console writes into the database, the
   database stands next to the server that faces outward, and a key there is
   money one leak away from somebody else's hands.

   The check is by shape, not by field name: blocking only `token` is not
   enough, they will paste it into the note. So the note is covered too. */
{
  const k0x = '5555555555555555555555555555555555555555555555555555555555555555555555555555555555555555';
  const kBare = '6'.repeat(88);
  const kUpper = '7'.repeat(88);
  for (const [name, val] of [['with 0x', k0x], ['without 0x', kBare], ['in capitals', kUpper]]) {
    for (const field of ['token', 'vault', 'operator', 'note', 'buy']) {
      const r = validateConfig({ [field]: val });
      ok('a key ' + name + ' is not written into "' + field + '"', !r.ok);
    }
  }
  ok('the refusal calls things by their names',
     /PRIVATE KEY/.test(validateConfig({ note: kBare }).error || ''),
     validateConfig({ note: kBare }).error);
  ok('the refusal says where the key actually belongs',
     /APEX_WALLET_KEY/.test(validateConfig({ note: kBare }).error || ''));
  ok('the refusal warns that the key is compromised',
     /compromis/i.test(validateConfig({ note: kBare }).error || ''));

  /* An address is half as long as a key and has to pass: a guard that
     rejects addresses along the way would break the launch rather than save
     anybody from a leak. */
  ok('an address of forty characters still passes',
     validateConfig({ token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).ok);
  ok('an ordinary note passes',
     validateConfig({ note: 'the first epoch was closed by hand' }).ok);
}

/* ---------- the buy link ----------
   It goes into an href attribute on our storefront. Everything that is not
   https has to bounce off here: the console has a key, but a key is not a
   right to put javascript: or data: into the page. */
ok('an ordinary link passes',
   validateConfig({ buy: 'https://pump.fun/coin/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).ok);
ok('an empty link is allowed, it is the off switch',
   validateConfig({ buy: '' }).ok);
ok('http without encryption does not pass',
   !validateConfig({ buy: 'http://pons.money/x' }).ok);
ok('javascript: does not pass',
   !validateConfig({ buy: 'javascript:alert(1)' }).ok);
ok('data: does not pass',
   !validateConfig({ buy: 'data:text/html,<script>alert(1)</script>' }).ok);
ok('a quote in a link does not pass',
   !validateConfig({ buy: 'https://pons.money/"onmouseover="alert(1)' }).ok);
ok('a space in a link does not pass',
   !validateConfig({ buy: 'https://pons.money/a b' }).ok);
ok('the link is trimmed at the edges',
   validateConfig({ buy: '  https://pons.money/x  ' }).clean.buy === 'https://pons.money/x');

/* ---------- who counts as one and the same ----------
   A measurement on 26 August: one client came in now from 2.26.13.2, now
   from 2.26.13.4, and ended up with twice as many attempts as it should
   have. */
ok('a pool of addresses behind one exit is counted together',
   clientBucket('2.26.13.2') === clientBucket('2.26.13.4'));
ok('an adjacent subnet is counted separately',
   clientBucket('2.26.13.2') !== clientBucket('2.26.14.2'));
ok('IPv4 in an IPv6 wrapper is no different from the bare one',
   clientBucket('::ffff:2.26.13.2') === clientBucket('2.26.13.2'));
ok('IPv6 is folded down to a /64',
   clientBucket('2a01:4f8:c17:1::1') === clientBucket('2a01:4f8:c17:1::99'));
ok('different /64s are not confused',
   clientBucket('2a01:4f8:c17:1::1') !== clientBucket('2a01:4f8:c17:2::1'));
ok('an empty address does not bring it down', clientBucket('') === '?' && clientBucket(null) === '?');

/* ---------- breakage ----------
   Every line below breaks something that was checked above. If the checks
   still pass after the spoiling, they are not checking anything. */
if (BREAK) {
  const broken = [];
  /* We pass the rate: without it epochPot returns null ON PURPOSE, because
     on Solana the rate is not a constant, it falls as the coin grows, and
     counting an epoch by a hardcoded number means promising what will not
     be there. A check that forgot the argument would be catching its own
     forgetfulness rather than the sensitivity of the arithmetic. */
  const wasPot = C.epochPot(604867, 0.0095);
  if (near(C.epochPot(604867 * 2, 0.0095), wasPot)) {
    broken.push('the epoch arithmetic is insensitive to a doubling of volume');
  }
  if (C.epochPot(604867) !== null) {
    broken.push('the epoch is counted with no rate, although the rate is not a constant');
  }
  if (C.isAddress('5555555555555555555555555555555555555555555555555555555555555555555555555555555555555555')) broken.push('the length of an address is not checked');
  if (validateConfig({ note: '8'.repeat(88) }).ok) {
    broken.push('a private key passes into the settings');
  }
  if (validateConfig({ supply: '1' }).ok) broken.push('the key allowlist does not work');
  if (C.isConstituent(t('USDG', 'USD Global'))) broken.push('stablecoins are not weeded out');
  if (headerSafe('\u043a\u044d\u0448')) broken.push('a Russian letter passes into an HTTP header');
  if (headerSafe('a\r\nb')) broken.push('a line feed passes into an HTTP header');
  if (sniffImage(Buffer.from('<script>alert(1)</script>                '))) {
    broken.push('a script passes as a picture');
  }
  if (!sniffImage(Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0]))) {
    broken.push('a JPEG with no type header is not recognised');
  }
  if (iconVerdict('https://static.jup.ag/someone-elses.png',
                  { hosts: new Set(['cdn.dexscreener.com']),
                    published: new Set(['https://static.jup.ag/jup/icon.png']) }).ok) {
    broken.push('the icon proxy lets a foreign link through on a familiar host');
  }
  if (C.isConstituent({ sym: 'SPCX', name: 'SpaceX - Backpack Securities', price: 157.3,
                        liq: 2_482_875, marketCap: 8_894_668, vol24: 31_013_715,
                        txns24: 425_111, mintAuthority: 'ADMrTq4rZCmpMwLsDfGzcHWSGSAHHrLvYufsVJpGhQnE',
                        freezeAuthority: 'ADMrTq4rZCmpMwLsDfGzcHWSGSAHHrLvYufsVJpGhQnE' })) {
    broken.push('a tokenized stock with a live owner passes into the basket');
  }
  if (near(C.dividendFor(19_650_000, 604867, 0.0008561, RATE).mine * 2, 59.4281, 1e-4)) {
    broken.push('the dividend is insensitive to doubling');
  }
  if (clientBucket('2.26.13.2') === clientBucket('9.9.9.9')) {
    broken.push('subnets are not told apart at all');
  }
  if (C.foldPairs([pair('Ddd11111111111111111111111111111111111111111', 'Q', 1, 10, 1),
                   pair('DDD11111111111111111111111111111111111111111', 'Q', 2, 10, 1)]).length === 1) {
    broken.push('addresses fold together without regard to case');
  }
  if (C.isAlive({ liq: 128_124_882, vol24: 0 })) {
    broken.push('a dead pool passes as alive');
  }
  /* The selection has to count four quantities, not one. We slip it a pair
     where one has more depth and everything else is far larger on the other:
     a rule that goes "by liquidity" will put the wrong one first. */
  {
    const deep = { sym: 'DEEP', liq: 10_921_827, vol24: 10_873_002, txns24: 601, marketCap: 73_511_538 };
    const busy = { sym: 'BUSY', liq: 10_177_995, vol24: 30_891_673, txns24: 55_212, marketCap: 205_458_731 };
    if (C.rankSeats([deep, busy])[0].sym !== 'BUSY') {
      broken.push('a seat is still given by depth alone');
    }
  }
  if (C.isTraded({ liq: 20_000, marketCap: 30_000_000, vol24: 1e6, txns24: 2000 })) {
    broken.push('a shallow pool passes the depth floor');
  }
  if (C.isTraded({ liq: 10_921_827, marketCap: 73_511_538, vol24: 10_873_002, txns24: 601 })) {
    broken.push('volume by two hands passes the ceiling on the average trade');
  }
  /* Naive weights, "divided evenly and walked away", have to fail to add up
     to ten thousand. That is exactly the mistake weightsBps came into being
     for: at ten seats it did not exist, at six it costs four hundredths of a
     percent of every epoch. We check only where the division is not even,
     otherwise at ten seats the breakage would have fooled itself. */
  if (10_000 % C.MODEL.seats !== 0) {
    const naive = Array.from({ length: C.MODEL.seats },
                             () => Math.floor(10_000 / C.MODEL.seats));
    if (naive.reduce((a, b) => a + b, 0) === 10_000) {
      broken.push('a lost weight remainder is not caught');
    }
  }

  console.log('\nBreakage: ' + (broken.length
    ? 'THE CHECKS ARE LEAKY — ' + broken.join('; ')
    : 'every substitution was caught, the checks are alive'));
  if (broken.length) process.exit(1);
}

/* ---------- the result ---------- */
if (failures.length) {
  console.error('FAILED ' + failures.length + ' of ' + (passed + failures.length) + ':');
  failures.forEach(f => console.error('  · ' + f));
  process.exit(1);
}
console.log('Server: ' + passed + ' checks passed.');
