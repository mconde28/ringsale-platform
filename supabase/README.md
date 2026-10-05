# RingSale — Supabase Backend Setup

The database behind RingSale. Follow these steps once; after that the static
app handles everything.

---

## Setup (do this once)

### 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Click **New project**, give it a name (e.g. `ringsale`), pick a region near
   you, and set a database password (save it somewhere safe).
3. Wait **about 2 minutes** while Supabase provisions the project — the
   dashboard shows a spinner until it's ready.

### 2. Run the schema
1. In the project dashboard, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open the file `schema.sql` (in this `supabase/` folder), copy its **entire
   contents**, paste into the query box, and click **Run**.
4. You should see **"Success"**. The tables (`vendors`, `profiles`,
   `menu_items`, `sales`, `closed_days`, `drawer_state`) and all security
   policies are now installed. (Safe to re-run any time.)

### 3. Turn off email confirmation
1. Go to **Authentication → Providers → Email**.
2. Turn **OFF** "Confirm email". RingSale v1 skips email verification so a
   vendor can sign up and start selling immediately.

### 4. Copy your API credentials
1. Go to **Project Settings → API**.
2. Copy two values:
   - **Project URL** (looks like `https://xyzcompany.supabase.co`)
   - The **`anon` `public`** key (a long string starting with `eyJ…`).
3. ⚠️ Copy the **`anon`** key, NOT the `service_role` key. The service key
   bypasses all security rules — it must never go into the app.

### 5. Point the app at your project
1. In the app repo, open `js/config.js`.
2. Paste the URL and anon key into `RINGSALE_CONFIG`, e.g.:
   ```js
   const RINGSALE_CONFIG = {
     url: "https://xyzcompany.supabase.co",
     anonKey: "eyJhbGciOi..."
   };
   ```

### 6. Deploy and sign up
1. Deploy the static files — easiest: drag the app folder onto
   [app.netlify.com/drop](https://app.netlify.com/drop), or run
   `netlify deploy` from the repo.
2. Open the live URL on the device.
3. Sign up with **business name + email + password**. That's it — the menu,
   sales, and reports are now live and private to that vendor.

---

## How data isolation works

Every vendor gets one row in `vendors` and one row in `profiles` linking their
login (`auth.users.id`) to their vendor. All business tables
(`menu_items`, `sales`, `closed_days`, `drawer_state`) carry a `vendor_id`
column.

Security is enforced **in the database** with Row Level Security (RLS), not in
app code:

- A helper function `my_vendor()` looks up which vendor the signed-in user
  belongs to.
- Every policy says, in effect: *"you may only touch rows whose `vendor_id`
  equals `my_vendor()`."* SELECT, INSERT, UPDATE, and DELETE all check this,
  so even a hand-crafted API call can't read or change another vendor's data.
- A user can only see their **own** `profiles` row — never another user's.
- Vendors can INSERT a new vendor row during signup (before their profile
  row exists) but can only SELECT/UPDATE the vendor they belong to.
- Signed-out (anonymous) requests see nothing at all — no policies allow them.

Because the rules live in Postgres itself, the static PWA needs no backend
code: the Supabase JS client just sends the user's login token, and the
database filters everything automatically.

---

## Troubleshooting

**"I see no menu after signup."**
The RLS policies probably didn't install. Re-run step 2: paste all of
`schema.sql` into SQL Editor and Run, and look for "Success" (not an error).
Then check **Authentication → Policies** in the dashboard — you should see
policies listed on all six tables.

**"Login loops / it keeps asking me to sign in."**
The anon key in `js/config.js` is wrong or stale. Re-copy the **`anon`
public** key from Project Settings → API (not the `service_role` key), paste
it in, and redeploy.

**"Signup says email confirmation required."**
You skipped step 3. Go to Authentication → Providers → Email and turn OFF
"Confirm email".

**"I signed up but my vendor name didn't save."**
Signup creates the vendor row first, then the profile row linking to it. If
the vendor INSERT policy didn't run (step 2 incomplete), the second step
fails silently. Re-run the full `schema.sql`.

**"I see another vendor's data."**
This should be impossible with RLS on. First confirm step 2 ran with
"Success". Then see the **RLS VERIFICATION** block at the bottom of
`schema.sql` — it has copy-paste queries that prove each vendor only sees
their own rows.
