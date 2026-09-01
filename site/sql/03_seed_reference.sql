-- ============================================================================
-- Reference/config seed data. Run AFTER 01_schema.sql.
-- Safe to re-run: every insert upserts.
--
-- The BIG tables (customers, sites, orders, order_lines, quote_history) are
-- loaded from CSV instead -- see README, step 4.
--
-- IMPORTANT: the SQL editor runs a whole script as ONE transaction, so a single
-- failing statement rolls back everything above it -- including the rate card,
-- which then looks like "the seed ran but no products appeared". These guards
-- make the script independent of which other migrations have been run yet.
-- ============================================================================

alter table blow_benchmarks add column if not exists source  text;
alter table orders          add column if not exists product text;

-- rate_card (30 rows)
insert into rate_card (product, erp_code, category, unit_cost, yards_per_unit, needs_cost, active, source) values
  ('Econo-Bark', '321', 'bark', 65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('BeautiBark', '322', 'bark', 111.7711, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Hemlock', '020', 'bark', 224.25, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('UltraKote', '040', 'bark', 283.9959, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('DecoBark Nuggets', '004', 'bark', 243.75, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Extra Fine Bark', '002', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Garden Mulch', '032', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Fiberex', '301', 'bark', 98.7764, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Fresh Sawdust', '300', 'bark', 120, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Alder Sawdust', null, 'bark', 75.5, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Commercial Hog', '324', 'bark', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Primary Planting Soil', '180', 'soil_compost', 214.25, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Tree-n-Shrub', '106', 'soil_compost', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Flower-n-Garden', '100', 'soil_compost', 317.76, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Turf Start', '107', 'soil_compost', 255.9, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Patio Potting Soil', '105', 'soil_compost', 277.65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Garden Compost', '907', 'soil_compost', 127.7323, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GVO Compost', '907', 'soil_compost', 127.7323, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Steer Plus', '121', 'soil_compost', 228.3565, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GV Natural & Organic P.S.', '103', 'soil_compost', 422, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus Zero', '103', 'soil_compost', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #1', '103', 'soil_compost', 857, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #2', '103', 'soil_compost', 860, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus #3', '103', 'soil_compost', 842, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Opus Bio Tope', '103', 'soil_compost', 504, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('GVO w/Worm Castings', '103', 'soil_compost', 690, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/4" round rock from RiverBend', null, 'rock', 120.9, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/8" round rock from RiverBend', null, 'rock', 247.65, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('Quarter Ten from RiverBend', null, 'rock', null, 7.5, true, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs'),
  ('3/4" open quarry from Coburg Quarry', null, 'rock', 234, 7.5, false, true, 'Eugene Blower Pricing 2026 v2.xlsm / Product Costs')
on conflict (product) do update set erp_code = excluded.erp_code, category = excluded.category, unit_cost = excluded.unit_cost, yards_per_unit = excluded.yards_per_unit, needs_cost = excluded.needs_cost, active = excluded.active, source = excluded.source;

-- markup_curve (5 rows)
insert into markup_curve (min_yards, markup) values
  (3, 0.2),
  (4, 0.1),
  (5, 0.02),
  (17, 0.03),
  (45, 0.02)
on conflict (min_yards) do update set markup = excluded.markup;

-- settings (11 rows)
insert into settings (key, value, note) values
  ('labor_rate_blended', 27.5, '$/hr; avg(driver 30, helper 25) - Quote Calculator K14'),
  ('driver_wage', 30.0, '$/hr - Quote Calculator I13'),
  ('helper_wage', 25.0, '$/hr - Quote Calculator I19'),
  ('prevailing_wage', 70.0, '$/hr; replaces both wages when PW job - I12/I18'),
  ('equipment_rate', 85.0, '$/hr - Quote Calculator I22'),
  ('overhead_per_yard', 25.0, '$/yd, applied when yards < threshold - I23'),
  ('overhead_per_equip_hour', 145.0, '$/equip-hr, applied at/above threshold - I24'),
  ('overhead_yard_threshold', 16.0, 'yards; below = per-yard OH, at/above = hourly OH'),
  ('prep_hours_default', 0.5, 'hr; constant on 1974/2024 saved quotes'),
  ('helpers_default', 1.0, 'crew helpers; 1 on 1870/2024 saved quotes'),
  ('yards_per_unit', 7.5, 'yards per truck unit')
on conflict (key) do update set value = excluded.value, note = excluded.note;

-- blow_benchmarks (86 rows)
delete from blow_benchmarks;
insert into blow_benchmarks (product, volume_band, n, blow_hr_per_yard_p25, blow_hr_per_yard_median, blow_hr_per_yard_p75, source) values
  ('3/4" open quarry from Coburg Quarry', '1-10', 86, 0.1667, 0.2143, 0.2812, 'erp_equipment_hours'),
  ('3/4" open quarry from Coburg Quarry', '11-20', 10, 0.1562, 0.2, 0.2031, 'erp_equipment_hours'),
  ('3/4" open quarry from Coburg Quarry', 'ALL', 98, 0.1667, 0.2031, 0.25, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', '1-10', 108, 0.1667, 0.2222, 0.2778, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', '11-20', 13, 0.1875, 0.2045, 0.25, 'erp_equipment_hours'),
  ('3/4" round rock from RiverBend', 'ALL', 123, 0.1667, 0.2188, 0.2778, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', '1-10', 52, 0.1667, 0.2222, 0.3, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', '11-20', 6, 0.1875, 0.1964, 0.2188, 'erp_equipment_hours'),
  ('3/8" round rock from RiverBend', 'ALL', 62, 0.15, 0.1944, 0.2778, 'erp_equipment_hours'),
  ('BeautiBark', '1-10', 143, 0.125, 0.1667, 0.2143, 'erp_equipment_hours'),
  ('BeautiBark', '11-20', 233, 0.0833, 0.1, 0.125, 'erp_equipment_hours'),
  ('BeautiBark', '21-35', 672, 0.0662, 0.0809, 0.1, 'erp_equipment_hours'),
  ('BeautiBark', '36-60', 54, 0.0608, 0.075, 0.09, 'erp_equipment_hours'),
  ('BeautiBark', '60+', 34, 0.0515, 0.0703, 0.0977, 'erp_equipment_hours'),
  ('BeautiBark', 'ALL', 1136, 0.0703, 0.0893, 0.1167, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '1-10', 5, 0.1111, 0.125, 0.1667, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '11-20', 9, 0.0833, 0.1029, 0.1136, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '21-35', 6, 0.0673, 0.0682, 0.0857, 'erp_equipment_hours'),
  ('DecoBark Nuggets', '36-60', 3, 0.0338, 0.0338, 0.0405, 'erp_equipment_hours'),
  ('DecoBark Nuggets', 'ALL', 23, 0.0682, 0.0875, 0.1111, 'erp_equipment_hours'),
  ('Econo-Bark', '1-10', 40, 0.125, 0.1562, 0.25, 'erp_equipment_hours'),
  ('Econo-Bark', '11-20', 39, 0.0769, 0.1, 0.1364, 'erp_equipment_hours'),
  ('Econo-Bark', '21-35', 106, 0.0543, 0.0673, 0.087, 'erp_equipment_hours'),
  ('Econo-Bark', '36-60', 22, 0.0405, 0.0473, 0.0761, 'erp_equipment_hours'),
  ('Econo-Bark', '60+', 28, 0.0404, 0.0625, 0.0742, 'erp_equipment_hours'),
  ('Econo-Bark', 'ALL', 235, 0.0543, 0.0774, 0.1111, 'erp_equipment_hours'),
  ('Extra Fine Bark', '11-20', 4, 0.1, 0.15, 0.15, 'erp_equipment_hours'),
  ('Extra Fine Bark', '21-35', 11, 0.0833, 0.1023, 0.11, 'erp_equipment_hours'),
  ('Extra Fine Bark', 'ALL', 17, 0.08, 0.1, 0.11, 'erp_equipment_hours'),
  ('Fiberex', '1-10', 74, 0.1, 0.1333, 0.2, 'erp_equipment_hours'),
  ('Fiberex', '11-20', 101, 0.0526, 0.0667, 0.0833, 'erp_equipment_hours'),
  ('Fiberex', '21-35', 103, 0.0429, 0.05, 0.06, 'erp_equipment_hours'),
  ('Fiberex', '36-60', 347, 0.0338, 0.0375, 0.05, 'erp_equipment_hours'),
  ('Fiberex', '60+', 26, 0.0319, 0.0375, 0.0407, 'erp_equipment_hours'),
  ('Fiberex', 'ALL', 651, 0.0375, 0.0473, 0.0667, 'erp_equipment_hours'),
  ('Flower-n-Garden', '1-10', 89, 0.1389, 0.1875, 0.25, 'erp_equipment_hours'),
  ('Flower-n-Garden', '11-20', 52, 0.0938, 0.1167, 0.1364, 'erp_equipment_hours'),
  ('Flower-n-Garden', '21-35', 3, 0.0761, 0.0833, 0.1042, 'erp_equipment_hours'),
  ('Flower-n-Garden', 'ALL', 144, 0.1176, 0.15, 0.2045, 'erp_equipment_hours'),
  ('Fresh Sawdust', '11-20', 5, 0.0667, 0.0667, 0.0667, 'erp_equipment_hours'),
  ('Fresh Sawdust', '36-60', 3, 0.05, 0.05, 0.05, 'erp_equipment_hours'),
  ('Fresh Sawdust', 'ALL', 11, 0.05, 0.0667, 0.0938, 'erp_equipment_hours'),
  ('GVO Compost', '1-10', 22, 0.1667, 0.2, 0.3125, 'erp_equipment_hours'),
  ('GVO Compost', '11-20', 30, 0.0875, 0.1333, 0.1667, 'erp_equipment_hours'),
  ('GVO Compost', '21-35', 16, 0.0833, 0.1087, 0.125, 'erp_equipment_hours'),
  ('GVO Compost', '36-60', 4, 0.1118, 0.1222, 0.1222, 'erp_equipment_hours'),
  ('GVO Compost', 'ALL', 72, 0.1053, 0.1375, 0.1944, 'erp_equipment_hours'),
  ('Garden Compost', '1-10', 21, 0.15, 0.175, 0.2, 'erp_equipment_hours'),
  ('Garden Compost', '11-20', 77, 0.0781, 0.0909, 0.1071, 'erp_equipment_hours'),
  ('Garden Compost', '21-35', 55, 0.0625, 0.08, 0.1087, 'erp_equipment_hours'),
  ('Garden Compost', '36-60', 13, 0.075, 0.09, 0.0978, 'erp_equipment_hours'),
  ('Garden Compost', 'ALL', 167, 0.075, 0.0909, 0.12, 'erp_equipment_hours'),
  ('Garden Mulch', '11-20', 6, 0.1, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Garden Mulch', 'ALL', 6, 0.1, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Hemlock', '1-10', 282, 0.1429, 0.1786, 0.25, 'erp_equipment_hours'),
  ('Hemlock', '11-20', 341, 0.0938, 0.1111, 0.1364, 'erp_equipment_hours'),
  ('Hemlock', '21-35', 335, 0.0761, 0.0909, 0.1136, 'erp_equipment_hours'),
  ('Hemlock', '36-60', 30, 0.0815, 0.0946, 0.1316, 'erp_equipment_hours'),
  ('Hemlock', '60+', 4, 0.0761, 0.0938, 0.0938, 'erp_equipment_hours'),
  ('Hemlock', 'ALL', 992, 0.09, 0.1167, 0.1591, 'erp_equipment_hours'),
  ('Opus #1', '11-20', 3, 0.0875, 0.15, 0.1818, 'erp_equipment_hours'),
  ('Opus #1', 'ALL', 7, 0.0929, 0.15, 0.1818, 'erp_equipment_hours'),
  ('Primary Planting Soil', '1-10', 23, 0.1364, 0.15, 0.1875, 'erp_equipment_hours'),
  ('Primary Planting Soil', '11-20', 43, 0.0909, 0.1094, 0.1429, 'erp_equipment_hours'),
  ('Primary Planting Soil', '21-35', 17, 0.0682, 0.0795, 0.1, 'erp_equipment_hours'),
  ('Primary Planting Soil', '36-60', 3, 0.0543, 0.1, 0.1187, 'erp_equipment_hours'),
  ('Primary Planting Soil', 'ALL', 86, 0.0875, 0.1111, 0.15, 'erp_equipment_hours'),
  ('Quarter Ten from RiverBend', '1-10', 18, 0.2188, 0.25, 0.3333, 'erp_equipment_hours'),
  ('Quarter Ten from RiverBend', 'ALL', 21, 0.2188, 0.25, 0.3125, 'erp_equipment_hours'),
  ('Steer Plus', '11-20', 12, 0.1, 0.1111, 0.1176, 'erp_equipment_hours'),
  ('Steer Plus', 'ALL', 16, 0.1, 0.1125, 0.1304, 'erp_equipment_hours'),
  ('Tree-n-Shrub', '1-10', 9, 0.1, 0.15, 0.2, 'erp_equipment_hours'),
  ('Tree-n-Shrub', '11-20', 13, 0.0833, 0.1, 0.1333, 'erp_equipment_hours'),
  ('Tree-n-Shrub', 'ALL', 22, 0.0938, 0.1071, 0.15, 'erp_equipment_hours'),
  ('Turf Start', '1-10', 60, 0.1429, 0.2, 0.25, 'erp_equipment_hours'),
  ('Turf Start', '11-20', 132, 0.0938, 0.1167, 0.1429, 'erp_equipment_hours'),
  ('Turf Start', '21-35', 25, 0.1, 0.1083, 0.125, 'erp_equipment_hours'),
  ('Turf Start', '36-60', 3, 0.0875, 0.0933, 0.1333, 'erp_equipment_hours'),
  ('Turf Start', 'ALL', 220, 0.1, 0.125, 0.1667, 'erp_equipment_hours'),
  ('UltraKote', '1-10', 30, 0.125, 0.1667, 0.25, 'erp_equipment_hours'),
  ('UltraKote', '11-20', 44, 0.1, 0.1053, 0.1333, 'erp_equipment_hours'),
  ('UltraKote', '21-35', 33, 0.0652, 0.087, 0.1087, 'erp_equipment_hours'),
  ('UltraKote', '36-60', 15, 0.0833, 0.0903, 0.1, 'erp_equipment_hours'),
  ('UltraKote', '60+', 5, 0.0751, 0.0751, 0.178, 'erp_equipment_hours'),
  ('UltraKote', 'ALL', 127, 0.0833, 0.1087, 0.1389, 'erp_equipment_hours'),
  ('Patio Potting Soil', 'ALL', 8, 0.0333, 0.1875, 0.25, 'quote_blow_hours')
on conflict (product, volume_band) do update set n = excluded.n, blow_hr_per_yard_p25 = excluded.blow_hr_per_yard_p25, blow_hr_per_yard_median = excluded.blow_hr_per_yard_median, blow_hr_per_yard_p75 = excluded.blow_hr_per_yard_p75, source = excluded.source;

-- drive_zones (21 rows)
delete from drive_zones;
insert into drive_zones (zone_type, zone_key, n, drive_hours_p25, drive_hours_median, drive_hours_p75) values
  ('city', 'Albany', 3, 1.5, 1.5, 3.0),
  ('city', 'Bend', 5, 4.0, 4.0, 5.0),
  ('city', 'Coburg', 22, 0.75, 0.75, 1.0),
  ('city', 'Coos Bay', 6, 5.0, 5.5, 6.0),
  ('city', 'Corvallis', 8, 2.5, 3.5, 3.5),
  ('city', 'Cottage Grove', 10, 2.0, 2.0, 3.0),
  ('city', 'Creswell', 11, 2.0, 2.0, 2.5),
  ('city', 'Eugene', 439, 1.0, 1.25, 1.5),
  ('city', 'Fall Creek', 4, 2.0, 2.0, 2.0),
  ('city', 'Florence', 3, 4.0, 5.0, 5.0),
  ('city', 'Goshen', 3, 1.5, 1.75, 2.0),
  ('city', 'Harrisburg', 13, 1.0, 1.25, 1.25),
  ('city', 'Junction City', 4, 2.0, 2.5, 2.5),
  ('city', 'Monroe', 4, 2.0, 3.5, 3.5),
  ('city', 'Roseburg', 5, 3.5, 4.0, 4.0),
  ('city', 'Salem', 3, 2.0, 2.5, 2.5),
  ('city', 'Springfield', 133, 1.25, 1.5, 2.0),
  ('city', 'Thurston', 3, 1.0, 1.5, 1.5),
  ('city', 'Veneta', 14, 1.5, 2.0, 2.25),
  ('zip', '97451', 3, 2.5, 2.5, 2.5),
  ('default', '*', 2243, 1.0, 1.5, 2.0)
on conflict (zone_type, zone_key) do update set n = excluded.n, drive_hours_p25 = excluded.drive_hours_p25, drive_hours_median = excluded.drive_hours_median, drive_hours_p75 = excluded.drive_hours_p75;
