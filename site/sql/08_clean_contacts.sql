-- ============================================================================
-- Clean the contact columns.
--
-- The quote log's Email and Phone columns were used as scratch space:
--   236 of 289 "emails" are notes or company names -- 'POWR', 'Bi-mart',
--   'This quote is X20 for the job. They need 7000 linear foot...'
--   155 of 852 "phones" are names -- 'Renee', 'Jason Spies'
--
-- The app pulled the most recent value straight into the Email field, so a rep
-- saw a sentence where an address's email should be. This nulls anything that
-- is not a plausible email, and normalises phones to (XXX) XXX-XXXX, keeping
-- the digits out of values like 'Damion 541.206.5093'.
--
-- Safe to re-run.
-- ============================================================================

-- 1. Emails: keep only something@something.tld
update quote_history
   set email = null
 where email is not null
   and email !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[A-Za-z]{2,}$';

update customers
   set email = null
 where email is not null
   and (email !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[A-Za-z]{2,}$'
        or email ilike '%nope@%');

-- 2. Phones: reduce to digits, keep only real 10-digit numbers, reformat.
--    'Damion 541.206.5093' still holds a number; 'Renee' does not.
with cleaned as (
  select id,
         regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') as d
    from quote_history
   where phone is not null
)
update quote_history h
   set phone = case
       when length(regexp_replace(c.d,'^1(?=[0-9]{10}$)','')) = 10
        and (select count(distinct ch) from regexp_split_to_table(
               regexp_replace(c.d,'^1(?=[0-9]{10}$)',''), '') ch) > 1
       then '(' || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),1,3) || ') '
                || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),4,3) || '-'
                || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),7,4)
       else null end
  from cleaned c
 where h.id = c.id;

with cleaned as (
  select cust_id,
         regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') as d
    from customers
   where phone is not null
)
update customers t
   set phone = case
       when length(regexp_replace(c.d,'^1(?=[0-9]{10}$)','')) = 10
       then '(' || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),1,3) || ') '
                || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),4,3) || '-'
                || substr(regexp_replace(c.d,'^1(?=[0-9]{10}$)',''),7,4)
       else null end
  from cleaned c
 where t.cust_id = c.cust_id;

-- Check:
-- select count(*) filter (where email is not null) as emails,
--        count(*) filter (where phone is not null) as phones from quote_history;
