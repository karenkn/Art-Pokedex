// Who is logged in? Reads the role and username from the saved login token so every page can
// show or hide things for super admins vs editors. This only changes what's SHOWN — the server
// enforces the real permissions.
//   Auth.role()    → 'superadmin' | 'editor' | null (logged out)
//   Auth.name()    → username ('admin' for the main admin login)
//   Auth.isSuper() → true for super admins
//   Auth.apply()   → shows elements marked class="super-only" only to super admins
(function () {
  function payload() {
    try {
      const t = localStorage.getItem('adminToken');
      if (!t) return null;
      const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return (p.exp && p.exp * 1000 > Date.now()) ? p : null;
    } catch (_) { return null; }
  }
  const Auth = {
    payload,
    role() { const p = payload(); return !p ? null : (p.role === 'admin' ? 'superadmin' : p.role); },   // old tokens = main admin
    name() { const p = payload(); return p ? (p.name || 'admin') : ''; },
    isSuper() { return Auth.role() === 'superadmin'; },
    apply() {
      const show = Auth.isSuper();
      document.querySelectorAll('.super-only').forEach(el => { el.style.display = show ? '' : 'none'; });
    }
  };
  window.Auth = Auth;

  // Username box in the login pop-up (the pages only style password inputs)
  const css = document.createElement('style');
  css.textContent = `.login-modal input[type=text] { width: 100%; box-sizing: border-box; padding: 9px 12px; border: 1px solid #c8c2b8;
    border-radius: 0; font-size: 13px; margin-bottom: 12px; font-family: inherit; }
    .login-modal input[type=text]:focus { outline: none; border-color: #8f0101; }
    .login-hint { font-size: 11px; color: #999; margin: -6px 0 12px; }`;
  document.head.appendChild(css);
  document.addEventListener('DOMContentLoaded', Auth.apply);
  window.addEventListener('storage', Auth.apply);
})();
