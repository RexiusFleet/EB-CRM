-- ============================================================================
-- PATCH: bad ZIPs parsed out of quote addresses.
--
-- The original address parser took the first five-digit group it found, which
-- read house numbers as ZIPs: '81372 Lost Creek Rd, Dexter' became ZIP 81372.
-- 230 of 238 parsed ZIPs were wrong, and every zip-based drive-time zone was
-- built from them.
--
-- Run this once, then re-run sql/03_seed_reference.sql to reload the corrected
-- drive_zones. Safe to re-run. Nothing else needs re-importing.
-- ============================================================================

begin;

-- 1. Drop the zone rows built from bad ZIPs. 03_seed_reference.sql puts the
--    corrected ones back.
delete from drive_zones where zone_type = 'zip';

-- 2. Recompute every ZIP from scratch rather than only deleting bad ones --
--    the old parser also MISSED real ZIPs (it grabbed the house number from
--    '24870 Territorial Hwy, Lorane 97451' and never saw the 97451).
--
--    The rule, mirroring extract_zip() in etl/addr.py:
--      - an address with no letters is a stray number, not an address
--      - drop a leading house number
--      - accept a five-digit group only at the END of what remains
update quote_history
   set zip = case
       when coalesce(address_raw,'') !~ '[A-Za-z]' then null
       else substring(
              regexp_replace(address_raw, '^[[:space:]]*[0-9]+[A-Za-z]?[[:space:]]+', ' ')
              from '([0-9]{5})(?:-[0-9]{4})?[[:space:],.]*$')
   end;

commit;

-- Check: every remaining ZIP should be a real Oregon 97xxx.
-- select zip, count(*) from quote_history where zip is not null group by 1 order by 1;
