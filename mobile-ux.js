// Mobile UX helpers shared by index.html and top-works.html:
//   • reliable background-scroll lock for modals/overlays (works on iOS Safari)
//   • floating "Back to top" button
//   • infinite-scroll ("lazy load") sentinel observer
//   • tiny toast
// Everything lives on window.MobileUX so it can't collide with page globals.
(function () {
  // ── Styles (injected so every page gets them without editing its CSS) ───────
  const css = `
    html.scroll-locked, body.scroll-locked { overflow: hidden !important; overscroll-behavior: none; }
    #backToTop {
      position: fixed; right: max(16px, env(safe-area-inset-right));
      bottom: max(16px, env(safe-area-inset-bottom));
      width: 48px; height: 48px; border-radius: 50%;
      background: #1a1a1a; color: #fff; border: 1px solid rgba(255,255,255,0.15);
      font-size: 20px; line-height: 1; cursor: pointer; z-index: 90;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      opacity: 0; pointer-events: none; transform: translateY(12px);
      transition: opacity 0.2s, transform 0.2s, background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    #backToTop.visible { opacity: 1; pointer-events: auto; transform: none; }
    #backToTop:active { background: #8f0101; }
    html.scroll-locked #backToTop { opacity: 0; pointer-events: none; }
    .mux-toast {
      position: fixed; left: 50%; bottom: max(84px, calc(env(safe-area-inset-bottom) + 72px));
      transform: translateX(-50%) translateY(10px);
      background: #1a1a1a; color: #fff; padding: 10px 18px; border-radius: 22px;
      font-size: 13px; z-index: 99999; opacity: 0; pointer-events: none;
      transition: opacity 0.2s, transform 0.2s; max-width: 90vw; text-align: center;
    }
    .mux-toast.show { opacity: 1; transform: translateX(-50%); }
    .load-more-sentinel {
      text-align: center; padding: 28px 0 36px; color: #aaa; font-size: 12px; letter-spacing: 0.4px;
    }
    @media (prefers-reduced-motion: reduce) {
      #backToTop, .mux-toast { transition: none; }
    }

    /* ── Safe areas, dynamic viewport height, compact sticky header (all pages) ── */
    :root { --header-h: calc(58px + env(safe-area-inset-top, 0px)); }
    html.header-compact { --header-h: calc(48px + env(safe-area-inset-top, 0px)); }
    header {
      height: var(--header-h);
      padding-top: env(safe-area-inset-top, 0px);
      padding-left:  max(clamp(16px, 4vw, 48px), env(safe-area-inset-left, 0px));
      padding-right: max(clamp(16px, 4vw, 48px), env(safe-area-inset-right, 0px));
    }
    .header-mobile-menu { top: var(--header-h) !important; }
    @supports (height: 100dvh) {
      body { min-height: 100dvh; }
    }
    @media (min-width: 768px) {
      @supports (height: 100dvh) { .modal { max-height: 90dvh; } }
    }
    @media (max-width: 767px) {
      header { transition: height 0.18s ease; }
      header img { transition: width 0.18s ease; }
      html.header-compact header img { width: 24px !important; }
    }

    /* ── Touch targets: at least 44px on touch screens ── */
    @media (pointer: coarse) {
      .header-hamburger { min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; }
      .header-mobile-menu a, .header-mobile-menu button { min-height: 48px; display: flex; align-items: center; }
      .admin-btn { min-height: 44px; }
      .modal-close-btn { min-width: 44px; min-height: 44px; }
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Scroll lock ─────────────────────────────────────────────────────────────
  // overflow:hidden on <html>/<body> stops page scroll on modern browsers; the
  // touchmove guard below covers older iOS versions that still let the page rubber-band.
  const locks = new Set();
  function applyLock() {
    const on = locks.size > 0;
    document.documentElement.classList.toggle('scroll-locked', on);
    document.body.classList.toggle('scroll-locked', on);
  }
  function canScroll(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
    }
    return false;
  }
  document.addEventListener('touchmove', e => {
    if (!locks.size) return;
    if (e.touches && e.touches.length > 1) return;            // allow pinch (e.g. map zoom)
    if (e.target.closest && e.target.closest('[data-gesture]')) return; // elements that handle their own drags
    if (canScroll(e.target)) return;
    e.preventDefault();
  }, { passive: false });

  // ── Toast ───────────────────────────────────────────────────────────────────
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'mux-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // ── Back to top ─────────────────────────────────────────────────────────────
  function initBackToTop() {
    const btn = document.createElement('button');
    btn.id = 'backToTop';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to top');
    btn.textContent = '↑';
    btn.addEventListener('click', () => {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
    document.body.appendChild(btn);
    let ticking = false;
    const update = () => {
      ticking = false;
      btn.classList.toggle('visible', window.scrollY > 600);
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  // ── Infinite scroll sentinel ────────────────────────────────────────────────
  let loadMoreObserver = null;
  function observeLoadMore(el, onVisible) {
    if (loadMoreObserver) { loadMoreObserver.disconnect(); loadMoreObserver = null; }
    if (!el) return;
    if (!('IntersectionObserver' in window)) { onVisible(); return; }
    loadMoreObserver = new IntersectionObserver(entries => {
      if (entries.some(en => en.isIntersecting)) {
        loadMoreObserver.disconnect();
        loadMoreObserver = null;
        onVisible();
      }
    }, { rootMargin: '900px 0px' });
    loadMoreObserver.observe(el);
  }

  // Compact sticky header on phones once the user scrolls down
  (function () {
    let compact = false, ticking = false;
    const update = () => {
      ticking = false;
      if (!matchMedia('(max-width: 767px)').matches) {
        if (compact) { compact = false; document.documentElement.classList.remove('header-compact'); }
        return;
      }
      const y = window.scrollY;
      if (!compact && y > 90) compact = true;
      else if (compact && y < 20) compact = false;
      else return;
      document.documentElement.classList.toggle('header-compact', compact);
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
  })();

  // Mobile navigation menu: contain it and freeze the page behind it while it is open
  function initMenuLock() {
    const menu = document.getElementById('headerMobileMenu');
    if (!menu) return;
    menu.style.maxHeight = 'calc(100dvh - var(--header-h))';
    menu.style.overflowY = 'auto';
    menu.style.overscrollBehavior = 'contain';
    const sync = () => {
      const open = menu.classList.contains('open') && matchMedia('(max-width: 767px)').matches;
      if (open) locks.add('menu'); else locks.delete('menu');
      applyLock();
    };
    new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', sync);
  }

  window.MobileUX = {
    lockScroll(key = 'default')   { locks.add(key);    applyLock(); },
    unlockScroll(key = 'default') { locks.delete(key); applyLock(); },
    isMobile: () => matchMedia('(max-width: 767px)').matches,
    toast,
    observeLoadMore
  };

  const initAll = () => { initBackToTop(); initMenuLock(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
