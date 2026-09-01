-- ============================================================================
-- Browser OAuth: the app talks to Google as the signed-in rep.
--
-- This replaces the service-account + Edge Function arrangement. There is no
-- key anywhere any more: no GOOGLE_SERVICE_ACCOUNT secret, no function to
-- deploy, nothing server-side at all. The rep authorises Google once per
-- session and the app writes to the calendar as them.
--
-- What that changes, stated plainly:
--   * Reps need "Make changes to events" on the crew calendar. Crews stay
--     read-only, as intended -- it is the reps who gain write access.
--   * Events are created by a real person, so Google's own history shows who
--     booked what. That is a better audit trail than one robot identity.
--   * Nothing can write unless a rep is at the browser. For a quoting tool that
--     is the workflow anyway.
--   * The hold-vs-approved rules now run in the browser rather than server-side.
--     A rep could bypass them by editing the calendar directly in Google -- but
--     they could do that anyway, having calendar access. Nothing that protects
--     the DATA moved: Supabase RLS is untouched and still decides who may read
--     and write quotes.
--
-- Run after 10_master_calendar.sql. Safe to re-run.
-- ============================================================================

-- The OAuth client ID. Public by design -- Google expects it in page source --
-- so this is an identifier, not a credential. Access is controlled by the
-- client's Authorized JavaScript origins and by each rep's Google permissions.
insert into app_config (key, value, note) values
  ('google_client_id', null,
   'OAuth 2.0 Web application client ID from Google Cloud, ending '
   '.apps.googleusercontent.com. Public identifier, not a secret.')
on conflict (key) do nothing;

-- Paste it in:
--   update app_config
--      set value = 'NNNNNN-xxxx.apps.googleusercontent.com', updated_at = now()
--    where key = 'google_client_id';

-- ------------------------------------------------- retire the service account
-- Keep the row for reference but mark it dead, so nobody wires it back up
-- expecting it to still be in use.
update app_config
   set note = 'RETIRED. Was used by the calendar Edge Function, which browser '
              'OAuth replaced. The Google Cloud service account and its key can '
              'be deleted; if the Edge Function is still deployed it is unused '
              'and can be removed too.'
 where key = 'service_account_email';

-- Check:
-- select key, left(coalesce(value,'(null)'), 40) as value from app_config order by key;
