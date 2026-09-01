-- ============================================================================
-- site_index -- one row per job site, for the search dropdown.
--
-- Collapses orders + quote_history into a single browsable list: the most
-- recent address/city/zip/customer for each site, how much work it has had,
-- and every name ever associated with it (so searching an old contact name
-- still finds the property).
--
-- Small enough (~3,400 rows) for the app to load once and filter instantly in
-- the browser, which is what lets the dropdown prepopulate and match words in
-- any order instead of requiring an exact substring.
--
-- Run AFTER 01_schema.sql and the CSV import. Safe to re-run.
-- ============================================================================

drop view if exists site_index;

create view site_index
-- security_invoker makes the view honour the CALLER's row level security.
-- Without it a view owned by the superuser bypasses RLS entirely and would
-- leak every customer to anonymous visitors.
with (security_invoker = on)
as
with u as (
  select site_key,
         -- some ERP addresses end in a stray comma ("33860 Oak Springs Dr,")
         nullif(btrim(regexp_replace(coalesce(ship_addr1,''),'[[:space:],]+$','')),'') as address1,
         nullif(btrim(ship_city),'')    as city,
         nullif(btrim(ship_zip),'')     as zip,
         nullif(btrim(customer_name),'') as customer_name,
         ord_date                        as dt,
         'order'::text                   as kind
    from orders
   where site_key is not null and btrim(site_key) <> ''
  union all
  select site_key,
         -- The quote log often glues the city onto the address
         -- ("2096 Musket St Eugene", "740 Queens Ave, Creswell"), which then
         -- shows twice in the UI next to the city column. Strip a trailing
         -- city, with or without a comma, plus a trailing state and ZIP.
         nullif(btrim(regexp_replace(
             regexp_replace(
               regexp_replace(btrim(coalesce(address_raw,'')),
                 '[[:space:],]+[0-9]{5}(-[0-9]{4})?$', ''),
               '[[:space:],]+(OR|ORE|OREGON|WA|CA)\.?$', '', 'i'),
             '[[:space:],]+' || regexp_replace(coalesce(city,'@@none@@'),
                                               '([^a-zA-Z0-9])', '\\\1', 'g') || '\.?$',
             '', 'i'),','),'') ,
         nullif(btrim(city),''),
         nullif(btrim(zip),''),
         nullif(btrim(customer_name),''),
         quote_date,
         'quote'
    from quote_history
   where site_key is not null and btrim(site_key) <> ''
)
select
  site_key,
  (array_agg(address1 order by dt desc nulls last)
     filter (where address1 is not null))[1]                as address1,
  (array_agg(city order by dt desc nulls last)
     filter (where city is not null))[1]                    as city,
  (array_agg(zip order by dt desc nulls last)
     filter (where zip is not null))[1]                     as zip,
  (array_agg(customer_name order by dt desc nulls last)
     filter (where customer_name is not null))[1]           as customer_name,
  count(*) filter (where kind = 'order')                    as n_orders,
  count(*) filter (where kind = 'quote')                    as n_quotes,
  max(dt)                                                   as last_activity,
  -- every distinct name ever seen here, so an old contact still finds the site
  (select string_agg(distinct x.customer_name, ' | ')
     from u x where x.site_key = u.site_key)                as all_names
from u
group by site_key;

grant select on site_index to authenticated;

-- Sanity check:
-- select count(*) from site_index;
-- select * from site_index order by last_activity desc nulls last limit 5;
