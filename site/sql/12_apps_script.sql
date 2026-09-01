-- ============================================================================
-- Calendar writes move to a Google Apps Script web app.
--
-- Why: the browser-OAuth version worked, but Google only issues browsers
-- short-lived access tokens and gives them no way to renew offline -- so every
-- rep had to click "Connect Google" once a session and again about once an hour.
-- An Apps Script runs inside Google as the calendar's owner, so nobody
-- authorises anything, ever.
--
-- What this removes: the OAuth client, the per-rep consent, the hourly
-- reconnect, and the need for reps to have calendar write access at all.
-- Reps now need NO Google permission on the calendar -- the script writes.
--
-- What it adds: one deployment, done once, from script.google.com.
--
-- Run after 11_browser_oauth.sql. Safe to re-run.
-- ============================================================================

insert into app_config (key, value, note) values
  ('apps_script_url', null,
   'The /exec URL of the deployed Apps Script web app (calendar-appscript.gs). '
   'Deploy with Execute as = Me and Who has access = Anyone. Not a credential: '
   'the script verifies the caller''s Supabase session before doing anything.')
on conflict (key) do nothing;

-- Paste it in:
--   update app_config
--      set value = 'https://script.google.com/macros/s/AKfy.../exec',
--          updated_at = now()
--    where key = 'apps_script_url';

-- ------------------------------------------------------ retire the OAuth path
update app_config
   set note = 'RETIRED. Was the browser OAuth client ID; replaced by the Apps '
              'Script web app (apps_script_url), which needs no per-rep consent. '
              'The OAuth client in Google Cloud can be deleted.'
 where key = 'google_client_id';

-- Check:
-- select key, left(coalesce(value,'(null)'), 46) as value from app_config order by key;
