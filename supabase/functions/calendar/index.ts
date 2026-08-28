
/**
 * Google Calendar bridge for the Rexius Blower Quote CRM.
 *
 * WHY THIS EXISTS
 * The app is a static page on GitHub Pages. A Google service-account key cannot
 * live there -- anyone viewing source would get read/write access to the crew
 * calendars. This function holds the key server-side and is the only thing that
 * talks to Google.
 *
 * ONE MASTER CALENDAR
 * Every crew's jobs go on a single calendar (app_config.master_calendar_id).
 * The crew is carried on the event itself -- in the title, in a Google colour,
 * and in a private extended property -- not by which calendar it sits in. So
 * "what is crew #2 doing Tuesday" is a filtered read of one calendar, and the
 * crews get read-only access to that one calendar rather than one each.
 * crews.calendar_id remains as a per-crew override; null means the master.
 *
 * SECURITY
 *  - Every request must carry a valid Supabase user JWT. An anonymous caller is
 *    rejected before anything reaches Google, so the function is not an open
 *    proxy to your calendars.
 *  - The service-account key is read from the GOOGLE_SERVICE_ACCOUNT env secret
 *    and never returned to the client.
 *  - Only the master calendar ID and the IDs stored in the `crews` table can be
 *    touched; a caller cannot pass an arbitrary calendar and have this write to
 *    it.
 *
 * ACTIONS  (POST { action, ... })
 *   availability { date, crewIds? }        -> per-crew jobs/hours for that day
 *   schedule     { quoteId, crewId, date } -> creates the event, stores its id
 *   reschedule   { quoteId, crewId, date } -> moves/updates the existing event
 *   unschedule   { quoteId }               -> deletes the event, clears fields
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const TZ = 'America/Los_Angeles';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

/* ------------------------------------------------------------------ Google */

/** Sign a JWT with the service-account key and exchange it for an access token. */
async function googleAccessToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT');
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT secret is not set');
  let sa: { client_email: string; private_key: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT is missing client_email or private_key');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = `${b64(header)}.${b64(claim)}`;

  // Import the PEM private key for RS256 signing.
  const pem = sa.private_key.replace(/\\n/g, '\n');
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
  );
  const sigB64 = btoa(String.fromCharCode(...sig))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sigB64}`,
    }),
    // Never let a Google call hang the whole function. A rep staring at a
    // spinner learns nothing; a 10s failure names the step.
    signal: AbortSignal.timeout(10_000),
  }).catch((e: any) => {
    throw new Error(
      /timeout|abort/i.test(String(e?.name || e))
        ? 'Google did not answer the token request within 10s.'
        : `Could not reach Google to get a token: ${e?.message || e}`);
  });
  const tok = await res.json();
  if (!res.ok) {
    // Google's errors here are famously opaque; surface enough to act on.
    throw new Error(
      `Google token exchange failed (${res.status}): ${tok.error_description || tok.error || 'unknown'}. ` +
      `Check the key is valid and the Calendar API is enabled on the project.`,
    );
  }
  return tok.access_token;
}

async function cal(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${CAL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: any) => {
    throw new Error(
      /timeout|abort/i.test(String(e?.name || e))
        ? 'Google Calendar did not answer within 10s.'
        : `Could not reach Google Calendar: ${e?.message || e}`);
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.error?.message || res.statusText;
    if (res.status === 404) {
      throw new Error(
        `Calendar not found (404): ${msg}. The Calendar ID may be wrong, or the ` +
        `calendar has not been shared with the service account.`,
      );
    }
    if (res.status === 403) {
      throw new Error(
        `Permission denied (403): ${msg}. Share the calendar with the service ` +
        `account email and give it "Make changes to events".`,
      );
    }
    throw new Error(`Google Calendar ${res.status}: ${msg}`);
  }
  return body;
}

/* ---------------------------------------------------------------- Supabase */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: any) => {
    throw new Error(
      /timeout|abort/i.test(String(e?.name || e))
        ? `The database did not answer within 10s (${path.split('?')[0]}).`
        : `Could not reach the database: ${e?.message || e}`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Reject anything without a valid signed-in Supabase user.
 *
 *  The caller's token is read from `x-user-token` first, falling back to the
 *  Authorization header. That indirection exists because Supabase's *gateway*
 *  can be configured to verify the Authorization header itself, and on projects
 *  using the newer asymmetric JWT signing keys that gateway check rejects
 *  perfectly valid session tokens before this function ever runs. When that
 *  happens the app retries with the anon key in Authorization -- which the
 *  gateway always accepts -- and the real session token in `x-user-token`.
 *
 *  This is not a way around authentication: whichever token arrives is verified
 *  against /auth/v1/user below, so a forged or expired one is refused here. The
 *  anon key alone gets no further -- it is not a user token, so this throws. */
async function requireUser(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const xut = (req.headers.get('x-user-token') || '').trim();
  const fromAuth = auth.replace(/^Bearer\s+/i, '').trim();
  const jwt = xut || fromAuth;

  /* Log what arrived, never the token itself. Without this the function's logs
     show only "booted" and there is no way to tell a gateway rejection from the
     function refusing the token -- which is exactly the hole this project fell
     into. Lengths and presence are enough to tell them apart. */
  console.log(JSON.stringify({
    at: 'requireUser',
    hasAuthHeader: !!auth,
    hasUserTokenHeader: !!xut,
    tokenSource: xut ? 'x-user-token' : (fromAuth ? 'authorization' : 'none'),
    tokenLen: jwt.length,
  }));

  if (!jwt) {
    throw new Error(
      'No session token reached the function. The app sends it in both ' +
      'Authorization and x-user-token — if neither arrived, something is ' +
      'stripping headers between the browser and here.');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: any) => { throw new Error('Could not verify the session: ' + (e?.message || e)); });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.log(JSON.stringify({ at: 'requireUser', verify: res.status, detail: detail.slice(0, 200) }));
    throw new Error(
      `The session token was rejected by Supabase Auth (${res.status}). ` +
      (res.status === 401 || res.status === 403
        ? 'It is expired or from a different project — sign out and back in.'
        : `Auth said: ${detail.slice(0, 120)}`));
  }
  const user = await res.json();
  console.log(JSON.stringify({ at: 'requireUser', ok: true, user: user?.email || user?.id }));
  return user;
}

/* -------------------------------------------------------------- event shape */

/* A quote that is not yet won still goes on the calendar -- the crews need to
   see the day is spoken for -- but it must never be mistaken for sold work. So
   a hold is: HOLD in the title, one flat grey rather than the crew colour, and
   marked Free rather than Busy so it does not block the crew in Google's own
   free/busy. Approving the quote turns that same event solid; it is a PATCH, so
   the event keeps its id and nothing is duplicated. */
function eventBody(q: any, crew: any, opts: { hold: boolean; holdColor?: string | null }) {
  const hold = opts.hold;
  const yards = q.yards ? `${q.yards} yd` : '';
  // Crew leads the title -- on a shared calendar "is this mine?" comes first --
  // except on a hold, where "is this real?" comes first.
  const title = [hold ? 'HOLD' : null, crew.name, q.product, yards, q.customer_name]
    .filter(Boolean).join(' · ');
  const lines = [
    hold ? '⚠ NOT APPROVED — this is a hold, not a confirmed job.' : '',
    hold ? `Quote status: ${q.status || 'draft'}. Do not schedule crew time against`
         + ' this until it is approved; it will turn into a normal booking here'
         + ' when it is.' : '',
    hold ? '' : '',
    q.address_raw ? `Address: ${q.address_raw}${q.city ? ', ' + q.city : ''}` : '',
    q.customer_name ? `Customer: ${q.customer_name}` : '',
    q.phone ? `Phone: ${q.phone}` : '',
    q.email ? `Email: ${q.email}` : '',
    '',
    q.product ? `Product: ${q.product}${yards ? ' — ' + yards : ''}` : '',
    q.blow_hours != null ? `Blow: ${q.blow_hours} hr` : '',
    q.drive_hours != null ? `Drive (round trip): ${q.drive_hours} hr` : '',
    q.equip_hours != null ? `Equipment: ${q.equip_hours} hr` : '',
    q.labor_hours != null ? `Labor: ${q.labor_hours} hr` : '',
    q.bid_amount != null ? `Bid: $${Number(q.bid_amount).toLocaleString()}` : '',
    '',
    q.notes ? `Notes: ${q.notes}` : '',
    `Quote ${q.id}`,
  ].filter((l) => l !== undefined);

  // All-day. Only 13% of historical jobs carried a clock time, so a timed
  // event would invent precision the business does not actually work to.
  const end = new Date(q.scheduled_date + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    summary: title,
    description: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    location: [q.address_raw, q.city, q.zip].filter(Boolean).join(', '),
    start: { date: q.scheduled_date },
    end: { date: end.toISOString().slice(0, 10) },
    // Approved work takes the crew's colour; a hold takes one flat grey, because
    // approved-or-not is what a foreman needs to see first.
    colorId: String(hold ? (opts.holdColor || '8') : (crew.calendar_color_id || '')) || undefined,
    // A hold shows as Free: it marks the day without consuming the crew in
    // Google's own free/busy. An approved job shows as Busy.
    transparency: hold ? 'transparent' : 'opaque',
    // Lets us find our own events later even if someone edits the title -- and
    // is how a crew's jobs are told apart on a shared calendar. `hold` is what
    // the availability read counts separately.
    extendedProperties: {
      private: {
        quoteId: String(q.id), crewId: String(crew.id),
        hold: hold ? 'true' : 'false', status: String(q.status || 'draft'),
      },
    },
    source: { title: 'Blower Quote CRM', url: 'https://rexiusfleet.github.io/' },
  };
}

/* -------------------------------------------------------------------- main */

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  try {
    await requireUser(req);
    const { action, ...args } = await req.json();
    console.log(JSON.stringify({ at: 'request', action }));

    const crews: any[] = await db('crews?select=*&active=is.true&order=sort_order');
    const crewById = new Map<string, any>(crews.map((c: any) => [String(c.id), c]));

    /* One master calendar for everyone, with a per-crew override that is
       normally null. Resolved in one place so no branch can disagree. */
    const cfg: any[] = await db('app_config?select=key,value');
    const conf = (k: string): string | null =>
      ((cfg || []).find((r: any) => r.key === k)?.value || '').trim() || null;
    const MASTER: string | null = conf('master_calendar_id');
    const HOLD_COLOR: string = conf('hold_color_id') || '8';
    const calFor = (c: any): string | null => (c?.calendar_id || MASTER || null);
    const noCalendarError = (c: any) =>
      MASTER || c?.calendar_id
        ? null
        : 'No calendar configured yet. Paste the master Calendar ID into ' +
          "app_config (key 'master_calendar_id') — see README section 8.";

    /* ---- availability: what each crew already has on that date ---- */
    if (action === 'availability') {
      const date = String(args.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Bad date' }, 400);
      const token = await googleAccessToken();

      /* Read each distinct calendar ONCE. With one master calendar that is a
         single Google call for the whole day, and -- more to the point -- it
         stops crew #2's events being counted against crew #1 just because they
         now share a calendar. Events are attributed by the crewId we stamped
         on them, not by which calendar they sit in. */
      const byCal = new Map<string, any[]>();   // calendarId -> events
      const calErr = new Map<string, string>();
      const wanted = [...new Set(crews.map(calFor).filter(Boolean))] as string[];
      for (const calId of wanted) {
        try {
          const res = await cal(token,
            `/calendars/${encodeURIComponent(calId)}/events` +
            `?timeMin=${date}T00:00:00Z&timeMax=${date}T23:59:59Z` +
            `&singleEvents=true&maxResults=250`);
          byCal.set(calId, res.items || []);
        } catch (e: any) {
          calErr.set(calId, String(e?.message || e));
        }
      }

      const out = [];
      for (const c of crews as any[]) {
        const calId = calFor(c);
        const row: any = {
          crewId: c.id, name: c.name, color: c.color, colorId: c.calendar_color_id,
          maxEquipHours: Number(c.max_equip_hours), maxJobs: Number(c.max_jobs),
          calendarConfigured: !!calId,
          jobs: 0, equipHours: 0, events: [],
        };
        // Our own bookings (authoritative for hours -- Google has no hour field).
        // Approved and unapproved are counted apart: a rep needs to know whether
        // the day is actually sold or merely spoken for.
        const booked = await db(
          `quotes?select=id,product,yards,equip_hours,customer_name,address_raw,status` +
          `&scheduled_date=eq.${date}&crew_id=eq.${c.id}&status=neq.lost`);
        const hrs = (rs: any[]) =>
          rs.reduce((s: number, q: any) => s + (Number(q.equip_hours) || 0), 0);
        const won = booked.filter((q: any) => String(q.status) === 'won');
        const held = booked.filter((q: any) => String(q.status) !== 'won');
        row.jobs = won.length;
        row.holds = held.length;
        row.equipHours = hrs(won);
        row.holdEquipHours = hrs(held);
        // Capacity is judged on the whole day. A hold still reserves the crew --
        // that is the point of putting it on the calendar -- so it counts here,
        // even though it is shown separately.
        row.totalJobs = booked.length;
        row.totalEquipHours = hrs(booked);
        row.booked = booked;
        if (calId && calErr.has(calId)) row.calendarError = calErr.get(calId);
        else if (calId) {
          const mine = (byCal.get(calId) || []).filter(
            (e: any) => String(e?.extendedProperties?.private?.crewId || '') === String(c.id));
          row.events = mine.map((e: any) => ({
            id: e.id, summary: e.summary,
            fromApp: !!e?.extendedProperties?.private?.quoteId,
          }));
          row.calendarJobs = mine.length;
        }
        out.push(row);
      }

      /* Anything on the calendar that this app did not put there -- a job typed
         straight into Google, a holiday, a truck in the shop. On a shared
         calendar it belongs to nobody in particular, so it is reported once for
         the day rather than charged to whichever crew happened to be listed
         first. It still eats into the day, so the rep should see it. */
      const unassigned = [...byCal.values()].flat().filter(
        (e: any) => !e?.extendedProperties?.private?.crewId);

      return json({
        date,
        crews: out,
        masterCalendar: !!MASTER,
        calendarConfigured: wanted.length > 0,
        setupHint: wanted.length ? null : noCalendarError(null),
        other: unassigned.map((e: any) => ({ id: e.id, summary: e.summary })),
      });
    }

    /* ---- schedule / reschedule ---- */
    if (action === 'schedule' || action === 'reschedule') {
      const { quoteId, crewId, date } = args;
      if (!quoteId || !crewId || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        return json({ error: 'quoteId, crewId and date are required' }, 400);
      }
      const crew: any = crewById.get(String(crewId));
      if (!crew) return json({ error: `Unknown or inactive crew ${crewId}` }, 400);

      const rows = await db(`quotes?select=*&id=eq.${quoteId}`);
      const q = rows?.[0];
      if (!q) return json({ error: 'Quote not found' }, 404);
      q.scheduled_date = date;

      /* ---- lost: off the calendar entirely ----
         A hold says "not approved yet". A lost quote is not waiting on anything,
         so leaving even a hold would have crews looking at a day reserved for
         work that is never happening. Pull the event; the date stays on the
         record. */
      if (String(q.status) === 'lost') {
        if (q.calendar_event_id && q.calendar_id) {
          const token = await googleAccessToken();
          try {
            await cal(token,
              `/calendars/${encodeURIComponent(q.calendar_id)}/events/${q.calendar_event_id}`,
              { method: 'DELETE' });
          } catch (e: any) { if (!/404/.test(String(e?.message))) throw e; }
        }
        const cleared = await db(`quotes?id=eq.${quoteId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            scheduled_date: date, crew_id: String(crewId),
            calendar_event_id: null, calendar_id: null,
            scheduled_at: new Date().toISOString(),
          }),
        });
        return json({ ok: true, removed: true, status: q.status, quote: cleared?.[0] });
      }

      /* Everything else goes on the calendar. Approved (won) as a solid booking;
         anything short of that as a HOLD -- visible, marked NOT APPROVED, shown
         Free rather than Busy. Same event either way, so approving a quote turns
         the hold solid in place instead of creating a second entry. */
      const hold = String(q.status) !== 'won';

      const target = calFor(crew);
      if (!target) return json({ error: noCalendarError(crew) }, 400);

      const token = await googleAccessToken();
      const body = eventBody(q, crew, { hold, holdColor: HOLD_COLOR });
      let ev;
      if (q.calendar_event_id && q.calendar_id) {
        // On one master calendar a crew change is just a PATCH -- the event
        // does not move, its colour, title and crewId change. The move call is
        // only reached if someone has set a per-crew override calendar.
        if (q.calendar_id !== target) {
          // Move rather than delete + recreate, so the event keeps its id and
          // any history on it.
          await cal(token,
            `/calendars/${encodeURIComponent(q.calendar_id)}/events/${q.calendar_event_id}` +
            `/move?destination=${encodeURIComponent(target)}`, { method: 'POST' });
        }
        ev = await cal(token,
          `/calendars/${encodeURIComponent(target)}/events/${q.calendar_event_id}`,
          { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        ev = await cal(token,
          `/calendars/${encodeURIComponent(target)}/events`,
          { method: 'POST', body: JSON.stringify(body) });
      }

      const saved = await db(`quotes?id=eq.${quoteId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          scheduled_date: date, crew_id: String(crewId),
          calendar_event_id: ev.id, calendar_id: target,
          scheduled_at: new Date().toISOString(),
        }),
      });
      return json({ ok: true, hold, status: q.status,
        event: { id: ev.id, htmlLink: ev.htmlLink }, quote: saved?.[0] });
    }

    /* ---- unschedule ---- */
    if (action === 'unschedule') {
      const { quoteId } = args;
      const rows = await db(`quotes?select=*&id=eq.${quoteId}`);
      const q = rows?.[0];
      if (!q) return json({ error: 'Quote not found' }, 404);
      if (q.calendar_event_id && q.calendar_id) {
        const token = await googleAccessToken();
        try {
          await cal(token,
            `/calendars/${encodeURIComponent(q.calendar_id)}/events/${q.calendar_event_id}`,
            { method: 'DELETE' });
        } catch (e: any) {
          // Already gone in Google is not an error worth blocking on.
          if (!/404/.test(String(e?.message))) throw e;
        }
      }
      const saved = await db(`quotes?id=eq.${quoteId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          scheduled_date: null, crew_id: null,
          calendar_event_id: null, calendar_id: null, scheduled_at: null,
        }),
      });
      return json({ ok: true, quote: saved?.[0] });
    }

    /* ---- ping: prove the whole chain works before trusting it ---- */
    if (action === 'ping') {
      const result: any = {
        signedIn: true, crews: crews.length,
        masterCalendarId: MASTER || null, calendars: {},
      };
      // Surface the identity the calendar must be shared with, read from the key
      // itself rather than from config -- so the answer is what is actually in
      // use, not what someone typed into a table. The key stays server-side; only
      // its client_email (a public identifier) is returned.
      try {
        const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT');
        if (raw) result.serviceAccount = JSON.parse(raw).client_email || null;
      } catch { /* reported below by googleAuth */ }
      if (!MASTER) {
        result.calendars['(master)'] =
          "not set — paste the Calendar ID into app_config key 'master_calendar_id'";
      }
      /* Stage 1 answers "is this thing deployed and configured?" without
         touching Google at all, so the app can prove that much in well under a
         second. Everything after here can be slow -- a cold start, a token
         exchange, a calendar read -- and the app runs it as a separate step so
         a rep can see WHICH part is taking the time rather than watching one
         undifferentiated spinner. */
      result.secretPresent = !!Deno.env.get('GOOGLE_SERVICE_ACCOUNT');
      if (args.skipGoogle) {
        result.stage = 'config';
        return json(result);
      }
      result.stage = 'full';
      try {
        const token = await googleAccessToken();
        result.googleAuth = 'ok';
        // Check each distinct calendar once, not once per crew.
        const seen = new Set<string>();
        for (const c of crews as any[]) {
          const calId = calFor(c);
          const label = c.calendar_id ? `${c.name} (own calendar)` : '(master)';
          if (!calId) { result.calendars[c.name] = 'no calendar configured'; continue; }
          if (seen.has(calId)) continue;
          seen.add(calId);
          try {
            const info = await cal(token, `/calendars/${encodeURIComponent(calId)}`);
            result.calendars[label] = `ok — "${info.summary}" (${info.timeZone || TZ})`;
          } catch (e: any) { result.calendars[label] = String(e?.message || e); }
        }
        result.crewColors = Object.fromEntries(
          (crews as any[]).map((c) => [c.name, c.calendar_color_id || '(none)']));
      } catch (e: any) {
        result.googleAuth = String(e?.message || e);
      }
      return json(result);
    }

    return json({ error: `Unknown action ${action}` }, 400);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const status = /session|signed in/i.test(msg) ? 401 : 500;
    console.log(JSON.stringify({ at: 'error', status, ms: Date.now() - t0, msg: msg.slice(0, 300) }));
    return json({ error: msg }, status);
  }
});
