-- 19: Correct the crew -> truck mapping.
--
-- Taylor confirmed (2026-09-01): Crew #1 IS Truck #17, Crew #2 IS Truck #56 --
-- the opposite of the guess sql/14 and sql/17 originally shipped with. Those
-- two files are fixed at source for fresh installs; THIS file corrects a
-- database that already ran the old versions:
--   * crews.name / colours: id '1' -> Truck #17 (Tangerine), id '2' ->
--     Truck #56 (Basil)
--   * truck_capacity rows for crews 1 and 2 are re-seeded with the right
--     numbers (rock and the 45-yd Fiberex belong to #17 = crew '1')
-- Existing bookings are untouched: quotes reference crew IDs, and the IDs do
-- not move -- only what they are called and what they can carry.
--
-- Calendar note: already-created events carry the old name in their TITLE
-- (e.g. "#56-..." on a crew-1 job). The next Hold/Schedule of each such quote
-- rewrites its title with the right truck number. Colour stamps on existing
-- events also keep their old colour until then.
--
-- Idempotent: safe to re-run.

update crews set name = 'Truck #17', color = '#a8620f',
       calendar_color_id = '6',  updated_at = now() where id = '1';
update crews set name = 'Truck #56', color = '#2f6b3c',
       calendar_color_id = '10', updated_at = now() where id = '2';

-- Re-seed capacities for crews 1 and 2 from scratch (crew 3 / #58 untouched).
delete from truck_capacity where crew_id in ('1','2');
insert into truck_capacity (crew_id, product, dry_yards, wet_yards) values
  -- Crew '1' = Truck #17 "SS" (10 tons; the only truck that can blow rock)
  ('1', 'BeautiBark',              32,   23),
  ('1', 'Hemlock',                 23,   18),
  ('1', 'UltraKote',               25,   18),
  ('1', 'DecoBark Nuggets',        37.5, 28),
  ('1', 'Fiberex',                 45,   45),
  ('1', 'Fresh Sawdust',           37.5, 30),
  ('1', 'Alder Sawdust',           37.5, 30),
  ('1', 'Flower-n-Garden',         15,   11),
  ('1', 'Primary Planting Soil',   23,   15),
  ('1', 'Turf Start',              15,   11),
  ('1', 'Garden Compost',          23,   12),
  ('1', 'GVO Compost',             23,   12),
  ('1', 'GVO w/Worm Castings',     23,   12),
  ('1', 'Steer Plus',              23,   12),
  ('1', '3/4" round rock from RiverBend',      8, 8),
  ('1', '3/8" round rock from RiverBend',      8, 8),
  ('1', 'Quarter Ten from RiverBend',          8, 8),
  ('1', '3/4" open quarry from Coburg Quarry', 8, 8),
  -- Crew '2' = Truck #56 (10 tons)
  ('2', 'BeautiBark',              32,   23),
  ('2', 'Hemlock',                 23,   18),
  ('2', 'UltraKote',               25,   18),
  ('2', 'DecoBark Nuggets',        37.5, 28),
  ('2', 'Fiberex',                 40,   40),
  ('2', 'Fresh Sawdust',           37.5, 30),
  ('2', 'Alder Sawdust',           37.5, 30),
  ('2', 'Flower-n-Garden',         15,   11),
  ('2', 'Primary Planting Soil',   23,   15),
  ('2', 'Turf Start',              15,   11),
  ('2', 'Garden Compost',          23,   11),
  ('2', 'GVO Compost',             23,   11),
  ('2', 'GVO w/Worm Castings',     23,   11),
  ('2', 'Steer Plus',              23,   11);

-- Sanity: names, colours, and the two tells (rock on #17, Fiberex 45 vs 40).
select c.id, c.name, c.calendar_color_id,
       (select count(*) from truck_capacity t
         where t.crew_id = c.id and t.product like '%rock%')     as rock_products,
       (select t.dry_yards from truck_capacity t
         where t.crew_id = c.id and t.product = 'Fiberex')       as fiberex_dry
from crews c order by c.id;
