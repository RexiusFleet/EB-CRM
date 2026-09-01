-- ============================================================================
-- Nomenclature: the crews are the trucks. Crew #1 -> Truck #17,
-- Crew #2 -> Truck #56. (Confirmed by Taylor 2026-09-01; this file originally
-- guessed the opposite -- sql/19 exists to correct a database that ran the
-- old guess.)
--
-- Names are data, so this is the whole change server-side: event titles, the
-- dropdown, the load line and the saved-quotes column all read crews.name.
-- The Apps Script needs NO redeploy -- it builds titles from this table.
--
-- ASSUMPTION: Taylor listed "Truck #56 and Truck #17" in crew order, so #1
-- becomes 56 and #2 becomes 17. If that is backwards, swap them:
--   update crews set name = 'Truck #17' where id = '1';
--   update crews set name = 'Truck #56' where id = '2';
--
-- Run any time. Safe to re-run.
-- ============================================================================

update crews set name = 'Truck #17', updated_at = now() where id = '1';
update crews set name = 'Truck #56', updated_at = now() where id = '2';

-- Existing calendar events keep their old titles until each quote is next
-- saved -- the app rewrites the event body on every save, so they converge on
-- their own as quotes get touched.

-- Check:
-- select id, name, calendar_color_id from crews order by sort_order;
