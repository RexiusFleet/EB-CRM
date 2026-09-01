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
