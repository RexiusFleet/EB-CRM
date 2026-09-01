-- ============================================================================
-- Rexius Blower Quote CRM -- COMPLETE SETUP / REPAIR
--
-- Run this ONE file in the Supabase SQL editor. It is everything except the
-- CSV import, in dependency order, and it is safe to run as many times as you
-- like.
--
-- Why one file: the SQL editor runs a script as a single transaction. If you
-- run the pieces out of order, one statement fails and the ENTIRE script rolls
-- back -- including the rate card, which then reads as "it said success but I
-- have no products". Running this file removes that failure mode.
--
-- ORDER OF OPERATIONS
--   1. this file
--   2. import the CSVs (README step 4)
--   3. sql/06_erp_products.sql   <- needs the orders data to exist
--
-- At the end it prints a row count for every table so you can see what landed.
-- ============================================================================


-- ############################################################################
-- ## SCHEMA
-- ## (from 01_schema.sql)
-- ############################################################################
-- ============================================================================
-- Rexius Blower Quote CRM -- Supabase schema
-- Run this ONCE in the Supabase SQL editor before importing any CSVs.
-- ============================================================================

create extension if not exists pg_trgm;      -- fast fuzzy address search

-- ---------------------------------------------------------------- reference
-- Everything in this section is READ-ONLY history. It is reference material
-- for the rep; it never feeds the quote arithmetic.

create table if not exists customers (
  cust_id           text primary key,
  customer_name     text,
  customer_class    text,
  cust_status       text,
  phone             text,
  email             text,
  bill_addr1        text,
  bill_city         text,
  bill_state        text,
  bill_zip          text,
  sales_person_id   text
);

create table if not exists sites (
  site_key    text primary key,   -- normalized "house-number street-name"
  address1    text,
  address2    text,
  city        text,
  state       text,
  zip         text,
  attention   text,
  phone       text
);

create table if not exists orders (
  ord_nbr            text primary key,
  ord_date           date,
  dlvry_date         date,
  cust_id            text,
  customer_name      text,
  customer_class     text,
  site_key           text,
  ship_addr1         text,
  ship_city          text,
  ship_state         text,
  ship_zip           text,
  sales_person_id    text,
  invc_nbr           text,
  invc_tot           numeric(12,2),
  order_type         text,          -- 'blow_in' | 'bulk_or_other'
  primary_product    text,          -- raw ERP description, as typed
  product            text,          -- canonicalised to a rate_card product name
  primary_invt_id    text,
  primary_unit       text,
  total_yards        numeric(10,2),
  labor_hours        numeric(10,2),
  equip_hours        numeric(10,2),
  material_ext       numeric(12,2),
  labor_ext          numeric(12,2),
  equip_ext          numeric(12,2),
  discount_ext       numeric(12,2),
  fee_ext            numeric(12,2),
  labor_hr_per_yard  numeric(10,4),
  equip_hr_per_yard  numeric(10,4),
  sum_descr          text,
  spcl_inst          text,
  time_range         text,
  note_sqft          numeric(12,2),
  note_depth_in      numeric(6,3),
  note_yards         numeric(10,2),
  qty_mismatch       boolean default false,
  discounts_json     jsonb
);

create table if not exists order_lines (
  id          bigserial primary key,
  ord_nbr     text references orders(ord_nbr) on delete cascade,
  line_nbr    text,
  line_kind   text,        -- material | labor | equipment | discount | fee
  invt_id     text,
  descr       text,
  qty         numeric(12,4),
  unit        text,
  unit_price  numeric(12,4),
  ext_price   numeric(12,2),
  rev_acct    text
);

-- Bids from the pricing workbook, including ones that never became orders.
create table if not exists quote_history (
  id              bigserial primary key,
  source_row      int,
  quote_date      date,
  sales_person    text,
  customer_name   text,
  phone           text,
  email           text,
  address_raw     text,
  city            text,
  zip             text,
  site_key        text,
  product         text,
  yards           numeric(10,2),
  prep_hours      numeric(6,2),
  drive_hours     numeric(6,2),
  blow_hours      numeric(6,2),
  helpers         numeric(4,2),
  labor_hours     numeric(8,2),
  equip_hours     numeric(8,2),
  projected_cost  numeric(12,2),
  target_price    numeric(12,2),
  bid_amount      numeric(12,2),
  material_rev    numeric(12,2),
  labor_rev       numeric(12,2),
  equip_rev       numeric(12,2),
  notes           text
);

-- ------------------------------------------------------------- rate card
-- THIS is what prices a quote. Admin-editable; history never overrides it.

create table if not exists rate_card (
  product         text primary key,
  erp_code        text,
  category        text,            -- bark | soil_compost | rock | other
  unit_cost       numeric(12,4),   -- cost per truck unit
  yards_per_unit  numeric(6,2) default 7.5,
  cost_per_yard   numeric(12,4) generated always as
                    (case when yards_per_unit > 0
                          then unit_cost / yards_per_unit end) stored,
  needs_cost      boolean default false,   -- true = quoting blocked, set a cost
  active          boolean default true,
  source          text,
  updated_at      timestamptz default now(),
  updated_by      uuid
);

create table if not exists markup_curve (
  min_yards  numeric(8,2) primary key,
  markup     numeric(6,4) not null
);

create table if not exists settings (
  key    text primary key,
  value  numeric(12,4) not null,
  note   text
);

-- ------------------------------------------------- estimator benchmarks
-- Derived from history by the ETL. Refresh by re-importing; the app treats
-- these as inputs to the HOUR estimate only, never to price.

create table if not exists blow_benchmarks (
  product                  text,
  volume_band              text,   -- 1-10 | 11-20 | 21-35 | 36-60 | 60+ | ALL
  n                        int,
  blow_hr_per_yard_p25     numeric(10,4),
  blow_hr_per_yard_median  numeric(10,4),
  blow_hr_per_yard_p75     numeric(10,4),
  source                   text,   -- erp_equipment_hours | quote_blow_hours
  primary key (product, volume_band)
);

create table if not exists drive_zones (
  zone_type           text,        -- city | zip | default
  zone_key            text,
  n                   int,
  drive_hours_p25     numeric(8,2),
  drive_hours_median  numeric(8,2),
  drive_hours_p75     numeric(8,2),
  primary key (zone_type, zone_key)
);

-- ------------------------------------------------------------ live quotes

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  initials    text,
  is_admin    boolean default false,
  created_at  timestamptz default now()
);

create table if not exists quotes (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  created_by        uuid references auth.users(id),
  rep_name          text,
  status            text default 'draft',   -- draft | sent | won | lost
  customer_name     text,
  phone             text,
  email             text,
  address_raw       text,
  city              text,
  zip               text,
  site_key          text,
  cust_id           text,

  product           text,
  yards             numeric(10,2),

  prep_hours        numeric(6,2),
  drive_hours       numeric(6,2),
  blow_hours        numeric(6,2),
  helpers           numeric(4,2),
  equip_hours       numeric(8,2),
  labor_hours       numeric(8,2),
  prevailing_wage   boolean default false,

  -- what the estimator suggested, kept alongside what the rep actually used
  est_drive_hours   numeric(6,2),
  est_blow_hours    numeric(6,2),
  est_basis         jsonb,

  cost_per_yard     numeric(12,4),
  material_cost     numeric(12,2),
  labor_cost        numeric(12,2),
  equip_cost        numeric(12,2),
  overhead          numeric(12,2),
  total_cost        numeric(12,2),
  markup            numeric(6,4),
  target_price      numeric(12,2),
  bid_amount        numeric(12,2),
  material_rev      numeric(12,2),
  labor_rev         numeric(12,2),
  equip_rev         numeric(12,2),
  gross_margin      numeric(8,4),

  notes             text
);

-- ---------------------------------------------------------------- indexes

create index if not exists idx_orders_site      on orders(site_key);
create index if not exists idx_orders_cust      on orders(cust_id);
create index if not exists idx_orders_date      on orders(ord_date desc);
create index if not exists idx_orders_product   on orders(primary_product, total_yards);
create index if not exists idx_orders_canon     on orders(product, total_yards);
create index if not exists idx_lines_ord        on order_lines(ord_nbr);
create index if not exists idx_qh_site          on quote_history(site_key);
create index if not exists idx_qh_product       on quote_history(product, yards);
create index if not exists idx_qh_date          on quote_history(quote_date desc);
create index if not exists idx_quotes_site      on quotes(site_key);
create index if not exists idx_quotes_created   on quotes(created_at desc);
create index if not exists idx_quotes_by        on quotes(created_by);

-- trigram indexes make "type any part of the address" search fast
create index if not exists idx_sites_addr_trgm
  on sites using gin (lower(address1) gin_trgm_ops);
create index if not exists idx_orders_cust_trgm
  on orders using gin (lower(customer_name) gin_trgm_ops);
create index if not exists idx_qh_cust_trgm
  on quote_history using gin (lower(coalesce(customer_name,'')) gin_trgm_ops);
create index if not exists idx_qh_addr_trgm
  on quote_history using gin (lower(coalesce(address_raw,'')) gin_trgm_ops);

-- ------------------------------------------------------------ auto-profile
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists quotes_touch on quotes;
create trigger quotes_touch before update on quotes
  for each row execute function touch_updated_at();


-- ############################################################################
-- ## ROW LEVEL SECURITY
-- ## (from 02_rls.sql)
-- ############################################################################
-- ============================================================================
-- Row Level Security
--
-- Shape of the policy set:
--   * Nothing is readable to the public. Every read requires a logged-in user.
--   * Reference history (customers, sites, orders, order_lines, quote_history,
--     benchmarks) is READ-ONLY to reps. No insert/update/delete policy exists
--     for them at all, so those writes are denied by default.
--   * The rate card, markup curve and settings are readable by every rep but
--     writable only by an admin -- a rep must not be able to move a price.
--   * Reps write their own quotes and can edit their own. Everyone can READ
--     all quotes (that is the point of a shared CRM); only the author or an
--     admin can change or delete one.
--
-- Run AFTER 01_schema.sql. Safe to re-run.
-- ============================================================================

alter table customers       enable row level security;
alter table sites           enable row level security;
alter table orders          enable row level security;
alter table order_lines     enable row level security;
alter table quote_history   enable row level security;
alter table rate_card       enable row level security;
alter table markup_curve    enable row level security;
alter table settings        enable row level security;
alter table blow_benchmarks enable row level security;
alter table drive_zones     enable row level security;
alter table profiles        enable row level security;
alter table quotes          enable row level security;

-- helper: is the caller an admin?
create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------- read-only reference
do $$
declare t text;
begin
  foreach t in array array['customers','sites','orders','order_lines',
                           'quote_history','blow_benchmarks','drive_zones']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_read', t);
  end loop;
end $$;

-- ------------------------------------------- rate card / markup / settings
-- readable by all reps, writable only by admins
do $$
declare t text;
begin
  foreach t in array array['rate_card','markup_curve','settings']
  loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format(
      'create policy %I on %I for select to authenticated using (true)',
      t || '_read', t);
    execute format(
      'create policy %I on %I for all to authenticated using (is_admin()) with check (is_admin())',
      t || '_write', t);
  end loop;
end $$;

-- ------------------------------------------------------------- profiles
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles
  for select to authenticated using (true);

drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles
  for update to authenticated
  using (id = auth.uid() or is_admin())
  with check (id = auth.uid() or is_admin());

-- --------------------------------------------------------------- quotes
drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes
  for select to authenticated using (true);

drop policy if exists quotes_insert on quotes;
create policy quotes_insert on quotes
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes
  for update to authenticated
  using (created_by = auth.uid() or is_admin())
  with check (created_by = auth.uid() or is_admin());

drop policy if exists quotes_delete on quotes;
create policy quotes_delete on quotes
  for delete to authenticated
  using (created_by = auth.uid() or is_admin());

-- ------------------------------------------------------------------ notes
-- To make someone an admin, after they have signed up once:
--   update profiles set is_admin = true where full_name = 'taylora@rexius.com';
--
-- The anon key shipped in the HTML grants NOTHING on its own -- every policy
-- above requires `authenticated`. A logged-out visitor sees an empty database.


-- ############################################################################
-- ## REFERENCE DATA (rate card, markup, settings, benchmarks)
-- ## (from 03_seed_reference.sql)
-- ############################################################################
-- ============================================================================
-- Reference/config seed data. Run AFTER 01_schema.sql.
-- Safe to re-run: every insert upserts.
--
-- The BIG tables (customers, sites, orders, order_lines, quote_history) are
-- loaded from CSV instead -- see README, step 4.
--
-- IMPORTANT: the SQL editor runs a whole script as ONE transaction, so a single
-- failing statement rolls back everything above it -- including the rate card,
-- which then looks like "the seed ran but no products appeared". These guards
-- make the script independent of which other migrations have been run yet.
-- ============================================================================

alter table blow_benchmarks add column if not exists source  text;
alter table orders          add column if not exists product text;

-- rate_card (30 rows)
insert into rate_card (product, erp_code, category, unit_cost, yards_per_unit, needs_cost, active, source) values
  ('Econo-Bark', '321', 'bark', 65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('BeautiBark', '322', 'bark', 111.7711, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Hemlock', '020', 'bark', 224.25, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('UltraKote', '040', 'bark', 283.9959, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('DecoBark Nuggets', '004', 'bark', 243.75, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Extra Fine Bark', '002', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Garden Mulch', '032', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Fiberex', '301', 'bark', 98.7764, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Fresh Sawdust', '300', 'bark', 120, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Alder Sawdust', null, 'bark', 75.5, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Commercial Hog', '324', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Primary Planting Soil', '180', 'soil_compost', 214.25, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Tree-n-Shrub', '106', 'soil_compost', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Flower-n-Garden', '100', 'soil_compost', 317.76, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Turf Start', '107', 'soil_compost', 255.9, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Patio Potting Soil', '105', 'soil_compost', 277.65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Garden Compost', '907', 'soil_compost', 127.7323, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GVO Compost', '907', 'soil_compost', 127.7323, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Steer Plus', '121', 'soil_compost', 228.3565, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GV Natural & Organic P.S.', '103', 'soil_compost', 422, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus Zero', '103', 'soil_compost', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #1', '103', 'soil_compost', 857, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #2', '103', 'soil_compost', 860, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #3', '103', 'soil_compost', 842, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus Bio Tope', '103', 'soil_compost', 504, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GVO w/Worm Castings', '103', 'soil_compost', 690, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/4" round rock from RiverBend', null, 'rock', 120.9, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/8" round rock from RiverBend', null, 'rock', 247.65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Quarter Ten from RiverBend', null, 'rock', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/4" open quarry from Coburg Quarry', null, 'rock', 234, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs')
on conflict (product) do update set erp_code = excluded.erp_code, category = excluded.category, unit_cost = excluded.unit_cost, yards_per_unit = excluded.yards_per_unit, needs_cost = excluded.needs_cost, active = excluded.active, source = excluded.source;

-- markup_curve (5 rows)
insert into markup_curve (min_yards, markup) values
  (3, 0.2),
  (4, 0.1),
  (5, 0.02),
  (17, 0.03),
  (45, 0.02)
on conflict (min_yards) do update set markup = excluded.markup;

-- settings (11 rows)
insert into settings (key, value, note) values
  ('labor_rate_blended', 27.5, '$/hr; avg(driver 30, helper 25) - Quote Calculator K14'),
  ('driver_wage', 30.0, '$/hr - Quote Calculator I13'),
  ('helper_wage', 25.0, '$/hr - Quote Calculator I19'),
  ('prevailing_wage', 70.0, '$/hr; replaces both wages when PW job - I12/I18'),
  ('equipment_rate', 85.0, '$/hr - Quote Calculator I22'),
  ('overhead_per_yard', 25.0, '$/yd, applied when yards < threshold - I23'),
  ('overhead_per_equip_hour', 145.0, '$/equip-hr, applied at/above threshold - I24'),
  ('overhead_yard_threshold', 16.0, 'yards; below = per-yard OH, at/above = hourly OH'),
  ('prep_hours_default', 0.5, 'hr; constant on 1974/2024 saved quotes'),
  ('helpers_default', 1.0, 'crew helpers; 1 on 1870/2024 saved quotes'),
  ('yards_per_unit', 7.5, 'yards per truck unit')
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- blow_benchmarks (86 rows)
delete from blow_benchmarks;
insert into blow_benchmarks (product, volume_band, n, blow_hr_per_yard_p25, blow_hr_per_yard_median, blow_hr_per_yard_p75, source) values
  ('3/4" open quarry from Coburg Quarry', '1-10', 86, 0.1667, 0.2143, 0.2812, 'erp_equipment_hours'),
  ('3/4" open quarry from Coburg Quarry', '11-20', 10, 0.1562, 0.2, 0.2031, 'erp_equipment_hours'),
  ('3/4" open quarry from Coburg Quarry', 'ALL', 98, 0.1667, 0.2031, 0.25, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', '1-10', 108, 0.1667, 0.2222, 0.2778, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', '11-20', 13, 0.1875, 0.2045, 0.25, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', 'ALL', 123, 0.1667, 0.2188, 0.2778, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', '1-10', 52, 0.1667, 0.2222, 0.3, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', '11-20', 6, 0.1875, 0.1964, 0.2188, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', 'ALL', 62, 0.15, 0.1944, 0.2778, 'erp_equipment_hours'),
  ('BeautiBark', '1-10', 143, 0.125, 0.1667, 0.2143, 'erp_equipment_hours'),
  ('BeautiBark', '11-20', 233, 0.0833, 0.1, 0.125, 'erp_equipment_hours'),
  ('BeautiBark', '21-35', 672, 0.0662, 0.0809, 0.1, 'erp_equipment_hours'),
  ('BeautiBark', '36-60', 54, 0.0608, 0.075, 0.09, 'erp_equipment_hours'),
  ('BeautiBark', '60+', 34, 0.0515, 0.0703, 0.0977, 'erp_equipment_hours'),
  ('BeautiBark', 'ALL', 1136, 0.0703, 0.0893, 0.1167, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '1-10', 5, 0.1111, 0.125, 0.1667, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '11-20', 9, 0.0833, 0.1029, 0.1136, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '21-35', 6, 0.0673, 0.0682, 0.0857, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '36-60', 3, 0.0338, 0.0338, 0.0405, 'erp_equipment_hours'),
  ('DecoBark Nuggets', 'ALL', 23, 0.0682, 0.0875, 0.1111, 'erp_equipment_hours'),
  ('Econo-Bark', '1-10', 40, 0.125, 0.1562, 0.25, 'erp_equipment_hours'),
  ('Econo-Bark', '11-20', 39, 0.0769, 0.1, 0.1364, 'erp_equipment_hours'),
  ('Econo-Bark', '21-35', 106, 0.0543, 0.0673, 0.087, 'erp_equipment_hours'),
  ('Econo-Bark', '36-60', 22, 0.0405, 0.0473, 0.0761, 'erp_equipment_hours'),
  ('Econo-Bark', '60+', 28, 0.0404, 0.0625, 0.0742, 'erp_equipment_hours'),
  ('Econo-Bark', 'ALL', 235, 0.0543, 0.0774, 0.1111, 'erp_equipment_hours'),
  ('Extra Fine Bark', '11-20', 4, 0.1, 0.15, 0.15, 'erp_equipment_hours'),
  ('Extra Fine Bark', '21-35', 11, 0.0833, 0.1023, 0.11, 'erp_equipment_hours'),
  ('Extra Fine Bark', 'ALL', 17, 0.08, 0.1, 0.11, 'erp_equipment_hours'),
  ('Fiberex', '1-10', 74, 0.1, 0.1333, 0.2, 'erp_equipment_hours'),
  ('Fiberex', '11-20', 101, 0.0526, 0.0667, 0.0833, 'erp_equipment_hours'),
  ('Fiberex', '21-35', 103, 0.0429, 0.05, 0.06, 'erp_equipment_hours'),
  ('Fiberex', '36-60', 347, 0.0338, 0.0375, 0.05, 'erp_equipment_hours'),
  ('Fiberex', '60+', 26, 0.0319, 0.0375, 0.0407, 'erp_equipment_hours'),
  ('Fiberex', 'ALL', 651, 0.0375, 0.0473, 0.0667, 'erp_equipment_hours'),
  ('Flower-n-Garden', '1-10', 89, 0.1389, 0.1875, 0.25, 'erp_equipment_hours'),
  ('Flower-n-Garden', '11-20', 52, 0.0938, 0.1167, 0.1364, 'erp_equipment_hours'),
  ('Flower-n-Garden', '21-35', 3, 0.0761, 0.0833, 0.1042, 'erp_equipment_hours'),
  ('Flower-n-Garden', 'ALL', 144, 0.1176, 0.15, 0.2045, 'erp_equipment_hours'),
  ('Fresh Sawdust', '11-20', 5, 0.0667, 0.0667, 0.0667, 'erp_equipment_hours'),
  ('Fresh Sawdust', '36-60', 3, 0.05, 0.05, 0.05, 'erp_equipment_hours'),
  ('Fresh Sawdust', 'ALL', 11, 0.05, 0.0667, 0.0938, 'erp_equipment_hours'),
  ('GVO Compost', '1-10', 22, 0.1667, 0.2, 0.3125, 'erp_equipment_hours'),
  ('GVO Compost', '11-20', 30, 0.0875, 0.1333, 0.1667, 'erp_equipment_hours'),
  ('GVO Compost', '21-35', 16, 0.0833, 0.1087, 0.125, 'erp_equipment_hours'),
  ('GVO Compost', '36-60', 4, 0.1118, 0.1222, 0.1222, 'erp_equipment_hours'),
  ('GVO Compost', 'ALL', 72, 0.1053, 0.1375, 0.1944, 'erp_equipment_hours'),
  ('Garden Compost', '1-10', 21, 0.15, 0.175, 0.2, 'erp_equipment_hours'),
  ('Garden Compost', '11-20', 77, 0.0781, 0.0909, 0.1071, 'erp_equipment_hours'),
  ('Garden Compost', '21-35', 55, 0.0625, 0.08, 0.1087, 'erp_equipment_hours'),
  ('Garden Compost', '36-60', 13, 0.075, 0.09, 0.0978, 'erp_equipment_hours'),
  ('Garden Compost', 'ALL', 167, 0.075, 0.0909, 0.12, 'erp_equipment_hours'),
  ('Garden Mulch', '11-20', 6, 0.1, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Garden Mulch', 'ALL', 6, 0.1, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Hemlock', '1-10', 282, 0.1429, 0.1786, 0.25, 'erp_equipment_hours'),
  ('Hemlock', '11-20', 341, 0.0938, 0.1111, 0.1364, 'erp_equipment_hours'),
  ('Hemlock', '21-35', 335, 0.0761, 0.0909, 0.1136, 'erp_equipment_hours'),
  ('Hemlock', '36-60', 30, 0.0815, 0.0946, 0.1316, 'erp_equipment_hours'),
  ('Hemlock', '60+', 4, 0.0761, 0.0938, 0.0938, 'erp_equipment_hours'),
  ('Hemlock', 'ALL', 992, 0.09, 0.1167, 0.1591, 'erp_equipment_hours'),
  ('Opus #1', '11-20', 3, 0.0875, 0.15, 0.1818, 'erp_equipment_hours'),
  ('Opus #1', 'ALL', 7, 0.0929, 0.15, 0.1818, 'erp_equipment_hours'),
  ('Primary Planting Soil', '1-10', 23, 0.1364, 0.15, 0.1875, 'erp_equipment_hours'),
  ('Primary Planting Soil', '11-20', 43, 0.0909, 0.1094, 0.1429, 'erp_equipment_hours'),
  ('Primary Planting Soil', '21-35', 17, 0.0682, 0.0795, 0.1, 'erp_equipment_hours'),
  ('Primary Planting Soil', '36-60', 3, 0.0543, 0.1, 0.1187, 'erp_equipment_hours'),
  ('Primary Planting Soil', 'ALL', 86, 0.0875, 0.1111, 0.15, 'erp_equipment_hours'),
  ('Quarter Ten from RiverBend', '1-10', 18, 0.2188, 0.25, 0.3333, 'erp_equipment_hours'),
  ('Quarter Ten from RiverBend', 'ALL', 21, 0.2188, 0.25, 0.3125, 'erp_equipment_hours'),
  ('Steer Plus', '11-20', 12, 0.1, 0.1111, 0.1176, 'erp_equipment_hours'),
  ('Steer Plus', 'ALL', 16, 0.1, 0.1125, 0.1304, 'erp_equipment_hours'),
  ('Tree-n-Shrub', '1-10', 9, 0.1, 0.15, 0.2, 'erp_equipment_hours'),
  ('Tree-n-Shrub', '11-20', 13, 0.0833, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Tree-n-Shrub', 'ALL', 22, 0.0938, 0.1071, 0.15, 'erp_equipment_hours'),
  ('Turf Start', '1-10', 60, 0.1429, 0.2, 0.25, 'erp_equipment_hours'),
  ('Turf Start', '11-20', 132, 0.0938, 0.1167, 0.1429, 'erp_equipment_hours'),
  ('Turf Start', '21-35', 25, 0.1, 0.1083, 0.125, 'erp_equipment_hours'),
  ('Turf Start', '36-60', 3, 0.0875, 0.0933, 0.1333, 'erp_equipment_hours'),
  ('Turf Start', 'ALL', 220, 0.1, 0.125, 0.1667, 'erp_equipment_hours'),
  ('UltraKote', '1-10', 30, 0.125, 0.1667, 0.25, 'erp_equipment_hours'),
  ('UltraKote', '11-20', 44, 0.1, 0.1053, 0.1333, 'erp_equipment_hours'),
  ('UltraKote', '21-35', 33, 0.0652, 0.087, 0.1087, 'erp_equipment_hours'),
  ('UltraKote', '36-60', 15, 0.0833, 0.0903, 0.1, 'erp_equipment_hours'),
  ('UltraKote', '60+', 5, 0.0751, 0.0751, 0.178, 'erp_equipment_hours'),
  ('UltraKote', 'ALL', 127, 0.0833, 0.1087, 0.1389, 'erp_equipment_hours'),
  ('Patio Potting Soil', 'ALL', 8, 0.0333, 0.1875, 0.25, 'quote_blow_hours')
on conflict (product, volume_band) do update set n = excluded.n, blow_hr_per_yard_p25 = excluded.blow_hr_per_yard_p25, blow_hr_per_yard_median = excluded.blow_hr_per_yard_median, blow_hr_per_yard_p75 = excluded.blow_hr_per_yard_p75, source = excluded.source;

-- drive_zones (21 rows)
delete from drive_zones;
insert into drive_zones (zone_type, zone_key, n, drive_hours_p25, drive_hours_median, drive_hours_p75) values
  ('city', 'Albany', 3, 1.5, 1.5, 3.0),
  ('city', 'Bend', 5, 4.0, 4.0, 5.0),
  ('city', 'Coburg', 22, 0.75, 0.75, 1.0),
  ('city', 'Coos Bay', 6, 5.0, 5.5, 6.0),
  ('city', 'Corvallis', 8, 2.5, 3.5, 3.5),
  ('city', 'Cottage Grove', 10, 2.0, 2.0, 3.0),
  ('city', 'Creswell', 11, 2.0, 2.0, 2.5),
  ('city', 'Eugene', 439, 1.0, 1.25, 1.5),
  ('city', 'Fall Creek', 4, 2.0, 2.0, 2.0),
  ('city', 'Florence', 3, 4.0, 5.0, 5.0),
  ('city', 'Goshen', 3, 1.5, 1.75, 2.0),
  ('city', 'Harrisburg', 13, 1.0, 1.25, 1.25),
  ('city', 'Junction City', 4, 2.0, 2.5, 2.5),
  ('city', 'Monroe', 4, 2.0, 3.5, 3.5),
  ('city', 'Roseburg', 5, 3.5, 4.0, 4.0),
  ('city', 'Salem', 3, 2.0, 2.5, 2.5),
  ('city', 'Springfield', 133, 1.25, 1.5, 2.0),
  ('city', 'Thurston', 3, 1.0, 1.5, 1.5),
  ('city', 'Veneta', 14, 1.5, 2.0, 2.25),
  ('zip', '97451', 3, 2.5, 2.5, 2.5),
  ('default', '*', 2243, 1.0, 1.5, 2.0)
on conflict (zone_type, zone_key) do update set n = excluded.n, drive_hours_p25 = excluded.drive_hours_p25, drive_hours_median = excluded.drive_hours_median, drive_hours_p75 = excluded.drive_hours_p75;


-- ############################################################################
-- ## SEARCH INDEX VIEW
-- ## (from 05_search_index.sql)
-- ############################################################################
-- ============================================================================
-- site_index -- one row per job site, for the search dropdown.
--
-- Collapses orders + quote_history into a single browsable list: the most
-- recent address/city/zip/customer for each site, how much work it has had,
-- and every name ever associated with it (so searching an old contact name
-- still finds the property).
--
-- Small enough (~3,400 rows) for the app to load once and filter instantly in
-- the browser, which is what lets the dropdown prepopulate and match words in
-- any order instead of requiring an exact substring.
--
-- Run AFTER 01_schema.sql and the CSV import. Safe to re-run.
-- ============================================================================

drop view if exists site_index;

create view site_index
-- security_invoker makes the view honour the CALLER's row level security.
-- Without it a view owned by the superuser bypasses RLS entirely and would
-- leak every customer to anonymous visitors.
with (security_invoker = on)
as
with u as (
  select site_key,
         nullif(btrim(ship_addr1),'')   as address1,
         nullif(btrim(ship_city),'')    as city,
         nullif(btrim(ship_zip),'')     as zip,
         nullif(btrim(customer_name),'') as customer_name,
         ord_date                        as dt,
         'order'::text                   as kind
    from orders
   where site_key is not null and btrim(site_key) <> ''
  union all
  select site_key,
         nullif(btrim(address_raw),''),
         nullif(btrim(city),''),
         nullif(btrim(zip),''),
         nullif(btrim(customer_name),''),
         quote_date,
         'quote'
    from quote_history
   where site_key is not null and btrim(site_key) <> ''
)
select
  site_key,
  (array_agg(address1 order by dt desc nulls last)
     filter (where address1 is not null))[1]                as address1,
  (array_agg(city order by dt desc nulls last)
     filter (where city is not null))[1]                    as city,
  (array_agg(zip order by dt desc nulls last)
     filter (where zip is not null))[1]                     as zip,
  (array_agg(customer_name order by dt desc nulls last)
     filter (where customer_name is not null))[1]           as customer_name,
  count(*) filter (where kind = 'order')                    as n_orders,
  count(*) filter (where kind = 'quote')                    as n_quotes,
  max(dt)                                                   as last_activity,
  -- every distinct name ever seen here, so an old contact still finds the site
  (select string_agg(distinct x.customer_name, ' | ')
     from u x where x.site_key = u.site_key)                as all_names
from u
group by site_key;

grant select on site_index to authenticated;

-- Sanity check:
-- select count(*) from site_index;
-- select * from site_index order by last_activity desc nulls last limit 5;


-- ############################################################################
-- ## VERIFY -- what actually landed
-- ############################################################################
do $$
declare
  r_rate int; r_mark int; r_set int; r_bench int; r_zone int;
  r_cust int; r_site int; r_ord int; r_line int; r_quote int; r_idx int;
begin
  select count(*) into r_rate  from rate_card;
  select count(*) into r_mark  from markup_curve;
  select count(*) into r_set   from settings;
  select count(*) into r_bench from blow_benchmarks;
  select count(*) into r_zone  from drive_zones;
  select count(*) into r_cust  from customers;
  select count(*) into r_site  from sites;
  select count(*) into r_ord   from orders;
  select count(*) into r_line  from order_lines;
  select count(*) into r_quote from quote_history;
  select count(*) into r_idx   from site_index;

  raise notice '';
  raise notice '=== SETUP COMPLETE ===';
  raise notice 'rate_card       %  (expect 30)', r_rate;
  raise notice 'markup_curve    %  (expect 5)',  r_mark;
  raise notice 'settings        %  (expect 11)', r_set;
  raise notice 'blow_benchmarks %  (expect 86)', r_bench;
  raise notice 'drive_zones     %  (expect 21)', r_zone;
  raise notice '--- imported from CSV (0 until you do README step 4) ---';
  raise notice 'customers       %  (expect 1823)',  r_cust;
  raise notice 'sites           %  (expect 2607)',  r_site;
  raise notice 'orders          %  (expect 4553)',  r_ord;
  raise notice 'order_lines     %  (expect 15109)', r_line;
  raise notice 'quote_history   %  (expect 2251)',  r_quote;
  raise notice 'site_index      %  (expect 3421)',  r_idx;

  if r_rate = 0 then
    raise notice '';
    raise notice '*** rate_card is EMPTY -- the product dropdown will be empty. ***';
  end if;
end $$;
