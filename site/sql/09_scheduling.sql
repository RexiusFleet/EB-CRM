-- ============================================================================
-- Scheduling: crews, their Google calendars, and the booking on a quote.
--
-- Crews live in a table rather than in the app so adding, renaming or retiring
-- one is a row edit, not a redeploy. Your history shows crews #1 and #2 doing
-- almost all the work (1,099 and 1,240 jobs), #3 tailing off at 564 and #4 at
-- 34 -- so the set clearly changes over time.
--
-- Run after 00_setup_all.sql. Safe to re-run.
-- ============================================================================

create table if not exists crews (
  id            text primary key,          -- '1', '2', ... matches the ERP's "#N"
  name          text not null,             -- 'Crew #1'
  calendar_id   text,                      -- Google Calendar ID, e.g. abc@group.calendar.google.com
  color         text,                      -- for the UI only
  active        boolean default true,
  sort_order    int default 0,
  -- Capacity thresholds, per crew, used to warn before overbooking.
  -- Defaults come from your own history: median 2.25 equip hr and 1 job per
  -- crew-day; only 3.5% of crew-days exceed 8 equipment hours.
  max_equip_hours numeric(6,2) default 8,
  max_jobs        int default 4,
  updated_at    timestamptz default now()
);

alter table crews enable row level security;

drop policy if exists crews_read on crews;
create policy crews_read on crews
  for select to authenticated using (true);

drop policy if exists crews_write on crews;
create policy crews_write on crews
  for all to authenticated using (is_admin()) with check (is_admin());

-- Two active crews today. Paste the Calendar IDs from
-- Google Calendar -> (calendar) -> Settings -> Integrate calendar -> Calendar ID.
insert into crews (id, name, calendar_id, color, active, sort_order) values
  ('1', 'Crew #1', null, '#2f6b3c', true, 1),
  ('2', 'Crew #2', null, '#a8620f', true, 2)
on conflict (id) do update
  set name = excluded.name,
      color = excluded.color,
      active = excluded.active,
      sort_order = excluded.sort_order;
-- NB: calendar_id is deliberately NOT overwritten on re-run, so re-running this
-- file never wipes IDs you have already pasted in.

-- ---------------------------------------------------------------- the booking
alter table quotes add column if not exists scheduled_date     date;
alter table quotes add column if not exists crew_id            text references crews(id);
alter table quotes add column if not exists calendar_event_id  text;
alter table quotes add column if not exists calendar_id        text;
alter table quotes add column if not exists scheduled_at       timestamptz;
alter table quotes add column if not exists scheduled_by       uuid;

create index if not exists idx_quotes_sched on quotes(scheduled_date, crew_id);
create index if not exists idx_quotes_event on quotes(calendar_event_id);

-- ------------------------------------------------------- crew load, read-only
-- What the app asks before letting a rep promise a date. Counts only quotes
-- this system booked; the Edge Function additionally reads the real calendar,
-- which is the authority (someone may have added a job in Google directly).
create or replace view crew_day_load
with (security_invoker = on) as
select
  q.crew_id,
  q.scheduled_date,
  count(*)                                as jobs,
  coalesce(sum(q.equip_hours), 0)::numeric(8,2) as equip_hours,
  coalesce(sum(q.labor_hours), 0)::numeric(8,2) as labor_hours,
  coalesce(sum(q.yards), 0)::numeric(10,2)      as yards
from quotes q
where q.scheduled_date is not null
  and q.crew_id is not null
  and q.status <> 'lost'
group by q.crew_id, q.scheduled_date;

grant select on crew_day_load to authenticated;

-- Check:
-- select * from crews;
-- select * from crew_day_load order by scheduled_date desc limit 10;
