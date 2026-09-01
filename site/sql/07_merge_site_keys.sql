-- ============================================================================
-- Re-unite job sites that were split by a missing street suffix.
--
-- The ERP records "33860 Oak Springs Dr"; the quote log records "33860 Oak
-- Springs Coburg". Stripping the city leaves "33860 oak springs", which does
-- not equal "33860 oak springs dr" -- so one property became two, and the
-- delivered history did not show up against the quote.
--
-- 80 quote-side keys are repointed at their ERP equivalent. Only merges where
-- exactly ONE ERP street suffix matches are included: 2 genuinely ambiguous
-- cases (e.g. "140 Daniel" matching both "140 Daniel Ave" and "140 Daniel Dr")
-- are deliberately left alone rather than guessed at.
--
-- Run after the CSV import. Safe to re-run. Then re-run sql/05_search_index.sql.
-- ============================================================================

update quote_history h
   set site_key = m.erp
  from (values
    ('1126 cedar rdg', '1126 cedar rdg dr'),
    ('1175 66', '1175 66 st'),
    ('1190 barber', '1190 barber dr'),
    ('1210 w 22', '1210 w 22 ave'),
    ('1250 rainbow', '1250 rainbow dr'),
    ('136 sw 9', '136 sw 9 st'),
    ('1386 roundup', '1386 roundup st'),
    ('140 daniel', '140 daniel dr'),
    ('1400 candlelight', '1400 candlelight dr'),
    ('1452 long island', '1452 long island dr'),
    ('1505 franklin', '1505 franklin blvd'),
    ('1597 lawnridge', '1597 lawnridge ave'),
    ('1620 delrose', '1620 delrose ave'),
    ('1725 n 5', '1725 n 5 st'),
    ('1825 brewer', '1825 brewer ave'),
    ('184 greenvale', '184 greenvale dr'),
    ('1852 s 61', '1852 s 61 st'),
    ('1950 w 17', '1950 w 17 ave'),
    ('1955 polk', '1955 polk st'),
    ('2021 morning vw', '2021 morning vw dr'),
    ('2092 musket', '2092 musket st'),
    ('2096 musket', '2096 musket st'),
    ('2160 onyx', '2160 onyx st'),
    ('2460 bailey hill', '2460 bailey hill rd'),
    ('2519 stratford', '2519 stratford st'),
    ('2575 highland oaks', '2575 highland oaks dr'),
    ('2676 ridgemont', '2676 ridgemont dr'),
    ('273 palomino', '273 palomino dr'),
    ('2810 tomahawk', '2810 tomahawk ln'),
    ('28331 w 11', '28331 w 11 ave'),
    ('2877 martinique', '2877 martinique ave'),
    ('3000 madison', '3000 madison st'),
    ('3019 wintercreek', '3019 wintercreek dr'),
    ('31205 fox hollow', '31205 fox hollow rd'),
    ('3123 willakenzie', '3123 willakenzie rd'),
    ('3192 gateway', '3192 gateway loop'),
    ('3224 boardwalk', '3224 boardwalk ave'),
    ('32599 skyhawk', '32599 skyhawk way'),
    ('32758 redtail', '32758 redtail dr'),
    ('3340 wyndham', '3340 wyndham ct'),
    ('33464 bloomberg', '33464 bloomberg rd'),
    ('33860 oak springs', '33860 oak springs dr'),
    ('3387 amherst', '3387 amherst way'),
    ('3470 strathmore', '3470 strathmore pl'),
    ('3491 game farm', '3491 game farm rd'),
    ('3530 e game farm', '3530 e game farm rd'),
    ('3538 ambleside', '3538 ambleside dr'),
    ('3545 kinsrow', '3545 kinsrow dr'),
    ('3548 sister''s vw', '3548 sister''s vw dr'),
    ('355 ventura', '355 ventura ave'),
    ('3550 mt quail', '3550 mt quail ln'),
    ('3576 summit sky', '3576 summit sky blvd'),
    ('3700 babcock', '3700 babcock ln'),
    ('37951 camp creek', '37951 camp creek rd'),
    ('3815 brighton', '3815 brighton ave'),
    ('3853 wilshire', '3853 wilshire ln'),
    ('3877 vine maple', '3877 vine maple st'),
    ('39541 mckenzie', '39541 mckenzie hwy'),
    ('3970 sterling woods', '3970 sterling woods dr'),
    ('4096 spring knoll', '4096 spring knoll dr'),
    ('4835 brookwood', '4835 brookwood dr'),
    ('485 spyglass', '485 spyglass dr'),
    ('497 dellwood', '497 dellwood dr'),
    ('4986 hunters glen', '4986 hunters glen dr'),
    ('5000 fox hollow', '5000 fox hollow dr'),
    ('505 e 31', '505 e 31 ave'),
    ('605 fair oaks', '605 fair oaks dr'),
    ('725 lorane', '725 lorane hwy'),
    ('735 e 21', '735 e 21 ave'),
    ('747 e 32', '747 e 32 st'),
    ('84723 laughlin', '84723 laughlin rd'),
    ('85 marlboro', '85 marlboro ln'),
    ('85153 kensington', '85153 kensington dr'),
    ('86301 panorama', '86301 panorama rd'),
    ('86733 pine grove', '86733 pine grove rd'),
    ('86956 bailey hill', '86956 bailey hill rd'),
    ('88626 sky high', '88626 sky high dr'),
    ('90552 diamond rdg', '90552 diamond rdg loop'),
    ('91082 lea shore', '91082 lea shore dr'),
    ('coburg', 'coburg rd')
  ) as m(quote_key, erp)
 where h.site_key = m.quote_key;
