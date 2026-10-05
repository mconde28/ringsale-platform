/* RingSale — authentication.
   Exposes window.Auth = { signUp, signIn, signOut, onAuthChange }.
   signUp provisions the vendor, the owner's profile row, and a starter
   sample menu. If email confirmation is ON in Supabase, provisioning is
   deferred: pending details are kept on-device and applied on first sign-in. */
(function () {
  var PENDING_KEY = 'ringsale_pending_signup';

  function needClient() {
    if (!window.SB || !window.SB.client) {
      throw new Error('Supabase is not configured yet — paste your Project URL and anon key into js/config.js');
    }
  }

  var SEED_MENU = [
    { name: 'SAMPLE — Classic Taco',   category: 'Samples', price: 3.50, position: 1 },
    { name: 'SAMPLE — Side of Fries',  category: 'Samples', price: 3.00, position: 2 },
    { name: 'SAMPLE — Fountain Drink', category: 'Samples', price: 2.50, position: 3 },
    { name: 'SAMPLE — Premium Burger', category: 'Samples', price: 8.50, position: 4 }
  ];

  function readPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) { return null; }
  }
  function writePending(p) {
    try {
      if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* storage unavailable — provisioning fallback will surface an error */ }
  }

  // Creates vendor + owner profile + sample menu for an authenticated user.
  // The vendor id is generated client-side: at signup time the user has no
  // profile row yet, so PostgREST cannot RETURN the inserted vendor row (the
  // SELECT policy needs my_vendor(), which requires the profile). Generating
  // the id up front avoids the RETURNING clause entirely.
  function newUuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async function provisionVendor(user, businessName, phone) {
    var client = window.SB.client;
    var vendorId = newUuid();
    try {
      var vRes = await client.from('vendors')
        .insert({ id: vendorId, name: businessName.trim(), phone: (phone || '').trim() || null });
      if (vRes.error) throw vRes.error;

      var pRes = await client.from('profiles')
        .insert({ user_id: user.id, vendor_id: vendorId, role: 'owner' });
      if (pRes.error) throw pRes.error;

      var rows = SEED_MENU.map(function (m) {
        return {
          vendor_id: vendorId, name: m.name, category: m.category,
          price: m.price, stock: 20, avail: true, position: m.position
        };
      });
      var mRes = await client.from('menu_items').insert(rows);
      if (mRes.error) throw mRes.error;

      writePending(null);
      await window.SB.refreshProfile();
      return vendorId;
    } catch (e) {
      // Best-effort cleanup of a half-created vendor. No vendor DELETE policy
      // exists (RLS), so this usually no-ops — orphan rows are invisible to
      // everyone anyway. Never mask the original error.
      try { await client.from('vendors').delete().eq('id', vendorId); } catch (_) {}
      throw e;
    }
  }

  async function signUp(opts) {
    needClient();
    var businessName = opts.businessName, phone = opts.phone, email = opts.email, password = opts.password;
    if (!businessName || !String(businessName).trim()) throw new Error('Business name is required.');
    if (!email || !password) throw new Error('Email and password are required.');

    var res = await window.SB.client.auth.signUp({ email: email, password: password });
    if (res.error) throw res.error;
    var user = res.data.user;

    if (!res.data.session || !user) {
      // Email confirmation is required — provision after they confirm and sign in.
      writePending({ user_id: user ? user.id : null, email: email, businessName: businessName, phone: phone || '' });
      return { needsEmailConfirmation: true };
    }

    var vendorId = await provisionVendor(user, businessName, phone);
    return { needsEmailConfirmation: false, vendorId: vendorId };
  }

  async function signIn(opts) {
    needClient();
    var email = opts.email, password = opts.password;
    if (!email || !password) throw new Error('Email and password are required.');

    var res = await window.SB.client.auth.signInWithPassword({ email: email, password: password });
    if (res.error) throw res.error;
    var user = res.data.user;

    var vendorId = await window.SB.refreshProfile();
    if (!vendorId) {
      // Newly confirmed account that was provisioned after email confirmation.
      var pending = readPending();
      if (pending && user && (!pending.user_id || pending.user_id === user.id) && pending.businessName) {
        vendorId = await provisionVendor(user, pending.businessName, pending.phone);
      }
    }
    if (!vendorId) {
      await window.SB.client.auth.signOut();
      throw new Error('This account has no business linked to it yet. Please create an account first.');
    }
    return { vendorId: vendorId, user: user };
  }

  async function signOut() {
    writePending(null);
    if (window.SB && window.SB.client) {
      await window.SB.client.auth.signOut();
    }
    if (window.SB) await window.SB.refreshProfile();
  }

  function onAuthChange(cb) {
    needClient();
    var sub = window.SB.client.auth.onAuthStateChange(function (event, session) {
      cb(event, session);
    });
    return sub;
  }

  window.Auth = { signUp: signUp, signIn: signIn, signOut: signOut, onAuthChange: onAuthChange };
})();
