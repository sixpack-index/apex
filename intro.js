/* =========================================================================
   THE SPLASH, THE REVEALS, THE HEADER

   An ordinary script rather than a module, and that is not a detail: the
   first-screen scene arrives from a foreign CDN through an importmap, and if
   the CDN does not answer, the module will not run at all. The splash would
   then stay on the screen forever, with the page underneath it, locked behind
   a scroll lock.

   Here is everything the page stops being a page without, and none of it
   depends on three.js: the splash itself, the entrance of the first screen,
   the reveal of the sections on scroll, the burger and the X link. Verified
   by cutting the CDN.
   ========================================================================= */
(function () {
  'use strict';

  /* --- timings, in milliseconds of wall clock --- */
  var PRELOAD_MS   = 2000;   // the bar from 0 to 100
  var DARK_MS      = 900;    // the sheet drives up
  var REVEAL_DELAY = 2400;   // the reveals start while the curtains are still moving
  window.APEX_HANDS_CUE = 2500;   // the hands fly in a little earlier: the scene reads this
  window.APEX_START = performance.now();

  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var doc = document.documentElement;

  /* ---------- the first-screen heading, letter by letter ---------- */
  var h1 = document.querySelector('.hero3d h1');
  if (h1) {
    var words = h1.textContent.trim().split(/\s+/);
    h1.textContent = '';
    var n = 0;
    words.forEach(function (w, wi) {
      var ws = document.createElement('span');
      ws.className = 'wd';
      for (var i = 0; i < w.length; i++) {
        var ls = document.createElement('span');
        ls.className = 'ltr';
        ls.textContent = w[i];
        ls.style.transitionDelay = (n * 45) + 'ms';
        ws.appendChild(ls);
        n++;
      }
      h1.appendChild(ws);
      if (wi < words.length - 1) h1.appendChild(document.createTextNode(' '));
    });
  }

  /* ---------- the X link ----------

     The project has no account yet: SOCIAL.x in app.js is empty. Putting in
     "#" and pretending the link works is not allowed, because a person will
     press it and end up nowhere. While there is no address, the button says
     so honestly with a hint and a short blink of the border; the address goes
     into SOCIAL.x, and wireSocial() in app.js picks it up from there. */
  var xlink = document.querySelector('.xpill');
  if (xlink && !xlink.classList.contains('soc')) {
    xlink.addEventListener('click', function (e) {
      e.preventDefault();
      xlink.setAttribute('title', 'link goes live at launch');
      xlink.classList.add('blink');
      setTimeout(function () {
        xlink.classList.remove('blink');
        xlink.setAttribute('title', 'X');
      }, 1400);
    });
  }

  /* ---------- the burger ---------- */
  var burger = document.querySelector('.burger3d');
  var drop = document.getElementById('drop3d');
  if (burger && drop) {
    burger.addEventListener('click', function () {
      var open = burger.getAttribute('aria-expanded') === 'true';
      burger.setAttribute('aria-expanded', String(!open));
      burger.setAttribute('aria-label', open ? 'Open navigation' : 'Close navigation');
      drop.classList.toggle('open', !open);
    });
    drop.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        burger.setAttribute('aria-expanded', 'false');
        drop.classList.remove('open');
      }
    });
  }

  /* ---------- the first-screen reveals ---------- */
  function on(sel) {
    var el = document.querySelector(sel);
    if (el) el.classList.add('on');
  }
  function revealHero() {
    setTimeout(function () { on('.nav-in'); }, REVEAL_DELAY);
    setTimeout(function () { if (h1) h1.classList.add('on'); }, REVEAL_DELAY + 120);
    setTimeout(function () { on('.desc3d'); }, REVEAL_DELAY + 220);
    setTimeout(function () { on('.eyebrow3d'); }, REVEAL_DELAY + 300);
    document.querySelectorAll('.stat3d.rv').forEach(function (el) {
      setTimeout(function () { el.classList.add('on'); },
        REVEAL_DELAY + 320 + (+el.dataset.i || 0) * 90);
    });
    setTimeout(function () { on('.acts3d'); }, REVEAL_DELAY + 420);
  }
  function revealAllNow() {
    document.querySelectorAll('.rv, .rv-hdr, .sr').forEach(function (el) { el.classList.add('on'); });
    if (h1) h1.classList.add('on');
  }

  /* ---------- the reveal of the sections on scroll ----------

     An observer rather than a scroll handler: a handler computes on every
     frame of scrolling across the whole page, an observer only when a section
     has actually come up. A threshold of 12% with an offset from the bottom:
     a section starts to appear when its top enters the screen, not when all
     of it is already in view. The class is removed for good: a section that
     flashes on every pass reads as a breakage rather than as a device. */
  function wireScrollReveals() {
    var items = [].slice.call(document.querySelectorAll('.sr'));
    if (!items.length) return;
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('on'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('on');
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el) { io.observe(el); });
  }

  /* ---------- the header travels with the page ----------

     It stays visible at all times. I did try hiding it on downward movement,
     which was how the overlap with the price tape was solved, but on this site
     the header is not decoration: it holds the sections people navigate by,
     and a vanishing navigation forces a scroll upwards to use it. The overlap
     is solved differently: the sections have a scroll margin, and the glass on
     tablets blurs whatever passes underneath.

     At the same time the header shows where a person is. An observer rather
     than a scroll handler: we compute only when a section actually crosses a
     band near the top edge, not on every frame.

     The band is narrow and shifted down from the header (-45% at the top,
     -50% at the bottom): highlighted is the section now in the middle of the
     screen, not the one whose edge happened to touch the top of the window. */
  var links = [].slice.call(document.querySelectorAll('.ne-nav a[href^="#"], .drop3d a[href^="#"]'));
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      (byId[id] = byId[id] || []).push(a);
    });
    var mark = function (id) {
      links.forEach(function (a) { a.classList.remove('here'); });
      (byId[id] || []).forEach(function (a) { a.classList.add('here'); });
    };
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) mark(en.target.id); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io2.observe(el);
    });
  }

  /* ---------- the field of dots under the ledger ----------

     The new-era wave, slowed down from two seconds to twenty: for them it was
     a scene, here it is a background under a table, and a background that
     catches the eye stops being a background.

     Frames are computed only while the section is on the screen. The ledger is
     at the bottom of the page, and a person may never reach it at all:
     computing the wave all that time means warming up somebody else's laptop
     for nothing. */
  (function () {
    var cv = document.getElementById('ledgerField');
    if (!cv || !cv.getContext || reduced) return;
    var host = cv.parentNode;
    var cx = cv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, visible = false, running = false;

    function size() {
      var r = host.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener('resize', size);

    var COLS = 64, ROWS = 20;
    function frame(ts) {
      if (!visible) { running = false; return; }
      var t = ts / 20000;
      cx.clearRect(0, 0, W, H);
      for (var j = 0; j < ROWS; j++) {
        var dep = j / (ROWS - 1);
        /* Depth to the power of 1.7 rather than linear: the far rows have a
           smaller step, and a flat grid reads as running off to the horizon. */
        var y0 = H * (0.30 + Math.pow(dep, 1.7) * 0.82);
        for (var i = 0; i < COLS; i++) {
          var u = i / (COLS - 1);
          var x = W * (0.5 + (u - 0.5) * (0.5 + dep * 1.2));
          var y = y0 + Math.sin((u * 3.1 + dep * 2.2) + t * 6.283) * H * 0.04 * (0.35 + dep);
          if (y < 0 || y > H) continue;
          var a = (0.12 + dep * 0.52) * (0.55 + 0.45 * Math.sin(u * 6.1 + t * 12.5));
          cx.fillStyle = 'rgba(163,177,129,' + a.toFixed(3) + ')';
          cx.fillRect(x, y, 1.2 + dep * 1.3, 1.2 + dep * 1.3);
        }
      }
      requestAnimationFrame(frame);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) {
        visible = en[0].isIntersecting;
        if (visible && !running) { running = true; size(); requestAnimationFrame(frame); }
      }, { rootMargin: '120px 0px' }).observe(host);
    } else {
      visible = true; running = true; requestAnimationFrame(frame);
    }
  })();

  /* ---------- the tunnel under the ten ----------

     The same warp as in the splash, slowed down fourfold and dimmed to a
     quarter of the brightness. A background that argues with the content stops
     being a background: the basket cards stay the main thing.

     Frames are computed only while the section is on the screen, as with the
     field. */
  (function () {
    var cv = document.getElementById('basketTunnel');
    if (!cv || !cv.getContext || reduced) return;
    var host = cv.parentNode, cx = cv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, visible = false, running = false, st = [];

    function size() {
      var r = host.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    /* Speeds four times lower than in the splash, the first seeding spread
       across the whole field: the section opens with a finished tunnel rather
       than with a clump in the middle. */
    function seed(i, spread) {
      st[i] = { a: Math.random() * Math.PI * 2,
                r: spread ? Math.random() * 1.1 : Math.random() * 0.1 + 0.02,
                v: 0.001 + Math.random() * 0.003 };
    }
    for (var i = 0; i < 260; i++) seed(i, true);
    size();
    window.addEventListener('resize', size);

    function frame() {
      if (!visible) { running = false; return; }
      /* The trail is faded with the colour of the page rather than with black:
         the section lives on a common green background, and a black fill would
         show through it as a patch. */
      cx.fillStyle = 'rgba(20,26,18,0.20)';
      cx.fillRect(0, 0, W, H);
      var cxp = W / 2, cyp = H / 2, R = Math.sqrt(W * W + H * H) * 0.5;
      for (var i = 0; i < st.length; i++) {
        var s = st[i], ca = Math.cos(s.a), sa = Math.sin(s.a);
        var r0 = s.r * R, r1 = (s.r + s.v * 5) * R, k = Math.min(s.r / 0.9, 1);
        /* Our neon, at full strength. The former opacity of 6 to 28 per cent
           was the reason the strokes could not be seen: the colour has nothing
           to do with it, the difference in lightness between #A3B181 and the
           page background is more than enough. Now it is 14 to 62, and the
           line at the edge is twice as thick as in the middle, as in the warp
           itself. */
        cx.strokeStyle = 'rgba(163,177,129,' + (0.14 + 0.48 * k).toFixed(3) + ')';
        cx.lineWidth = 0.9 + k * 0.9;
        cx.beginPath();
        cx.moveTo(cxp + ca * r0, cyp + sa * r0);
        cx.lineTo(cxp + ca * r1, cyp + sa * r1);
        cx.stroke();
        s.r += s.v * (0.35 + s.r * 2.4);
        if (s.r > 1.2) seed(i);
      }
      requestAnimationFrame(frame);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) {
        visible = en[0].isIntersecting;
        if (visible && !running) { running = true; size(); requestAnimationFrame(frame); }
      }, { rootMargin: '120px 0px' }).observe(host);
    } else {
      visible = true; running = true; requestAnimationFrame(frame);
    }
  })();

  /* ---------- the splash ---------- */
  var pl = document.getElementById('pl');

  if (reduced || !pl) {
    if (pl) pl.remove();
    revealAllNow();
    wireScrollReveals();
    return;
  }

  /* Scrolling is locked while the splash hangs there: the whole page lies
     underneath it, and scrolled blind it would meet a person with the middle
     of the ledger. */
  var prevOverflow = doc.style.overflow;
  doc.style.overflow = 'hidden';

  var fill = document.getElementById('pl-fill');
  var num = document.getElementById('pl-num');
  var sheet = document.getElementById('pl-sheet');
  var hold = document.getElementById('pl-hold');

  /* ---------- the warp: the same strokes that open the clip ----------

     Canvas 2D, not three.js: the splash has to appear before the scene and
     survive a CDN that did not answer, and there is nothing to draw here
     except line segments.

     Each stroke is one ray flying outwards from the middle. The acceleration
     `v * (0.35 + r * 2.4)` gives the same sense of a run-up as the perspective
     in the original: near the middle the strokes barely crawl, at the edge
     they tear away. The tail is computed forward along the same ray, so the
     length grows together with the speed by itself, with no separate variable.

     The frame is not cleared but flooded with transparent black: a trail
     remains, and forty segments look like two hundred. */
  var warp = (function () {
    var cv = document.getElementById('pl-warp');
    if (!cv || !cv.getContext) return { stop: function () {} };
    var cx = cv.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, N = 240, st = [], live = true;

    function size() {
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    /* `spread` fills the field at once. Without it the first seeding puts all
       240 strokes right at the middle, and for the first second a clump the
       size of a tenth of the screen hangs in the frame: the scattering begins
       only after the splash has already been looked at. Re-seeding in flight
       goes from the centre, as it should: `spread` is not passed there. */
    function seed(i, spread) {
      st[i] = { a: Math.random() * Math.PI * 2,
                r: spread ? Math.random() * 1.1 : Math.random() * 0.12 + 0.02,
                v: 0.004 + Math.random() * 0.012,
                w: Math.random() < 0.14 ? 1.6 : 0.8 };
    }
    for (var i = 0; i < N; i++) seed(i, true);
    size();
    window.addEventListener('resize', size);

    (function frame() {
      if (!live) return;
      cx.fillStyle = 'rgba(7,9,10,0.38)';
      cx.fillRect(0, 0, W, H);
      var cxp = W / 2, cyp = H / 2, R = Math.sqrt(W * W + H * H) * 0.5;
      for (var i = 0; i < N; i++) {
        var s = st[i], ca = Math.cos(s.a), sa = Math.sin(s.a);
        var r0 = s.r * R, r1 = (s.r + s.v * 5.5) * R;
        /* Closer to the edge a stroke is brighter and thicker: we have neither
           bloom nor depth, and the run-up has to be shown by the line itself. */
        var k = Math.min(s.r / 0.9, 1);
        cx.strokeStyle = 'rgba(' + Math.round(150 + 90 * k) + ',' +
          Math.round(170 + 60 * k) + ',' + Math.round(120 + 70 * k) + ',' +
          (0.25 + 0.7 * k) + ')';
        cx.lineWidth = s.w * (0.5 + k);
        cx.beginPath();
        cx.moveTo(cxp + ca * r0, cyp + sa * r0);
        cx.lineTo(cxp + ca * r1, cyp + sa * r1);
        cx.stroke();
        s.r += s.v * (0.35 + s.r * 2.4);
        if (s.r > 1.15) seed(i);
      }
      requestAnimationFrame(frame);
    })();

    return { stop: function () { live = false; } };
  })();

  var t0 = performance.now();
  (function step(now) {
    var t = Math.min((now - t0) / PRELOAD_MS, 1);
    /* easeInOutQuad: the same curve as the spring in the source */
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    fill.style.width = (e * 100) + '%';
    num.textContent = Math.round(e * 100) + '%';
    if (t < 1) requestAnimationFrame(step); else exit();
  })(t0);

  /* First the captions go out, then the sheet leaves. Together they ran into
     each other: text driving away read as a miss in the layout rather than as
     a departure. */
  function exit() {
    var EASE_CUBIC = 'cubic-bezier(.65,0,.35,1)';   // easeInOutCubic
    hold.style.transition = 'opacity 380ms ease';
    hold.style.opacity = '0';
    setTimeout(function () {
      sheet.style.transition = 'transform ' + DARK_MS + 'ms ' + EASE_CUBIC;
      requestAnimationFrame(function () { sheet.style.transform = 'translateY(-101%)'; });
    }, 300);
    setTimeout(function () {
      warp.stop();          /* frames stop being computed before the node is removed */
      pl.remove();
      doc.style.overflow = prevOverflow;
    }, 300 + DARK_MS + 80);
  }

  revealHero();
  wireScrollReveals();
})();
