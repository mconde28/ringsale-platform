'use strict';
/* ============================================================================
 * RingSale — owner admin (window.Admin)
 *
 * RingSale HQ's view over every vendor: a vendor list with revenue
 * aggregates, a read-only detail view (menu items, recent sales with itemized
 * lines, closed-day reports), and account actions: suspend / reactivate /
 * delete. Deleting a vendor row removes their menu, sales, and reports via
 * FK cascades; their auth login is removed separately in Supabase.
 *
 * The HQ vendor row itself is filtered out of the list client-side.
 * ========================================================================== */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  };
  var M = function (n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); };
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  var HQ_NAME = 'RingSale HQ';
  var state = { initialized: false, vendors: [], agg: {}, detail: null, busy: false };

  function client() { return (window.SB && window.SB.client) || null; }
  function isHq(v) { return !!(v && (v.is_hq || v.name === HQ_NAME)); }
  function statusOf(v) { return (v && v.status) || 'active'; }
  function statusBadge(st) {
    return '<span class="badge ' + st + '">' + (st === 'suspended' ? 'Suspended' : 'Active') + '</span>';
  }

  function setMsg(text, kind) {
    var el = $('admin-msg');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'auth-msg' + (kind ? ' ' + kind : '');
  }

  /* ---------------- data ---------------- */

  // Defensive: if the admin migration hasn't been run yet (no status/is_hq
  // columns on vendors), retry without them and default to active / non-HQ.
  async function fetchVendors() {
    var c = client(); if (!c) throw new Error('Supabase is not configured.');
    var r = await c.from('vendors').select('id, name, phone, status, is_hq, created_at').order('created_at', { ascending: true });
    if (r.error) {
      var r2 = await c.from('vendors').select('id, name, phone, created_at').order('created_at', { ascending: true });
      if (r2.error) throw r2.error;
      return (r2.data || []).map(function (v) { v.status = 'active'; v.is_hq = false; return v; });
    }
    return r.data || [];
  }

  async function fetchAllSalesAgg() {
    var c = client(); if (!c) throw new Error('Supabase is not configured.');
    var r = await c.from('sales').select('vendor_id, total, created_at');
    if (r.error) throw r.error;
    var agg = {};
    (r.data || []).forEach(function (s) {
      var a = agg[s.vendor_id] || (agg[s.vendor_id] = { revenue: 0, count: 0, lastSale: null });
      a.revenue += Number(s.total) || 0;
      a.count += 1;
      if (s.created_at && (!a.lastSale || s.created_at > a.lastSale)) a.lastSale = s.created_at;
    });
    return agg;
  }

  async function refreshList() {
    setMsg('', '');
    var listEl = $('admin-vendor-list');
    listEl.innerHTML = '<p class="hint">Loading vendors…</p>';
    try {
      var vendors = await fetchVendors();
      state.vendors = vendors.filter(function (v) { return !isHq(v); });
      try { state.agg = await fetchAllSalesAgg(); }
      catch (e) { console.warn('[ringsale] admin sales aggregate failed:', e && e.message ? e.message : e); state.agg = {}; }
      renderList();
    } catch (e) {
      listEl.innerHTML = '';
      setMsg('Could not load vendors: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  /* ---------------- list view ---------------- */

  function renderList() {
    state.detail = null;
    var det = $('admin-detail');
    det.hidden = true; det.innerHTML = '';
    var listEl = $('admin-vendor-list');
    listEl.hidden = false;
    var html = '<div class="admin-head"><h2>Vendors</h2>' +
      '<span class="hint">' + state.vendors.length + ' account' + (state.vendors.length === 1 ? '' : 's') + '</span></div>';
    if (!state.vendors.length) {
      html += '<p class="hint">No vendor accounts yet.</p>';
    } else {
      state.vendors.forEach(function (v) {
        var a = state.agg[v.id] || { revenue: 0, count: 0, lastSale: null };
        html += '<button type="button" class="admin-vrow" data-vid="' + esc(v.id) + '">' +
          '<span class="vi">' +
            '<span class="vn">' + esc(v.name) + ' ' + statusBadge(statusOf(v)) + '</span>' +
            '<span class="vm">' + esc(v.phone || 'no phone') + ' · signed up ' + fmtDate(v.created_at) + '</span>' +
            '<span class="vt">' + M(a.revenue) + ' · ' + a.count + ' sale' + (a.count === 1 ? '' : 's') +
              ' · last ' + (a.lastSale ? fmtDate(a.lastSale) : '—') + '</span>' +
          '</span><span class="admin-chev">›</span></button>';
      });
    }
    listEl.innerHTML = html;
  }

  function findVendor(id) {
    for (var i = 0; i < state.vendors.length; i++) if (state.vendors[i].id === id) return state.vendors[i];
    return null;
  }

  /* ---------------- detail view ---------------- */

  function openDetail(vendorId) {
    var v = findVendor(vendorId);
    if (!v) return;
    state.detail = vendorId;
    setMsg('', '');
    $('admin-vendor-list').hidden = true;
    var det = $('admin-detail');
    det.hidden = false;
    var st = statusOf(v);
    var a = state.agg[vendorId] || { revenue: 0, count: 0, lastSale: null };
    var html =
      '<button type="button" class="btn" id="admin-detail-back">‹ All vendors</button>' +
      '<div class="admin-dhead"><h2>' + esc(v.name) + ' ' + statusBadge(st) + '</h2>' +
      '<p class="hint">' + esc(v.phone || 'no phone') + ' · signed up ' + fmtDate(v.created_at) +
        ' · ' + M(a.revenue) + ' lifetime · ' + a.count + ' sales</p></div>' +
      '<div class="admin-actions">' +
        (st === 'suspended'
          ? '<button type="button" class="btn primary" id="admin-btn-reactivate">Reactivate account</button>'
          : '<button type="button" class="btn warn" id="admin-btn-suspend">Suspend account</button>') +
        '<button type="button" class="btn danger" id="admin-btn-delete">Delete vendor…</button>' +
      '</div>' +
      '<p class="hint">Suspending signs them into a suspended screen until reactivated. ' +
      'Deleting removes their menu, sales, and reports (FK cascades). ' +
      'Their login itself is removed separately in Supabase → Authentication → Users.</p>' +
      '<div class="rep-sec"><h3>Menu</h3><div id="admin-detail-menu"><p class="hint">Loading…</p></div></div>' +
      '<div class="rep-sec"><h3>Recent sales</h3><div id="admin-detail-sales"><p class="hint">Loading…</p></div></div>' +
      '<div class="rep-sec"><h3>Closed days</h3><div id="admin-detail-closed"><p class="hint">Loading…</p></div></div>';
    det.innerHTML = html;
    $('admin-detail-back').addEventListener('click', function () { renderList(); });
    var sb = $('admin-btn-suspend');
    if (sb) sb.addEventListener('click', function () { onSuspend(v); });
    var rb = $('admin-btn-reactivate');
    if (rb) rb.addEventListener('click', function () { onReactivate(v); });
    $('admin-btn-delete').addEventListener('click', function () { onDelete(v); });
    loadDetailData(vendorId);
  }

  async function loadDetailData(vendorId) {
    var c = client();
    if (!c) { setMsg('Supabase is not configured.', 'error'); return; }
    try {
      var res = await Promise.all([
        c.from('menu_items').select('name, category, price, stock, avail, position').eq('vendor_id', vendorId).order('position', { ascending: true }),
        c.from('sales').select('*').eq('vendor_id', vendorId).order('created_at', { ascending: false }).limit(50),
        c.from('closed_days').select('day, created_at, drawer, sales').eq('vendor_id', vendorId).order('day', { ascending: false }).limit(20)
      ]);
      if (state.detail !== vendorId) return; // user navigated away mid-load
      renderDetailMenu((res[0] && res[0].data) || []);
      renderDetailSales((res[1] && res[1].data) || []);
      renderDetailClosed((res[2] && res[2].data) || []);
    } catch (e) {
      if (state.detail === vendorId) setMsg('Could not load vendor detail: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  function renderDetailMenu(items) {
    var el = $('admin-detail-menu'); if (!el) return;
    if (!items.length) { el.innerHTML = '<p class="hint">No menu items.</p>'; return; }
    var html = '<table class="admin-table"><thead><tr><th>Item</th><th>Category</th>' +
      '<th class="num">Price</th><th class="num">Stock</th><th>Avail</th></tr></thead><tbody>';
    items.forEach(function (i) {
      html += '<tr><td>' + esc(i.name) + '</td><td>' + esc(i.category || '—') + '</td>' +
        '<td class="num">' + M(i.price) + '</td><td class="num">' + (i.stock == null ? '—' : esc(i.stock)) + '</td>' +
        '<td>' + (i.avail === false ? 'No' : 'Yes') + '</td></tr>';
    });
    el.innerHTML = html + '</tbody></table>';
  }

  function lineText(l) {
    var t = (l.qty || 1) + ' × ' + (l.name || 'item');
    var det = [];
    if (l.size) det.push(l.size);
    (l.holds || []).forEach(function (h) { det.push('no ' + h); });
    (l.addons || []).forEach(function (ad) { det.push((ad.onSide ? 'side ' : '') + ad.name); });
    if (det.length) t += ' (' + det.join(', ') + ')';
    return t;
  }

  function renderDetailSales(sales) {
    var el = $('admin-detail-sales'); if (!el) return;
    if (!sales.length) { el.innerHTML = '<p class="hint">No sales yet.</p>'; return; }
    var html = '';
    sales.forEach(function (s) {
      html += '<div class="receipt">' +
        '<div style="display:flex;justify-content:space-between;font-weight:800"><span>' + fmtDateTime(s.created_at) + '</span><span>' + M(s.total) + '</span></div>' +
        '<div class="hint" style="margin:2px 0 6px">tender: ' + esc(s.tender || '—') + (s.note ? ' · note: ' + esc(s.note) : '') + '</div>';
      (Array.isArray(s.lines) ? s.lines : []).forEach(function (l) {
        html += '<div style="display:flex;justify-content:space-between;font-size:13px;gap:8px"><span>' +
          esc(lineText(l)) + '</span><span>' + M(l.total) + '</span></div>';
      });
      html += '</div>';
    });
    el.innerHTML = html;
  }

  function renderDetailClosed(days) {
    var el = $('admin-detail-closed'); if (!el) return;
    if (!days.length) { el.innerHTML = '<p class="hint">No closed days yet.</p>'; return; }
    var html = '<table class="admin-table"><thead><tr><th>Day</th><th class="num">Sales</th><th class="num">Total</th><th>Location</th></tr></thead><tbody>';
    days.forEach(function (d) {
      var sales = Array.isArray(d.sales) ? d.sales : [];
      var tot = sales.reduce(function (s, x) { return s + (Number(x.total) || 0); }, 0);
      var loc = (d.drawer && d.drawer.loc) || '';
      html += '<tr><td>' + esc(d.day || fmtDate(d.created_at)) + '</td><td class="num">' + sales.length +
        '</td><td class="num">' + M(tot) + '</td><td>' + esc(loc) + '</td></tr>';
    });
    el.innerHTML = html + '</tbody></table>';
  }

  /* ---------------- actions ---------------- */

  async function onSuspend(v) {
    if (state.busy) return;
    if (!confirm('Suspend "' + v.name + '"?\n\nThey will see a suspended screen and cannot sell until you reactivate them.')) return;
    state.busy = true; setMsg('Suspending ' + v.name + '…', '');
    try {
      var r = await client().from('vendors').update({ status: 'suspended', suspended_at: new Date().toISOString() }).eq('id', v.id);
      if (r.error) throw r.error;
      await refreshList();
      setMsg('"' + v.name + '" is now suspended.', 'ok');
    } catch (e) { setMsg('Suspend failed: ' + (e && e.message ? e.message : e), 'error'); }
    state.busy = false;
  }

  async function onReactivate(v) {
    if (state.busy) return;
    state.busy = true; setMsg('Reactivating ' + v.name + '…', '');
    try {
      var r = await client().from('vendors').update({ status: 'active', suspended_at: null }).eq('id', v.id);
      if (r.error) throw r.error;
      await refreshList();
      setMsg('"' + v.name + '" is active again.', 'ok');
    } catch (e) { setMsg('Reactivation failed: ' + (e && e.message ? e.message : e), 'error'); }
    state.busy = false;
  }

  async function onDelete(v) {
    if (state.busy) return;
    var typed = prompt('PERMANENTLY delete "' + v.name + '" and ALL of their data (menu, sales, reports)?\n\nType the exact business name to confirm:');
    if (typed == null) return; // cancelled
    if (typed !== v.name) { setMsg('Name did not match — nothing was deleted.', 'error'); return; }
    state.busy = true; setMsg('Deleting ' + v.name + '…', '');
    try {
      var r = await client().from('vendors').delete().eq('id', v.id);
      if (r.error) throw r.error;
      await refreshList();
      setMsg('"' + v.name + '" was deleted. Remove their login separately in Supabase → Authentication → Users.', 'ok');
    } catch (e) { setMsg('Delete failed: ' + (e && e.message ? e.message : e), 'error'); }
    state.busy = false;
  }

  /* ---------------- lifecycle ---------------- */

  var clicksWired = false;
  function wireListClicksOnce() {
    if (clicksWired) return;
    clicksWired = true;
    $('admin-vendor-list').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-vid]') : null;
      if (b) {
        var id = b.getAttribute('data-vid');
        if (id) openDetail(id);
      }
    });
  }

  // init() is idempotent: re-routing to the admin screen never clobbers an
  // open detail view; actions refresh the list themselves.
  function init() {
    wireListClicksOnce();
    if (state.initialized) return Promise.resolve();
    state.initialized = true;
    return refreshList();
  }

  function teardown() {
    state.initialized = false;
    state.detail = null;
    state.vendors = [];
    state.agg = {};
    state.busy = false;
    var l = $('admin-vendor-list'); if (l) { l.innerHTML = ''; l.hidden = false; }
    var d = $('admin-detail'); if (d) { d.innerHTML = ''; d.hidden = true; }
    setMsg('', '');
  }

  window.Admin = { init: init, teardown: teardown, refresh: refreshList };
})();
