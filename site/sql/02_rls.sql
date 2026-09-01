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
