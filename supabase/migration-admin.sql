-- =============================================================================
-- RingSale owner-admin system — database migration
-- =============================================================================
-- WHAT THIS DOES:
--   1. Adds `status` / `suspended_at` / `is_hq` columns to vendors.
--   2. Adds an `is_admin()` helper (true when the caller's profile row has
--      role = 'admin').
--   3. Tightens the 4 tenant isolation policies so a SUSPENDED vendor's rows
--      are invisible and un-writable to them (status must be 'active').
--   4. Adds an `*_admin_bypass` policy on ALL 6 tables: admins (permissive
--      policies OR together) can read/write everything; regular vendors
--      still pass only the tenant isolation policies.
--   5. Seeds the "RingSale HQ" vendor row (the admin's own home, hidden
--      from the admin vendor list in the app) and leaves a grant snippet
--      for Michael to run (commented out).
--
-- RE-RUNNABLE: every statement is idempotent — safe to paste into the
-- Supabase SQL Editor and run multiple times.
--
-- ORDER: run schema.sql first (creates the base tables + policies), then
-- this file.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 2 (after signing up on the site): paste YOUR email in place of HIS-EMAIL and run:
-- UPDATE public.profiles SET role='admin', vendor_id='00000000-0000-0000-0000-000000000001'
-- WHERE user_id = (SELECT id FROM auth.users WHERE email='HIS-EMAIL');
--
-- NOTE: you MUST sign up on the site FIRST so your auth.users row exists —
-- this UPDATE only works after you have created an account.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Admin helper: true when the signed-in user has the admin role.
-- SECURITY DEFINER lets it read public.profiles even though RLS is enabled.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id = auth.uid() AND role = 'admin'
    )
$$;

-- -----------------------------------------------------------------------------
-- Vendor status columns: suspension support + RingSale HQ marker.
-- -----------------------------------------------------------------------------

ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS is_hq boolean NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------------
-- Tenant-active helper: true when the caller's vendor row has status='active'.
-- SECURITY DEFINER lets it read public.vendors / public.profiles even though
-- RLS is enabled.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.my_vendor_active()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.vendors v
        JOIN public.profiles p ON p.vendor_id = v.id
        WHERE p.user_id = auth.uid()
          AND v.status = 'active'
    )
$$;

-- -----------------------------------------------------------------------------
-- Tenant isolation policies, recreated to also require an ACTIVE vendor.
-- A suspended vendor sees nothing and can write nothing — their own rows are
-- filtered out because USING applies to SELECT too.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "menu_items_tenant_isolation" ON public.menu_items;
CREATE POLICY "menu_items_tenant_isolation" ON public.menu_items
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor() AND public.my_vendor_active())
    WITH CHECK (vendor_id = public.my_vendor() AND public.my_vendor_active());

DROP POLICY IF EXISTS "sales_tenant_isolation" ON public.sales;
CREATE POLICY "sales_tenant_isolation" ON public.sales
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor() AND public.my_vendor_active())
    WITH CHECK (vendor_id = public.my_vendor() AND public.my_vendor_active());

DROP POLICY IF EXISTS "closed_days_tenant_isolation" ON public.closed_days;
CREATE POLICY "closed_days_tenant_isolation" ON public.closed_days
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor() AND public.my_vendor_active())
    WITH CHECK (vendor_id = public.my_vendor() AND public.my_vendor_active());

DROP POLICY IF EXISTS "drawer_state_tenant_isolation" ON public.drawer_state;
CREATE POLICY "drawer_state_tenant_isolation" ON public.drawer_state
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor() AND public.my_vendor_active())
    WITH CHECK (vendor_id = public.my_vendor() AND public.my_vendor_active());

-- -----------------------------------------------------------------------------
-- Admin bypass policies: permissive policies OR together, so an admin passes
-- on every table while ordinary vendors still only pass tenant isolation.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "vendors_admin_bypass" ON public.vendors;
CREATE POLICY "vendors_admin_bypass" ON public.vendors
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "profiles_admin_bypass" ON public.profiles;
CREATE POLICY "profiles_admin_bypass" ON public.profiles
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "menu_items_admin_bypass" ON public.menu_items;
CREATE POLICY "menu_items_admin_bypass" ON public.menu_items
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "sales_admin_bypass" ON public.sales;
CREATE POLICY "sales_admin_bypass" ON public.sales
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "closed_days_admin_bypass" ON public.closed_days;
CREATE POLICY "closed_days_admin_bypass" ON public.closed_days
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "drawer_state_admin_bypass" ON public.drawer_state;
CREATE POLICY "drawer_state_admin_bypass" ON public.drawer_state
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- FK CASCADE FINDING: verified against schema.sql — EVERY vendor FK already
-- carries ON DELETE CASCADE:
--   profiles.user_id    -> auth.users(id)    ON DELETE CASCADE
--   profiles.vendor_id  -> vendors(id)       ON DELETE CASCADE
--   menu_items.vendor_id-> vendors(id)       ON DELETE CASCADE
--   sales.vendor_id     -> vendors(id)       ON DELETE CASCADE
--   closed_days.vendor_id -> vendors(id)     ON DELETE CASCADE
--   drawer_state.vendor_id -> vendors(id)    ON DELETE CASCADE
-- Deleting a vendor row therefore deletes its profile, menu, sales, closed
-- days, and drawer state automatically. No constraint changes needed.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- RingSale HQ vendor row: the admin's own vendor home. The app hides it from
-- the admin vendor list (is_hq = true).
-- -----------------------------------------------------------------------------

INSERT INTO public.vendors (id, name, phone, status, is_hq)
VALUES ('00000000-0000-0000-0000-000000000001', 'RingSale HQ', NULL, 'active', true)
ON CONFLICT (id) DO UPDATE
    SET is_hq = true, status = 'active';

-- =============================================================================
-- RLS VERIFICATION
-- =============================================================================
-- 1. As the admin (role='admin' on your profile), you must see EVERY vendor:
--
--      SELECT count(*) AS total_vendors FROM public.vendors;
--
--    (Count must equal the number of rows in Table Editor — not just yours.)
--
-- 2. As the admin, cross-vendor writes must work (admin bypass policy):
--
--      SELECT * FROM public.profiles LIMIT 1;
--      UPDATE public.vendors SET suspended_at = now()
--        WHERE id = '<some-vendor-uuid>';
--      -- then re-set status/suspended_at back when done checking
--
-- 3. As a SUSPENDED vendor, inserts must FAIL (tenant policy now requires
--    status='active'):
--
--      -- sign in as a vendor whose vendors.status = 'suspended', then:
--      INSERT INTO public.menu_items (vendor_id, name, price)
--        VALUES ('<your-own-vendor-uuid>', 'Test Item', 1);
--      -- => error / "violates row-level security policy" (0 rows inserted)
--
--    and SELECT must show nothing (USING filters their own rows too):
--
--      SELECT count(*) FROM public.menu_items;   -- 0 rows
--
-- 4. Re-activating restores access — admin runs:
--
--      UPDATE public.vendors SET status = 'active', suspended_at = NULL
--        WHERE id = '<vendor-uuid>';
--
-- 5. Anonymous (signed out) still sees NOTHING — no admin bypass without
--    an authenticated admin role.
--
-- If any check fails, re-run this whole file; a missing policy or helper
-- function is the usual cause.
-- =============================================================================
