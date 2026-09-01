-- 20: Multi-load projects -- the second load's booking.
--
-- A quote bigger than one truckload (see truck_capacity) can be scheduled as
-- two loads: on a second truck at the same or a staggered time (these columns),
-- or back-to-back on one truck (no columns needed -- one long event).
-- Idempotent: safe to re-run.

alter table quotes add column if not exists crew2_id           text references crews(id);
alter table quotes add column if not exists scheduled_time2    time;
alter table quotes add column if not exists calendar_event_id2 text;
