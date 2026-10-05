/* RingSale — Supabase client + session/profile cache.
   Exposes window.SB = { client, configured, ready, getUser(), getVendorId(),
   getRole(), getVendor(), refreshProfile() } */
(function () {
  'use strict';

  var cfg = window.RINGSALE_CONFIG || {};
  var configured = !!(cfg.SUPABASE_URL &&
    cfg.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') === -1 &&
    cfg.SUPABASE_ANON_KEY && cfg.SUPABASE_ANON_KEY.indexOf('YOUR-ANON-KEY') === -1);

  var client = null;
  if (configured && window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  function blankVendor() { return { id: null, name: '', status: 'active', is_hq: false }; }

  var cachedUser = null;
  var cachedVendorId = null;
  var cachedRole = 'owner';
  var cachedVendor = blankVendor();

  // Read the caller's vendor row. Defensive: if the admin migration hasn't
  // been run yet (no status/is_hq columns), fall back to a minimal select and
  // default to active / non-HQ so normal vendor login never breaks.
  function readVendorRow(vendorId) {
    if (!client || !vendorId) return Promise.resolve(blankVendor());
    return client.from('vendors').select('id, name, status, is_hq').eq('id', vendorId).maybeSingle()
      .then(function (res) {
        if (res.error) {
          return client.from('vendors').select('id, name').eq('id', vendorId).maybeSingle()
            .then(function (res2) {
              var v = blankVendor();
              v.id = vendorId;
              if (!res2.error && res2.data) {
                v.name = res2.data.name || '';
                return v;
              }
              console.warn('[ringsale] vendor read failed:', res.error.message);
              return v;
            });
        }
        var v = blankVendor();
        v.id = vendorId;
        v.name = (res.data && res.data.name) || '';
        v.status = (res.data && res.data.status) || 'active';
        v.is_hq = !!(res.data && res.data.is_hq);
        return v;
      });
  }

  function finishProfile(p) {
    if (!p) return null;
    var role = p.role || 'owner';
    return readVendorRow(p.vendor_id).then(function (vendor) {
      return { vendorId: p.vendor_id, role: role, vendor: vendor };
    });
  }

  // Extended profile read: vendor_id + role, then the vendor row.
  // Defensive: if the role column doesn't exist yet (migration not run),
  // retry without it and default to 'owner'.
  function readProfile(userId) {
    if (!client || !userId) return Promise.resolve(null);
    return client.from('profiles').select('vendor_id, role').eq('user_id', userId).maybeSingle()
      .then(function (res) {
        if (res.error) {
          return client.from('profiles').select('vendor_id').eq('user_id', userId).maybeSingle()
            .then(function (res2) {
              if (res2.error) {
                console.warn('[ringsale] profile read failed:', res.error.message);
                return null;
              }
              return finishProfile(res2.data);
            });
        }
        return finishProfile(res.data);
      });
  }

  function applyProfile(p) {
    if (p) {
      cachedVendorId = p.vendorId;
      cachedRole = p.role || 'owner';
      cachedVendor = p.vendor || blankVendor();
    } else {
      cachedVendorId = null;
      cachedRole = 'owner';
      cachedVendor = blankVendor();
    }
    return cachedVendorId;
  }

  // Initial session check — resolves when the first session state is known.
  var ready = (async function () {
    if (!client) return null;
    try {
      var res = await client.auth.getSession();
      cachedUser = (res.data && res.data.session) ? res.data.session.user : null;
      applyProfile(cachedUser ? await readProfile(cachedUser.id) : null);
    } catch (e) {
      console.warn('[ringsale] initial session check failed:', e);
    }
    return cachedUser;
  })();

  // Keep the cache fresh on sign-in/sign-out/token refresh.
  if (client) {
    client.auth.onAuthStateChange(async function (_event, session) {
      cachedUser = session ? session.user : null;
      applyProfile(cachedUser ? await readProfile(cachedUser.id) : null);
    });
  }

  window.SB = {
    client: client,
    configured: configured,
    ready: ready,
    getUser: function () { return cachedUser; },
    getVendorId: function () { return cachedVendorId; },
    getRole: function () { return cachedRole; },
    getVendor: function () { return cachedVendor; },
    refreshProfile: async function () {
      applyProfile(cachedUser ? await readProfile(cachedUser.id) : null);
      return cachedVendorId;
    }
  };
})();
