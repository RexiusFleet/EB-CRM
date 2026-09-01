-- 21: Application depth on the quote. 2" is the standard; the dropdown in the
-- app records what this job is being quoted at, and it prints on the calendar
-- event next to the volume. Idempotent.
alter table quotes add column if not exists depth_in numeric(4,1);
