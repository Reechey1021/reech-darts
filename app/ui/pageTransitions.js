// app/ui/pageTransitions.js
// Small fade-in/out helper for smoother full-page navigation.

const EXIT_MS = 140;

export function softNavigate(url) {
  if (!url) return;
  try {
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduced) {
      window.location.href = url;
      return;
    }
    if (document.body.classList.contains('page-exit')) {
      window.location.href = url;
      return;
    }
    document.body.classList.add('page-exit');
    window.setTimeout(() => {
      window.location.href = url;
    }, EXIT_MS);
  } catch (_) {
    window.location.href = url;
  }
}

export function initPageTransitions() {
  try {
    window.softNavigate = softNavigate;
    window.addEventListener('pageshow', () => {
      document.body.classList.remove('page-exit');
    });
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (a.target && a.target !== '_self') return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute('href') || '';
      if (!href || href[0] === '#' || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      if (a.hasAttribute('download')) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      softNavigate(url.pathname + url.search + url.hash);
    }, true);
  } catch (_) {
    // non-fatal
  }
}
