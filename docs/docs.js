/* =========================================================================
   The documentation page. It needs little: to remember the chosen accent, to
   keep the table of contents and not to stay silent in answer to the wallet
   button.
   ========================================================================= */

const BRAND = { name: 'APEX', ticker: 'APEX' };

/* The theme is chosen on the home page and lies in localStorage: here we only
   read it. Otherwise the documentation would open in a different colour from
   the site. */
try {
} catch (_) { /* private mode */ }

/* The table of contents highlights the section now on the screen. */
const links = [...document.querySelectorAll('.docs-toc a')];
const targets = links
  .map(a => document.querySelector(a.getAttribute('href')))
  .filter(Boolean);

if (targets.length && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const i = targets.indexOf(e.target);
      links.forEach((a, k) => a.classList.toggle('on', k === i));
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  targets.forEach(t => io.observe(t));
}

/* No silent buttons: there is nothing to connect to, so we say so. */
const connect = document.querySelector('.connect');
if (connect) {
  connect.addEventListener('click', e => {
    e.preventDefault();
    const prev = connect.innerHTML;
    connect.innerHTML = '<i aria-hidden="true"></i>NO CONTRACT YET';
    setTimeout(() => { connect.innerHTML = prev; }, 1800);
  });
}


/* The wallet button is here too: a person reading the rules most often wants
   to check their own balance as the next step. No separate logic is needed,
   all of it is in wallet.js. */
if (window.ApexWallet) {
  window.ApexWallet.wire();
  window.ApexWallet.restore();
}
