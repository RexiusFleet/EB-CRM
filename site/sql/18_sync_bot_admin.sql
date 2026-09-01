-- 18: Let the calendar-sync user update quotes.
--
-- Row-level security on quotes allows updates only by a quote's author or an
-- admin (sql/02). The calendar->quote sync writes as its own dedicated user
-- (SYNC_BOT_EMAIL in the Apps Script), which is neither -- so its updates
-- matched zero rows and the sync silently did nothing. Making that user an
-- admin is the fix: it is a single controlled identity whose password lives
-- only in the Script properties, and "admin" here means exactly "may update
-- any quote", which is precisely the job.
--
-- EDIT THE EMAIL below if your sync user is named differently, then run.
-- Idempotent: safe to re-run.

-- The profiles row is created automatically when the user is created
-- (on_auth_user_created trigger), but upsert anyway in case the user was made
-- before that trigger existed.
insert into profiles (id, full_name, is_admin)
select u.id, u.email, true
from auth.users u
where u.email = 'calendar-sync@rexius.com'
on conflict (id) do update set is_admin = true;

-- Sanity: the row this touched. Expect one row, is_admin = true.
select p.full_name, p.is_admin
from profiles p join auth.users u on u.id = p.id
where u.email = 'calendar-sync@rexius.com';
