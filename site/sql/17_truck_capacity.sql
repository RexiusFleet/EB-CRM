-- 17: Truck capacities by product (from the Dept #32/#02 Placement Truck
--     Capacities sheet), the dry/wet mode switch, and Truck #58.
--
-- The sheet gives two numbers per product: a dry capacity and a winter/wet
-- capacity (in parentheses). Which one applies is a judgment call the office
-- makes when material is wet, so it is a TOGGLE (app_config.capacity_mode),
-- flipped on the Rate Card tab -- not a calendar rule.
--
-- Product names are keyed to the rate card's names. Sheet name -> rate card:
--   Beautibark -> BeautiBark          Bark Nuggets -> DecoBark Nuggets
--   Fir Sawdust -> Fresh Sawdust      Flower and Garden -> Flower-n-Garden
--   Primary Soil -> Primary Planting Soil
--   Compost (sheet, one row) -> seeded onto the compost family below
--   Loam/Rock/Sand -> the four rock products, TRUCK #17 ONLY (the sheet's
--     footnote: only #17 can blow rock, 8 yds)
-- Products with no row here (Econo-Bark, Extra Fine Bark, Garden Mulch,
-- Commercial Hog, Tree-n-Shrub, Patio Potting Soil, the Opus line, ...) have
-- no capacity on file: the scheduler skips share-a-load suggestions for them
-- and says so. Add rows as the office establishes numbers.
--
-- Idempotent: safe to re-run.

create table if not exists truck_capacity (
  crew_id    text not null references crews(id),
  product    text not null,
  dry_yards  numeric(6,1),
  wet_yards  numeric(6,1),
  updated_at timestamptz default now(),
  primary key (crew_id, product)
);

alter table truck_capacity enable row level security;
drop policy if exists truck_capacity_read on truck_capacity;
create policy truck_capacity_read on truck_capacity
  for select to authenticated using (true);
drop policy if exists truck_capacity_write on truck_capacity;
create policy truck_capacity_write on truck_capacity
  for all to authenticated using (true) with check (true);

-- The dry/wet switch. 'dry' | 'wet'.
insert into app_config (key, value) values ('capacity_mode', 'dry')
  on conflict (key) do nothing;

-- Truck #58 exists in Dept #02 (handwritten equipment list) but is not booked
-- through the app yet: seeded INACTIVE so switching it on later is one update:
--   update crews set active = true where id = '3';
insert into crews (id, name, calendar_id, color, active, sort_order)
  values ('3', 'Truck #58', null, '#2d5f8a', false, 3)
  on conflict (id) do nothing;
update crews set calendar_color_id = coalesce(calendar_color_id, '9')  -- Blueberry
  where id = '3';

-- Capacities. Crew '1' = Truck #17, '2' = Truck #56, '3' = Truck #58
-- (see sql/14_trucks.sql for the crew->truck mapping).
insert into truck_capacity (crew_id, product, dry_yards, wet_yards) values
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
  ('2', 'Steer Plus',              23,   11),
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
  -- Truck #58 (10 tons; same as #56 per the sheet)
  ('3', 'BeautiBark',              32,   23),
  ('3', 'Hemlock',                 23,   18),
  ('3', 'UltraKote',               25,   18),
  ('3', 'DecoBark Nuggets',        37.5, 28),
  ('3', 'Fiberex',                 40,   40),
  ('3', 'Fresh Sawdust',           37.5, 30),
  ('3', 'Alder Sawdust',           37.5, 30),
  ('3', 'Flower-n-Garden',         15,   11),
  ('3', 'Primary Planting Soil',   23,   15),
  ('3', 'Turf Start',              15,   11),
  ('3', 'Garden Compost',          23,   11),
  ('3', 'GVO Compost',             23,   11),
  ('3', 'GVO w/Worm Castings',     23,   11),
  ('3', 'Steer Plus',              23,   11)
on conflict (crew_id, product) do update
  set dry_yards = excluded.dry_yards, wet_yards = excluded.wet_yards,
      updated_at = now();

-- Sanity: how many capacity rows per truck?
select c.name, count(tc.product) as products_with_capacity
from crews c left join truck_capacity tc on tc.crew_id = c.id
group by c.name order by c.name;
