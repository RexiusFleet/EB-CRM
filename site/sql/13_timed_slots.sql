-- ============================================================================
-- Timed bookings: an event occupies a slot, not a whole day.
--
-- The earlier all-day choice came from the data (only ~13% of historical jobs
-- carried a clock time worth trusting). Taylor overruled it, reasonably: the
-- crew's day has a shape, and a 4-hour job should look like 4 hours. The
-- DURATION is not invented -- it defaults to the quote's own equipment hours,
-- which is drive + blow time, the hours the crew is actually out.
--
-- A booking with no start time still falls back to an all-day event, so nothing
-- existing breaks and a rep who does not care about times does not have to pick
-- one.
--
-- Run after 12_apps_script.sql. Safe to re-run.
-- ============================================================================

alter table quotes add column if not exists scheduled_time  time;           -- job start, local
alter table quotes add column if not exists scheduled_hours numeric(5,2);   -- slot length

comment on column quotes.scheduled_time is
  'Start of the calendar slot, America/Los_Angeles. Null = all-day event.';
comment on column quotes.scheduled_hours is
  'Length of the calendar slot in hours. Defaults from equip_hours (drive + blow).';

-- Check:
-- select id, scheduled_date, scheduled_time, scheduled_hours from quotes
--  where scheduled_date is not null order by scheduled_date desc limit 5;
