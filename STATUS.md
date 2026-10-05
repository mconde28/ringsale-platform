# RingSale Platform — STATUS (v1)

**Location:** `~/workspace/ringsale-platform/`
**Date:** 2026-10-05
**What it is:** the real multi-tenant RingSale SaaS — one site, vendor logins, cloud data in Supabase. Ported from the v15 demo register (`~/workspace/pos-demo-pwa/`, untouched).

## What works (verified)
- **Auth:** sign-up (business name + email + password → creates auth user, vendor row, owner profile, 4 clearly-marked sample menu items), login, logout, session restore. Handles the "confirm email" case with a pending-signup stash.
- **Register:** menu grid + category chips, customization modal (holds, add-ons, sizes, qty capped at stock), ticket (qty +/-, discount 0/5/10/15%, note), Cash tender (quick bills, keypad, exact, round-up, change), Card / Zelle / Venmo / Other tenders, cash drawer (opening / expected / drop), Close & Save Day with viewable closed-day reports, itemized sales reports, stock decrement, zero-stock grey-out + tap block, 86 mode, full menu admin (add/edit/delete, stock, avail, position).
- **Data isolation:** RLS on all 6 tables; every app query carries `vendor_id`; logout runs `Register.teardown()` so one vendor's in-memory ticket can never leak into another's session on a shared device.
- **Offline (best-effort v1):** localStorage read cache paints instantly; if Supabase is unreachable, an "Offline" badge shows, selling continues against cache, and completed sales queue and replay on next load.
- **PWA:** manifest (RingSale), brand icons (512/192/180), service worker `ringsale-app-v1` (precaches app shell, never caches API traffic), viewport zoom locked, `touch-action:manipulation`, `[hidden]{display:none!important}` guard.

## Verification
- `node --check` clean on all 7 JS files.
- `node dev/smoke.js` → **17/17 PASS** (mocked Supabase: menu render, tap-add, cash sale, stock decrement, zero-stock grey-out + tap block, close-day snapshot, offline queue + flush, reports).
- Cross-file audit: every DOM id referenced by JS exists in `index.html` (remainder are modal-created); `window.Register` exposes `init`/`renderAll`/`openMenuEdit`/`teardown` matching what `js/app.js` calls; manifest is valid JSON.

## What's stubbed / not yet live
- `js/config.js` still has **placeholder** Supabase URL + anon key — the app shows a "not configured" banner until they're pasted in.
- No billing (Stripe is phase 2). No full offline sync engine (phase 2). Item customizations (ingredients/add-ons/options) live in per-vendor localStorage, not in Supabase (documented in code).

## To take it live — the user must do these 3 things
1. **Create a Supabase project** at supabase.com (free tier), wait ~2 min for provisioning.
2. **Run the schema:** in the project dashboard → SQL Editor → New query → paste all of `supabase/schema.sql` → Run. Then **Authentication → Providers → Email → turn OFF "Confirm email"** (v1 skips email verification).
3. **Paste keys + deploy:** copy Project URL and `anon` public key from Project Settings → API into `js/config.js` (`RINGSALE_CONFIG`), then deploy the folder to Netlify (drag-and-drop the folder onto netlify.com, or `netlify deploy --prod --dir=.`).

After that: open the URL, create an account, and sell. To verify vendor isolation, sign up a second business in an incognito window and confirm each sees only its own menu/sales (the RLS verification queries are at the bottom of `schema.sql`).

## v2 — Owner admin system (2026-10-05)
- **DB migration** `supabase/migration-admin.sql` (idempotent; Michael runs in SQL Editor AFTER schema.sql): `is_admin()` + `my_vendor_active()` SECURITY DEFINER helpers; `vendors.status` ('active'/'suspended', default 'active'), `suspended_at`, `is_hq`; the 4 tenant policies (menu_items, sales, closed_days, drawer_state) re-created requiring `my_vendor_active()` in USING and WITH CHECK (suspended vendors see nothing and can write nothing); admin-bypass `FOR ALL` policies on all 6 tables (`USING (is_admin()) WITH CHECK (is_admin())`); all vendor FKs already `ON DELETE CASCADE` (verified); "RingSale HQ" vendor row (id `00000000-0000-0000-0000-000000000001`, excluded from admin list).
- **App**: role-aware routing (js/supabase.js caches role + vendor row; js/app.js routes admin → owner dashboard, suspended → clean "Account suspended" screen, else register as before; 60s status poll cuts off vendors suspended mid-session). New `js/admin.js`: vendor list (name, phone, status badge, signup date, revenue, sale count, last sale; HQ excluded), read-only detail (menu, itemized sales, closed days), Suspend / Reactivate / Delete (typed business-name confirm; cascades wipe their data; auth login removed separately in Supabase → Authentication → Users). Show/hide password eye toggles on login + signup (aria-labeled).
- **Michael's 2 steps to activate**: (1) run `supabase/migration-admin.sql` in Supabase SQL Editor; (2) sign up on the site, then run the grant snippet (commented at the top of the migration file) with his email: `UPDATE public.profiles SET role='admin', vendor_id='00000000-0000-0000-0000-000000000001' WHERE user_id = (SELECT id FROM auth.users WHERE email='HIS-EMAIL');`
- **Tests**: `dev/smoke-admin.js` 35/35 PASS (routing, suspend/reactivate/delete, tenant isolation, aggregates, dual teardown, password toggles); `dev/smoke.js` 17/17 still green; `node --check` clean on all 8 JS files.
- SW cache `ringsale-app-v2`, APP_VERSION v2.
