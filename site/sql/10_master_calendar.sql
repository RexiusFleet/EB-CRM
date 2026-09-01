-- ============================================================================
-- One master calendar for all crews.
--
-- Replaces the calendar-per-crew arrangement in 09_scheduling.sql. Every job
-- lands on a single calendar; the crew is carried on the event -- in the title,
-- in a Google colour, and in a machine-readable property the app filters on --
-- rather than by which calendar it sits in.
--
-- Why this is the better shape for you: one calendar to create, one to share,
-- one to look at when you want the whole week. Crews get *read* access to it
-- (See all event details), so a foreman can see the day without being able to
-- move jobs around. Adding crew #3 later needs no new calendar at all.
--
-- Run after 09_scheduling.sql. Safe to re-run.
-- ============================================================================

-- ------------------------------------------------------------- text settings
-- The existing `settings` table is numeric(12,4) -- fine for markup, useless
-- for a calendar ID. This is its text sibling.
create table if not exists app_config (
  key        text primary key,
  value      text,
  note       text,
  updated_at timestamptz default now()
);

alter table app_config enable row level security;

drop policy if exists app_config_read on app_config;
create policy app_config_read on app_config
  for select to authenticated using (true);

drop policy if exists app_config_write on app_config;
create policy app_config_write on app_config
  for all to authenticated using (is_admin()) with check (is_admin());

-- Rexius's blower schedule calendar, and the service account that writes to it.
-- Neither is a credential -- they are identifiers, safe to keep in the repo. The
-- *key* for that service account lives only in the Supabase GOOGLE_SERVICE_ACCOUNT
-- secret and must never appear here or in the app.
insert into app_config (key, value, note) values
  ('master_calendar_id',
   'c_a3dfbea95d5ba6cbf5f7abfb741c05c98c5b296ca24ae2513c48b02561a3abf5@group.calendar.google.com',
   'Google Calendar ID every crew''s jobs are written to. Google Calendar -> '
   '(calendar) -> Settings -> Integrate calendar -> Calendar ID.'),
  ('service_account_email',
   'eb-scheduler@eb-master-schedule.iam.gserviceaccount.com',
   'Reference only -- the Edge Function reads the identity from its key secret. '
   'Kept here so you can see at a glance who the calendar must be shared with.'),
  ('hold_color_id', '8',
   'Google colorId for unapproved HOLD events. Graphite by default: on a shared '
   'calendar, approved-or-not is the distinction that matters most at a glance, '
   'so holds take one grey colour rather than the crew colour.')
on conflict (key) do nothing;   -- never clobber an ID you have already pasted in

-- ------------------------------------------------------- crew colours, not IDs
-- Google's calendar palette, by colorId. These are the event colours a crew is
-- recognised by on the shared calendar.
--    1 Lavender  2 Sage     3 Grape    4 Flamingo  5 Banana   6 Tangerine
--    7 Peacock   8 Graphite 9 Blueberry 10 Basil   11 Tomato
alter table crews add column if not exists calendar_color_id text;

update crews set calendar_color_id = '10' where id = '1' and calendar_color_id is null; -- Basil
update crews set calendar_color_id = '6'  where id = '2' and calendar_color_id is null; -- Tangerine

-- ---------------------------------------------------- retire the per-crew IDs
-- crews.calendar_id stays in the table as a deliberate override: leave it null
-- and the crew's jobs go on the master calendar, which is what you want. Set it
-- and that one crew gets its own calendar again.
--
-- The leftover IDs from the two-calendar setup have to be cleared or bookings
-- keep quietly splitting across calendars. But this file is re-runnable, and a
-- blind `update ... set calendar_id = null` would also wipe an override you
-- deliberately set months from now. So it runs exactly once, marked here.
do $$
begin
  if not exists (select 1 from app_config where key = 'per_crew_calendars_retired') then
    update crews set calendar_id = null where calendar_id is not null;
    insert into app_config (key, value, note) values
      ('per_crew_calendars_retired', 'true',
       'Set by 10_master_calendar.sql. Its one-time clearing of crews.calendar_id '
       'has already run; re-running the file will not touch overrides again.');
  end if;
end $$;

comment on column crews.calendar_id is
  'Override only. Null = use app_config.master_calendar_id (the normal case).';

-- Paste the master Calendar ID in:
--   update app_config set value = 'xxxx@group.calendar.google.com',
--                         updated_at = now()
--    where key = 'master_calendar_id';

-- Check:
-- select key, value from app_config;
-- select id, name, calendar_color_id, calendar_id from crews order by sort_order;
