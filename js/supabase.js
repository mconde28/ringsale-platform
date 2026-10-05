/* RingSale — Supabase client + session/profile cache.
   Exposes window.SB = { client, configured, ready, getUser(), getVendorId(), refreshProfile() } */
(function () {
  var cfg = window.RINGSALE_CONFIG || {};
  var configured = !!(cfg.SUPABASE_URL &&
    cfg.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') === -1 &&
    cfg.SUPABASE_ANON_KEY && cfg.SUPABASE_ANON_KEY.indexOf('YOUR-ANON-KEY') === -1);

  var client = null;
  if (configured && window.supabase && typeof window.supabase.createClient === 'function') {
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  var cachedUser = null;
  var cachedVendorId = null;

  function readProfile(userId) {
    if (!client || !userId) return Promise.resolve(null);
    return client.from('profiles').select('vendor_id').eq('user_id', userId).maybeSingle()
      .then(function (res) {
        if (res.error) {
          console.warn('[ringsale] profile read failed:', res.error.message);
          return null;
        }
        return res.data ? res.data.vendor_id : null;
      });
  }

  // Initial session check — resolves when the first session state is known.
  var ready = (async function () {
    if (!client) return null;
    try {
      var res = await client.auth.getSession();
      cachedUser = (res.data && res.data.session) ? res.data.session.user : null;
      cachedVendorId = cachedUser ? await readProfile(cachedUser.id) : null;
    } catch (e) {
      console.warn('[ringsale] initial session check failed:', e);
    }
    return cachedUser;
  })();

  // Keep the cache fresh on sign-in/sign-out/token refresh.
  if (client) {
    client.auth.onAuthStateChange(async function (_event, session) {
      cachedUser = session ? session.user : null;
      cachedVendorId = cachedUser ? await readProfile(cachedUser.id) : null;
    });
  }

  window.SB = {
    client: client,
    configured: configured,
    ready: ready,
    getUser: function () { return cachedUser; },
    getVendorId: function () { return cachedVendorId; },
    refreshProfile: async function () {
      cachedVendorId = cachedUser ? await readProfile(cachedUser.id) : null;
      return cachedVendorId;
    }
  };
})();
