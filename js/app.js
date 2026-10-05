/* RingSale — boot router: auth screen <-> app shell.
   Wires the auth forms, tab bar, logout, and placeholder-config banner.
   Tab contents and modals are owned by window.Register (js/register.js):
   the only contract used here is Register.init(vendorId), plus optional
   Register.openMenuEdit(null) for the "+ Add Item" button and
   Register.teardown() on logout when present. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function isConfigured() {
    var c = window.RINGSALE_CONFIG || {};
    return !!(c.SUPABASE_URL && String(c.SUPABASE_URL).indexOf('YOUR-PROJECT-REF') === -1);
  }

  function setMsg(text, kind) {
    var el = $('auth-msg');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'auth-msg' + (kind ? ' ' + kind : '');
  }

  function showAuthTab(which) {
    var login = which === 'login';
    $('auth-tab-login').classList.toggle('active', login);
    $('auth-tab-signup').classList.toggle('active', !login);
    $('form-login').hidden = !login;
    $('form-signup').hidden = login;
    setMsg('', '');
  }

  function showTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    var panes = document.querySelectorAll('.tabpane');
    for (var j = 0; j < panes.length; j++) {
      panes[j].hidden = panes[j].id !== 'tab-' + name;
    }
  }

  async function loadBusinessName(vendorId) {
    var el = $('hdr-business');
    el.textContent = '';
    if (!window.SB || !window.SB.client) return;
    try {
      var res = await window.SB.client.from('vendors').select('name').eq('id', vendorId).maybeSingle();
      if (res.data && res.data.name) el.textContent = res.data.name;
    } catch (e) { /* header stays blank on failure */ }
  }

  async function syncAuthState() {
    var user = window.SB.getUser();
    var vendorId = window.SB.getVendorId();
    if (user && vendorId) {
      $('screen-auth').hidden = true;
      $('screen-app').hidden = false;
      loadBusinessName(vendorId);
      if (window.Register && typeof window.Register.init === 'function') {
        await window.Register.init(vendorId);
      }
    } else {
      $('screen-app').hidden = true;
      $('screen-auth').hidden = false;
    }
  }

  async function withBusy(btn, fn) {
    btn.disabled = true;
    var orig = btn.textContent;
    btn.textContent = 'Please wait...';
    try { await fn(); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Version tag in the header.
    $('app-version').textContent = window.APP_VERSION || '';

    // Friendly banner when Supabase keys are still placeholders.
    if (!isConfigured()) {
      $('config-banner').hidden = false;
    }

    // Auth tabs.
    $('auth-tab-login').addEventListener('click', function () { showAuthTab('login'); });
    $('auth-tab-signup').addEventListener('click', function () { showAuthTab('signup'); });

    // Login form.
    $('form-login').addEventListener('submit', function (e) {
      e.preventDefault();
      setMsg('', '');
      withBusy($('btn-login'), async function () {
        try {
          await window.Auth.signIn({
            email: $('login-email').value.trim(),
            password: $('login-password').value
          });
          await syncAuthState();
        } catch (err) {
          setMsg(err && err.message ? err.message : 'Log in failed.', 'error');
        }
      });
    });

    // Signup form.
    $('form-signup').addEventListener('submit', function (e) {
      e.preventDefault();
      setMsg('', '');
      withBusy($('btn-signup'), async function () {
        try {
          var res = await window.Auth.signUp({
            businessName: $('signup-business').value,
            phone: $('signup-phone').value,
            email: $('signup-email').value.trim(),
            password: $('signup-password').value
          });
          if (res && res.needsEmailConfirmation) {
            showAuthTab('login');
            setMsg('Account created! Check your email to confirm, then log in.', 'ok');
          } else {
            await syncAuthState();
          }
        } catch (err) {
          setMsg(err && err.message ? err.message : 'Could not create account.', 'error');
        }
      });
    });

    // Logout.
    $('btn-logout').addEventListener('click', function () {
      withBusy($('btn-logout'), async function () {
        try { await window.Auth.signOut(); } catch (e) { /* already out */ }
        if (window.Register && typeof window.Register.teardown === 'function') {
          try { await window.Register.teardown(); } catch (e) { /* non-fatal */ }
        }
        await syncAuthState();
        showAuthTab('login');
        $('login-password').value = '';
      });
    });

    // Tab bar (Sell / Menu / Reports).
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        showTab(this.getAttribute('data-tab'));
      });
    }

    // "+ Add Item" — delegated to register.js when it exposes an editor.
    $('btn-add-item').addEventListener('click', function () {
      if (window.Register && typeof window.Register.openMenuEdit === 'function') {
        window.Register.openMenuEdit(null);
      }
    });

    // Optional: date line in the header (register.js may own this too).
    var day = new Date();
    $('hdr-day').textContent = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    // Boot: wait for the initial session check, then route.
    window.SB.ready.then(function () {
      if (window.SB.configured && window.Auth) {
        window.Auth.onAuthChange(async function () {
          await window.SB.refreshProfile();
          await syncAuthState();
        });
      }
      return syncAuthState();
    });
  });
})();
