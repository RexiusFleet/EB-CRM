-- ============================================================================
-- Calendar events mirror the office's existing format.
--
--   Title:  #56-BeautiBark (11) Caulleen Massingale
--   Body:   name / phone / account / SO / PN, loads, volume, total,
--           notes, pre- and post-inspection form links.
--
-- Three of those numbers live in the ERP, not the quote -- so they become
-- quote fields (typed in when known; the event re-renders on every save).
-- Editing the event body BY HAND in Google does not stick: the app rewrites it
-- on the next save. Numbers belong on the quote.
--
-- Run after 14_trucks.sql. Safe to re-run.
-- ============================================================================

alter table quotes add column if not exists account_no text;   -- 02-0104761
alter table quotes add column if not exists so_no      text;   -- sales order
alter table quotes add column if not exists project_no text;   -- PN / project

insert into app_config (key, value, note) values
  ('pre_inspection_form',
   'https://docs.google.com/forms/d/e/1FAIpQLScRDnMhvDD-y1MkR12Y6VxZm12HcIEfzy4DFeC-hAawyfvMsw/viewform?usp=pp_url',
   'Base URL of the pre-inspection Google Form. The app appends the event id '
   '(entry.1980949741) and the job address (entry.1804749231) as prefills.'),
  ('post_inspection_form',
   'https://docs.google.com/forms/d/e/1FAIpQLSc7XEEREF0is86QN-ELs_aLywvh384dEeSr6MK74PJ_7Jr75A/viewform?usp=pp_url',
   'Base URL of the post-job inspection Google Form. The app appends the event '
   'id (entry.1980949741) as a prefill.'),
  ('yards_per_load', '15',
   'Truck capacity used for the "# of loads" line: loads = ceil(yards / this). '
   'ASSUMPTION from the one known example (11 yds = 1 load); correct it here if '
   'the trucks hold more or less. Median job is 20 yds.')
on conflict (key) do nothing;

-- Check:
-- select key, left(value,60) from app_config
--  where key in ('pre_inspection_form','post_inspection_form','yards_per_load');
