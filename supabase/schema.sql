-- =============================================================================
-- RingSale multi-tenant POS — Supabase schema
-- =============================================================================
-- One site, many vendors. Each vendor logs in and sees ONLY their own data.
-- The static PWA talks to Supabase via the JS client; Row Level Security (RLS)
-- enforces isolation in the database itself.
--
-- RE-RUNNABLE: safe to paste into the SQL Editor and run multiple times.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.vendors (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    phone      text,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.profiles (
    user_id   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    role      text NOT NULL DEFAULT 'owner'
);

CREATE TABLE IF NOT EXISTS public.menu_items (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id  uuid        NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    name       text        NOT NULL,
    category   text        NOT NULL DEFAULT 'Menu',
    price      numeric     NOT NULL DEFAULT 0,
    stock      integer     NOT NULL DEFAULT 0,
    avail      boolean     NOT NULL DEFAULT true,
    position   integer     NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales (
    id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id uuid       NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    lines    jsonb       NOT NULL DEFAULT '[]',
    subtotal numeric     NOT NULL DEFAULT 0,
    discount numeric     NOT NULL DEFAULT 0,
    total    numeric     NOT NULL DEFAULT 0,
    tender   text        NOT NULL DEFAULT 'Cash',
    tendered numeric     NOT NULL DEFAULT 0,
    change   numeric     NOT NULL DEFAULT 0,
    note     text        DEFAULT '',
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.closed_days (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id  uuid        NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    day        date        NOT NULL,
    sales      jsonb       NOT NULL DEFAULT '[]',
    drawer     jsonb       NOT NULL DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.drawer_state (
    vendor_id  uuid        PRIMARY KEY REFERENCES public.vendors(id) ON DELETE CASCADE,
    opening    numeric     NOT NULL DEFAULT 0,
    updated_at timestamptz DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- RLS helper: returns the vendor the currently-signed-in user belongs to.
-- SECURITY DEFINER lets it read public.profiles even though RLS is enabled.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.my_vendor()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT vendor_id FROM public.profiles WHERE user_id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- Enable RLS on every table
-- -----------------------------------------------------------------------------

ALTER TABLE public.vendors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closed_days  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drawer_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Policies: vendors
--   - SELECT / UPDATE the caller's own vendor row.
--   - INSERT allowed so signup can create the vendor row BEFORE the profile
--     row exists (the profile's vendor_id references it).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "vendors_select_own" ON public.vendors;
CREATE POLICY "vendors_select_own" ON public.vendors
    FOR SELECT TO authenticated
    USING (id = public.my_vendor());

DROP POLICY IF EXISTS "vendors_insert_signup" ON public.vendors;
CREATE POLICY "vendors_insert_signup" ON public.vendors
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "vendors_update_own" ON public.vendors;
CREATE POLICY "vendors_update_own" ON public.vendors
    FOR UPDATE TO authenticated
    USING (id = public.my_vendor())
    WITH CHECK (id = public.my_vendor());

-- -----------------------------------------------------------------------------
-- Policies: profiles
--   - A user may SELECT / INSERT / UPDATE only their OWN profile row.
--   - No DELETE policy: profiles are managed by the app/service role only.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Policies: per-vendor data (menu_items, sales, closed_days, drawer_state)
--   - SELECT / INSERT / UPDATE / DELETE only rows whose vendor_id matches
--     the caller's vendor. Every tenant-visible table shares this rule.
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "menu_items_tenant_isolation" ON public.menu_items;
CREATE POLICY "menu_items_tenant_isolation" ON public.menu_items
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor())
    WITH CHECK (vendor_id = public.my_vendor());

DROP POLICY IF EXISTS "sales_tenant_isolation" ON public.sales;
CREATE POLICY "sales_tenant_isolation" ON public.sales
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor())
    WITH CHECK (vendor_id = public.my_vendor());

DROP POLICY IF EXISTS "closed_days_tenant_isolation" ON public.closed_days;
CREATE POLICY "closed_days_tenant_isolation" ON public.closed_days
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor())
    WITH CHECK (vendor_id = public.my_vendor());

DROP POLICY IF EXISTS "drawer_state_tenant_isolation" ON public.drawer_state;
CREATE POLICY "drawer_state_tenant_isolation" ON public.drawer_state
    FOR ALL TO authenticated
    USING (vendor_id = public.my_vendor())
    WITH CHECK (vendor_id = public.my_vendor());

-- =============================================================================
-- RLS VERIFICATION
-- =============================================================================
-- Run these in the Supabase SQL Editor while signed in as a vendor (the SQL
-- Editor has a "Run as" / role selector on some plans; otherwise verify from
-- the app itself with two different vendor logins).
--
-- 1. As vendor A, you should see ONLY vendor A's rows:
--
--      SELECT count(*) AS my_menu_items FROM public.menu_items;
--      SELECT count(*) AS my_sales      FROM public.sales;
--
--    (Both counts should match what vendor A created — never vendor B's.)
--
-- 2. A direct query for another vendor's data must return ZERO rows.
--    Replace <other-vendor-uuid> with vendor B's vendors.id:
--
--      SELECT * FROM public.menu_items
--        WHERE vendor_id = '<other-vendor-uuid>';
--
--      SELECT * FROM public.sales
--        WHERE vendor_id = '<other-vendor-uuid>';
--
--    (Both should return 0 rows. RLS silently filters them out.)
--
-- 3. Writes to another vendor's rows must fail / affect 0 rows:
--
--      UPDATE public.menu_items SET price = 999
--        WHERE vendor_id = '<other-vendor-uuid>';
--
--      DELETE FROM public.menu_items
--        WHERE vendor_id = '<other-vendor-uuid>';
--
--    (Both should report "0 rows affected".)
--
-- 4. Profiles are strictly per-user — no cross-user access:
--
--      SELECT * FROM public.profiles;   -- shows only YOUR row
--
-- 5. Anonymous (not signed in) requests see NOTHING:
--
--      -- run without an auth token, e.g. curl with only the anon key:
--      SELECT count(*) FROM public.menu_items;  -- 0 rows
--
-- If any check leaks another vendor's data, re-run this whole file —
-- a missing policy or ENABLE ROW LEVEL SECURITY statement is the cause.
-- =============================================================================
