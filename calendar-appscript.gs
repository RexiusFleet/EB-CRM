/**
 * Rexius Blower Quote CRM — calendar service.
 *
 * WHAT THIS IS
 * A Google Apps Script web app that owns all Calendar writes. It runs inside
 * Google as the calendar's owner, so nobody has to authorise anything: reps sign
 * into the CRM and that is the end of it. No service-account key, no Supabase
 * Edge Function, no hourly reconnect.
 *
 * HOW IT IS SECURED
 * The web app is deployed "Anyone", because the browser calls it without a
 * Google identity. That URL is therefore a capability, and this script does not
 * trust it on its own:
 *
 *   1. Every request must carry a valid Supabase session token, which is checked
 *      against /auth/v1/user. No token, no work.
 *   2. The quote is then re-read from Supabase USING THAT SAME TOKEN, so
 *      row-level security applies exactly as it does in the app. A rep who
 *      cannot see a quote cannot book it.
 *   3. Hold-vs-approved is decided HERE, from the status on the freshly-read
 *      row -- not from anything the caller sent. A tampered request cannot make
 *      an unapproved quote look sold.
 *   4. CALENDAR_ID is a constant below. The caller never names a calendar, so a
 *      valid session cannot be used to write into some other calendar this
 *      account can reach.
 *
 * WHY THE ODD REQUEST SHAPE
 * Apps Script web apps do not answer CORS preflight (OPTIONS) requests. So the
 * app sends a "simple request" -- POST, Content-Type text/plain, no custom
 * headers -- which browsers send without a preflight. That is why the session
 * token travels in the JSON body rather than an Authorization header.
 *
 * DEPLOYING
 *   Extensions/Apps Script -> paste this in -> Deploy -> New deployment
 *   Type: Web app
 *   Execute as:      Me            (so it acts as the calendar owner)
 *   Who has access:  Anyone        (the browser has no Google identity to offer)
 *   Copy the /exec URL into Supabase:
 *     update app_config set value = '<url>', updated_at = now()
 *      where key = 'apps_script_url';
 *
 * Re-deploy after any edit: Deploy -> Manage deployments -> edit -> New version.
 * Editing the code alone does NOT change what the /exec URL runs.
 */

/* ----------------------------------------------------------------- config -- */

var CALENDAR_ID = 'c_a3dfbea95d5ba6cbf5f7abfb741c05c98c5b296ca24ae2513c48b02561a3abf5@group.calendar.google.com';

var SUPABASE_URL = 'https://jmvciokrclgtsnlrtvwg.supabase.co';

// The anon key. Public by design -- every table is behind row-level security,
// so this key alone reads nothing. It is here so this script can call Supabase.
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptdmNpb2tyY2xndHNubHJ0dndnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0MjQ5MjMsImV4cCI6MjEwMzAwMDkyM30.x9DFKtyZGCxVTGKVUFXCn8iMveGiWmTzluikO6RmB10';

/* Bumped on every script change. The app's connection check compares this
   against what it expects, because editing the code does NOT change what the
   /exec URL runs -- only Deploy > Manage deployments > New version does, and
   forgetting that has repeatedly looked like a bug. */
var SCRIPT_VERSION = '2026-09-01-depth';

var HOLD_COLOR_DEFAULT = '8';   // Graphite
var TIMEZONE = 'America/Los_Angeles';

/* The inspection Google Forms -- EDITOR ids (docs.google.com/forms/d/<id>/edit),
   the same ids the office's inspection script uses. Each event gets a UNIQUE
   FormApp-prefilled link (Event ID + Job Address) the moment it is created, so
   no batch sweep is needed for app-booked jobs. If this account cannot open a
   form (no edit access), the base URLs in app_config
   (pre_inspection_form / post_inspection_form) are used as a fallback. */
var PRE_FORM_ID  = '1sRunScaTMnAS2L0VfqfpG36bdknaRVwCXVmD6B1GBY8';
var POST_FORM_ID = '11ASKIsm0Gyxq40B-Wp1TPbwYVKU-kDlSO4M8M99qQfE';

/* ------------------------------------------------------------- plumbing -- */

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sbFetch(path, options) {
  var opts = options || {};
  var headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: 'Bearer ' + (opts.token || SUPABASE_ANON_KEY),
    'Content-Type': 'application/json'
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  var res = UrlFetchApp.fetch(SUPABASE_URL + path, {
    method: opts.method || 'get',
    headers: headers,
    payload: opts.payload,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code < 200 || code >= 300) throw new Error('Supabase ' + code + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

/** Reject anything without a valid, current Supabase session. */
function requireUser(token) {
  if (!token) throw new Error('Not signed in — no session token was sent.');
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200)
    throw new Error('Your session was not accepted by Supabase — sign out and back in.');
  return JSON.parse(res.getContentText());
}

/* ------------------------------------------------------------ the event -- */

/* ---- interop with the office's inspection script -------------------------
   The office runs a separate Apps Script (batch sweep + form-submit triggers)
   that reads and writes labeled blocks in the event body:
     Pre-Inspection Form: / Pre-Inspection Submitted: / Status:
     Post-Job Inspection Form: / Post-Job Inspection Submitted: / Post-Job Status:
   and stamps status icons onto the title. This script writes the SAME labels
   with the SAME FormApp-built prefilled links at creation time, and when a
   quote is re-saved it PRESERVES whatever that script or a submitted form has
   already written -- the submitted-response link, the status block, the title
   icons, and the inspection colour. */

var INSPECTION_LABELS = ['Pre-Inspection Form:', 'Pre-Inspection Submitted:', 'Status:',
  'Post-Job Inspection Form:', 'Post-Job Inspection Submitted:', 'Post-Job Status:'];
var STATUS_ICONS = ['\u2705', '\ud83d\udd34', '\u26a0\ufe0f', '\ud83c\udfc1'];  // done, not ready, hazard, post-job
var INSPECTION_COLORS = { '2': true, '5': true, '11': true };  // Sage / Banana / Tomato, set on submit

/* Pull one labeled block (label line + its following lines, up to a blank line
   or the next known label; Post-Job Status runs to the end) out of an event
   body. Same block grammar as the inspection script's own parser. */
function extractBlock(text, label, toEnd) {
  var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  var got = [], keep = false;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t === label) { keep = true; got.push(lines[i]); continue; }
    if (keep) {
      if (toEnd) { got.push(lines[i]); continue; }
      if (t === '' || INSPECTION_LABELS.indexOf(t) >= 0) { keep = false; continue; }
      got.push(lines[i]);
    }
  }
  return got.join('\n').trim();
}

/* A unique prefilled URL, built with FormApp exactly like the office's script
   builds them -- so field matching is by title ('Event ID', 'Job Address'),
   never by a hardcoded entry number. Falls back to the app_config base URL if
   the form cannot be opened. */
function formPrefillUrl(formId, fields, fallback) {
  if (formId) {
    try {
      var form = FormApp.openById(formId);
      var by = {};
      form.getItems(FormApp.ItemType.TEXT).forEach(function (it) {
        by[it.asTextItem().getTitle().trim()] = it.asTextItem();
      });
      var resp = form.createResponse(), any = false;
      for (var title in fields) {
        if (by[title] && fields[title]) {
          resp = resp.withItemResponse(by[title].createResponse(String(fields[title])));
          any = true;
        }
      }
      if (any) return resp.toPrefilledUrl();
    } catch (err) { /* no edit access to the form, or Forms scope missing */ }
  }
  return fallback || '';
}

/* The icons the inspection script has stacked at the front of the title, so a
   re-save can put them back. */
function iconPrefix(summary) {
  var s = String(summary || '').trim(), out = [], changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < STATUS_ICONS.length; i++) {
      if (s.indexOf(STATUS_ICONS[i]) === 0) {
        out.push(STATUS_ICONS[i]);
        s = s.slice(STATUS_ICONS[i].length).trim();
        changed = true;
      }
    }
  }
  return out.length ? out.join(' ') + ' ' : '';
}

/* Title mirrors the office's manual format exactly:
     #56-BeautiBark (11) Caulleen Massingale
   The truck number is pulled out of crews.name, so a rename there flows here.
   A hold keeps its HOLD prefix, and any status icons the inspection script has
   stamped on the front survive the rewrite. */
function eventTitle(q, crew, hold, existingSummary) {
  var tno = (String(crew.name).match(/#\S+/) || [crew.name])[0];
  return iconPrefix(existingSummary) + (hold ? 'HOLD ' : '') + tno + '-' + (q.product || '') +
         ' (' + (q.yards || 0) + ') ' + (q.customer_name || '');
}

/* Body mirrors the office's template: contact block, ERP numbers, loads and
   volume, total, notes, inspection-form links. The ERP numbers (account, SO,
   PN) are quote fields -- typed into the app when known -- because the app
   REWRITES this body on every save, so anything typed straight into the Google
   event would be lost. Numbers belong on the quote.

   uid is the event's own iCalUID, prefly filled into the inspection forms so a
   submitted form ties back to this exact event. It only exists after the event
   does, which is why the description is patched in a second step. */
function eventDescription(q, hold, cfg, uid, existing, loadsOverride) {
  var ypl = Number(cfg && cfg.yards_per_load) > 0 ? Number(cfg.yards_per_load) : 15;
  var loads = loadsOverride > 0 ? loadsOverride
            : Math.max(1, Math.ceil((Number(q.yards) || 0) / ypl));
  var addressFull = [q.address_raw, q.city, q.zip].filter(function (x) { return x; }).join(', ');

  /* The quote block is plain free text at the top -- the inspection script's
     own reorder pass keeps unlabeled text at the top of the body, so the two
     scripts can rewrite the same event without eating each other's work. */
  var quoteBlock = [
    hold ? '\u26a0 NOT APPROVED \u2014 this is a hold, not a confirmed job.' : '',
    hold ? ('Quote status: ' + (q.status || 'draft') + '. It becomes a normal booking '
            + 'here when the quote is marked won.') : '',
    hold ? '' : null,
    q.customer_name || '',
    q.phone || '',
    /* ERP numbers are usually assigned AFTER a job is scheduled. Blank ones
       are omitted entirely -- an empty "SO:" line on the crew's event reads
       like something is missing. They appear as soon as the rep types them
       into the quote and presses Hold or Schedule again. */
    q.account_no || null,
    q.so_no ? 'SO: ' + q.so_no : null,
    q.project_no ? 'PN: ' + q.project_no : null,
    '',
    loads + ' load' + (loads === 1 ? '' : 's'),
    (q.yards || 0) + ' yds of ' + (q.product || '') +
      (Number(q.depth_in) > 0 ? ' at ' + Number(q.depth_in) + '" depth' : ''),
    'Total: $' + (q.bid_amount != null ? Number(q.bid_amount).toLocaleString() : ''),
    '',
    'Notes from Quote:',
    q.notes || '',
    '',
    'Quote ' + q.id
  ].filter(function (x) { return x !== null; }).join('\n');

  /* Unique prefilled links, FormApp first (field titles 'Event ID' and
     'Job Address', matching the inspection forms), app_config base URL as the
     fallback. uid is the event's own iCalUID -- the same id the inspection
     script prefills -- which only exists once the event does; a brand-new
     event gets its links in the second-pass patch. */
  var pre = '', post = '';
  if (uid) {
    var preFb = (cfg && cfg.pre_inspection_form)
      ? cfg.pre_inspection_form + '&entry.1980949741=' + encodeURIComponent(uid) +
        (addressFull ? '&entry.1804749231=' + encodeURIComponent(addressFull) : '')
      : '';
    var postFb = (cfg && cfg.post_inspection_form)
      ? cfg.post_inspection_form + '&entry.1980949741=' + encodeURIComponent(uid)
      : '';
    pre  = formPrefillUrl(PRE_FORM_ID,  { 'Event ID': uid, 'Job Address': addressFull }, preFb);
    post = formPrefillUrl(POST_FORM_ID, { 'Event ID': uid }, postFb);
  }

  /* Anything a submitted form has already written wins over a fresh link: once
     'Pre-Inspection Submitted:' exists, the blank form is never re-offered --
     the same rule the inspection script's own batch pass applies. */
  var preSub  = extractBlock(existing, 'Pre-Inspection Submitted:');
  var status  = extractBlock(existing, 'Status:');
  var postSub = extractBlock(existing, 'Post-Job Inspection Submitted:');
  var postSt  = extractBlock(existing, 'Post-Job Status:', true);

  var blocks = [
    preSub  || (pre  ? 'Pre-Inspection Form:\n' + pre : ''),
    status  || 'Status:\nPending pre-inspection',
    postSub || (post ? 'Post-Job Inspection Form:\n' + post : ''),
    postSt
  ].filter(function (x) { return x; });

  return [quoteBlock].concat(blocks).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function eventResource(q, crew, hold, holdColor, cfg, existing, opts) {
  opts = opts || {};
  /* Timed when a start time is on the quote; all-day otherwise. The duration is
     not invented -- it defaults from the quote's own equipment hours (drive +
     blow), which is how long the crew is actually out. The times are stated in
     the business's timezone explicitly, so a rep booking from anywhere books
     Eugene time. */
  var start, end;
  if (q.scheduled_time) {
    var hours = Number(q.scheduled_hours);
    if (!(hours > 0)) hours = Number(q.equip_hours) > 0 ? Number(q.equip_hours) : 2;
    hours = Math.max(0.5, Math.min(14, hours));   // a slot, not a typo
    var hm = String(q.scheduled_time).split(':');
    var startMin = (Number(hm[0]) || 0) * 60 + (Number(hm[1]) || 0);
    var endMin = Math.round(startMin + hours * 60);
    var fmt = function (min) {
      var d = new Date(q.scheduled_date + 'T00:00:00Z');
      d.setUTCMinutes(min);
      return d.toISOString().slice(0, 19);      // local wall time; timeZone below
    };
    start = { dateTime: fmt(startMin), timeZone: TIMEZONE };
    end   = { dateTime: fmt(endMin),   timeZone: TIMEZONE };
  } else {
    var next = new Date(q.scheduled_date + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    start = { date: q.scheduled_date };
    end   = { date: next.toISOString().slice(0, 10) };
  }
  /* Colour: ours marks hold-vs-approved; the inspection script's marks
     inspection outcome (Sage/Banana/Tomato). Ours wins when the hold state
     CHANGES -- that transition must be visible -- otherwise an inspection
     colour already on the event is left alone. */
  var wasHold = existing && existing.extendedProperties &&
                existing.extendedProperties['private'] &&
                existing.extendedProperties['private'].hold === 'true';
  var ourColor = String(hold ? (holdColor || HOLD_COLOR_DEFAULT)
                             : (crew.calendar_color_id || '')) || undefined;
  var color = (existing && wasHold === hold && INSPECTION_COLORS[String(existing.colorId)])
    ? String(existing.colorId) : ourColor;
  return {
    summary: eventTitle(q, crew, hold, existing && existing.summary) + (opts.suffix || ''),
    description: eventDescription(q, hold, cfg,
      existing && existing.iCalUID, existing && existing.description, opts.loads),
    location: [q.address_raw, q.city, q.zip].filter(function (x) { return x; }).join(', '),
    start: start,
    end: end,
    // Approved work takes the crew's colour; a hold takes one flat grey, because
    // approved-or-not is what a foreman needs to see first.
    colorId: color,
    // A hold shows as Free: it marks the day without consuming the crew in
    // Google's own free/busy. An approved job shows as Busy.
    transparency: hold ? 'transparent' : 'opaque',
    extendedProperties: {
      'private': {
        quoteId: String(q.id), crewId: String(crew.id),
        hold: hold ? 'true' : 'false', status: String(q.status || 'draft'),
        app: 'blower-crm'
      }
    }
  };
}

/* -------------------------------------------------------------- actions -- */

function actionList(args) {
  var date = String(args.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Bad date');
  var res = Calendar.Events.list(CALENDAR_ID, {
    timeMin: date + 'T00:00:00Z',
    timeMax: date + 'T23:59:59Z',
    singleEvents: true,
    maxResults: 250
  });
  var items = (res.items || []).map(function (e) {
    var p = (e.extendedProperties && e.extendedProperties['private']) || {};
    return { id: e.id, summary: e.summary, crewId: p.crewId || null,
             quoteId: p.quoteId || null, hold: p.hold === 'true',
             start: e.start, end: e.end };
  });
  return { date: date, events: items };
}

function actionSync(args, token) {
  var quoteId = args.quoteId, crewId = String(args.crewId || ''), date = String(args.date || '');
  if (!quoteId || !crewId || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('quoteId, crewId and date are required');
  // Optional slot. Not security-relevant (unlike status, which is read from the
  // stored row), so taking these from the request is fine.
  var time  = /^\d{2}:\d{2}$/.test(String(args.time || ''))  ? args.time : null;
  var hours = Number(args.hours) > 0 ? Number(args.hours) : null;

  /* Re-read the quote through the caller's own token. RLS applies, so a rep who
     cannot see this quote gets nothing back -- and the status we act on is the
     one in the database, not one the caller asserted. */
  var rows = sbFetch('/rest/v1/quotes?select=*&id=eq.' + encodeURIComponent(quoteId),
                     { token: token });
  var q = rows && rows[0];
  if (!q) throw new Error('Quote not found, or you do not have access to it.');
  q.scheduled_date = date;
  q.scheduled_time = time;
  q.scheduled_hours = hours;

  var crews = sbFetch('/rest/v1/crews?select=*&id=eq.' + encodeURIComponent(crewId),
                      { token: token });
  var crew = crews && crews[0];
  if (!crew) throw new Error('Unknown crew ' + crewId);

  var cfgRows = sbFetch('/rest/v1/app_config?select=key,value', { token: token });
  var cfg = {};
  (cfgRows || []).forEach(function (r) { cfg[r.key] = r.value; });

  var existingId = q.calendar_event_id || null;

  /* A hold means "waiting on approval". A lost quote is not waiting on
     anything, so it comes off entirely -- leaving even a grey block would have
     crews reading a day as reserved for work that will never happen. A draft
     ("Save quote" in the app) holds nothing either: the rep chose Save, not
     Hold or Schedule, and the calendar must say what the buttons said. */
  if (String(q.status) === 'lost' || String(q.status) === 'draft') {
    if (existingId) deleteQuietly(existingId);
    if (q.calendar_event_id2) deleteQuietly(q.calendar_event_id2);
    var cleared = patchQuote(quoteId, token, {
      scheduled_date: date, crew_id: crewId,
      scheduled_time: time, scheduled_hours: hours,
      calendar_event_id: null, calendar_id: null, calendar_event_id2: null,
      scheduled_at: new Date().toISOString()
    });
    return { removed: true, status: q.status, quote: cleared };
  }

  var hold = String(q.status) !== 'won';

  /* Load count from the truck's real capacity for this product (dry/wet per
     the office toggle), falling back to yards_per_load. Drives the "N loads"
     line in the body, and whether this is a split two-truck booking. */
  var capY = null;
  try {
    var capRows = sbFetch('/rest/v1/truck_capacity?select=dry_yards,wet_yards' +
      '&crew_id=eq.' + encodeURIComponent(crewId) +
      '&product=eq.' + encodeURIComponent(q.product || ''), { token: token });
    if (capRows && capRows[0]) {
      capY = Number(String(cfg.capacity_mode) === 'wet'
        ? capRows[0].wet_yards : capRows[0].dry_yards);
    }
  } catch (err) { capY = null; }
  var yplF = Number(cfg.yards_per_load) > 0 ? Number(cfg.yards_per_load) : 15;
  var loads = Math.max(1, Math.ceil((Number(q.yards) || 0) / (capY > 0 ? capY : yplF)));
  var split = loads > 1 && q.crew2_id;

  /* Read the event as it stands before rewriting it: the inspection script and
     submitted forms may have added blocks, icons and a colour that must
     survive this save. */
  var existing = null;
  if (existingId) {
    try { existing = Calendar.Events.get(CALENDAR_ID, existingId); }
    catch (err) { existing = null; }   // deleted in Google -- recreate below
  }
  var resource = eventResource(q, crew, hold, cfg.hold_color_id, cfg, existing,
    { loads: loads, suffix: split ? ' · load 1 of ' + loads : '' });

  var ev;
  if (existing) {
    // Patch in place, so approving a quote turns its hold solid rather than
    // creating a second entry -- the event keeps its id and its history.
    ev = Calendar.Events.patch(resource, CALENDAR_ID, existingId);
  } else {
    ev = Calendar.Events.insert(resource, CALENDAR_ID);
    /* Second pass, new events only: the prefilled inspection links carry the
       event's own iCalUID, and that id does not exist until the event does.
       One extra PATCH writes the final body. */
    try {
      ev = Calendar.Events.patch(
        { description: eventDescription(q, hold, cfg, ev.iCalUID, '', loads) },
        CALENDAR_ID, ev.id);
    } catch (err) { /* the event exists and is correct but for the links */ }
  }

  /* ---- the second load: its own event on the second truck ---- */
  var ev2Id = q.calendar_event_id2 || null;
  var ev2 = null;
  if (split) {
    var c2rows = sbFetch('/rest/v1/crews?select=*&id=eq.' +
      encodeURIComponent(q.crew2_id), { token: token });
    var crew2 = c2rows && c2rows[0];
    if (crew2) {
      var q2 = JSON.parse(JSON.stringify(q));
      q2.scheduled_time = /^\d{2}:\d{2}/.test(String(q.scheduled_time2 || ''))
        ? String(q.scheduled_time2).slice(0, 5) : time;
      q2.scheduled_date = date;
      q2.scheduled_hours = hours;
      var existing2 = null;
      if (ev2Id) {
        try { existing2 = Calendar.Events.get(CALENDAR_ID, ev2Id); }
        catch (err) { existing2 = null; }
      }
      var res2 = eventResource(q2, crew2, hold, cfg.hold_color_id, cfg, existing2,
        { loads: loads, suffix: ' · load 2 of ' + loads });
      res2.extendedProperties['private'].load = '2';
      if (existing2) {
        ev2 = Calendar.Events.patch(res2, CALENDAR_ID, ev2Id);
      } else {
        ev2 = Calendar.Events.insert(res2, CALENDAR_ID);
        try {
          ev2 = Calendar.Events.patch(
            { description: eventDescription(q2, hold, cfg, ev2.iCalUID, '', loads) },
            CALENDAR_ID, ev2.id);
        } catch (err) { /* body minus links */ }
      }
    }
  } else if (ev2Id) {
    // The second load was dropped (volume shrank, or the rep cleared the
    // second truck): its event comes off.
    deleteQuietly(ev2Id);
  }

  var saved = patchQuote(quoteId, token, {
    scheduled_date: date, crew_id: crewId,
    scheduled_time: time, scheduled_hours: hours,
    calendar_event_id: ev.id, calendar_id: CALENDAR_ID,
    calendar_event_id2: ev2 ? ev2.id : null,
    scheduled_at: new Date().toISOString()
  });
  return { hold: hold, status: q.status, loads: loads, split: !!split,
           event: { id: ev.id, htmlLink: ev.htmlLink }, quote: saved };
}

function actionRemove(args, token) {
  var quoteId = args.quoteId;
  if (!quoteId) throw new Error('quoteId is required');
  var rows = sbFetch('/rest/v1/quotes?select=id,calendar_event_id,calendar_event_id2&id=eq.' +
                     encodeURIComponent(quoteId), { token: token });
  var q = rows && rows[0];
  if (!q) throw new Error('Quote not found, or you do not have access to it.');
  if (q.calendar_event_id) deleteQuietly(q.calendar_event_id);
  if (q.calendar_event_id2) deleteQuietly(q.calendar_event_id2);
  var saved = patchQuote(quoteId, token, {
    scheduled_date: null, crew_id: null, crew2_id: null,
    scheduled_time: null, scheduled_hours: null, scheduled_time2: null,
    calendar_event_id: null, calendar_id: null, calendar_event_id2: null,
    scheduled_at: null
  });
  return { removed: true, quote: saved };
}

function deleteQuietly(eventId) {
  try {
    Calendar.Events.remove(CALENDAR_ID, eventId);
  } catch (err) {
    // Already gone in Google is not a failure worth blocking on.
    if (!/not found|deleted|410|404/i.test(String(err))) throw err;
  }
}

function patchQuote(quoteId, token, patch) {
  var out = sbFetch('/rest/v1/quotes?id=eq.' + encodeURIComponent(quoteId), {
    method: 'patch', token: token, prefer: 'return=representation',
    payload: JSON.stringify(patch)
  });
  return out && out[0];
}

function actionPing(user) {
  var cal = Calendar.Calendars.get(CALENDAR_ID);
  return {
    ok: true,
    version: SCRIPT_VERSION,
    user: user.email || user.id,
    calendar: cal.summary,
    timeZone: cal.timeZone,
    runningAs: Session.getEffectiveUser().getEmail()
  };
}

/* ----------------------------------------------------------------- entry -- */

function doPost(e) {
  var args = {};
  try {
    args = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return reply({ error: 'Request body was not valid JSON.' });
  }

  try {
    var user = requireUser(args.token);
    switch (args.action) {
      case 'ping':   return reply(actionPing(user));
      case 'list':   return reply(actionList(args));
      case 'sync':   return reply(actionSync(args, args.token));
      case 'remove': return reply(actionRemove(args, args.token));
      default:       return reply({ error: 'Unknown action ' + args.action });
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    // Google's calendar errors are terse; each of these has a different fix.
    if (/not found/i.test(msg) && /calendar/i.test(msg))
      msg = 'The calendar was not found. Check CALENDAR_ID at the top of the script.';
    else if (/permission|forbidden/i.test(msg))
      msg = 'This script’s account cannot edit that calendar. It needs '
          + '"Make changes to events" on it. (' + msg + ')';
    return reply({ error: msg });
  }
}

/** A GET is only ever a human checking the URL is alive -- so make that check
    count: it names the deployed version. If this differs from SCRIPT_VERSION
    at the top of the code you pasted, the deployment is stale or you are
    looking at a different deployment/project than the app uses. */
function doGet() {
  return reply({ ok: true, service: 'Blower Quote CRM calendar',
                 version: SCRIPT_VERSION,
                 note: 'POST with an action and a Supabase session token.' });
}

/* ================== calendar -> quote sync (optional) =====================
 *
 * The quote is the source of truth for WHAT the job is (product, yards,
 * price, contact). The calendar is where the office actually manages WHEN.
 * This trigger closes that loop: when someone drags an app-created event to
 * another day or time, resizes it, or deletes it, the quote's booking fields
 * follow within about a minute -- so the app's Saved Quotes list, crew-load
 * line and slot suggestions never argue with the calendar.
 *
 * Deliberately NOT synced: title and description edits. Those are generated
 * from the quote and rewritten on every Hold/Schedule (inspection blocks
 * excepted), and free text cannot be parsed back into quote fields safely.
 * Job facts change in the app; the schedule can change in either place.
 *
 * SETUP (once):
 *   1. Supabase Dashboard -> Authentication -> Add user: e.g.
 *      calendar-sync@rexius.com with a long random password ("Auto Confirm
 *      User" on). This is the identity the trigger writes as; RLS applies to
 *      it like any rep.
 *   2. Apps Script -> Project Settings -> Script properties -> add
 *      SYNC_BOT_EMAIL and SYNC_BOT_PASSWORD with those values.
 *   3. In the editor, run setupCalendarSync() once and grant the extra
 *      Calendar permission it asks for.
 * No new deployment is needed -- triggers run the saved code directly.
 */

function setupCalendarSync() {
  /* Two triggers, on purpose. The calendar trigger is near-live but has a
     known failure mode: it only fires when the watched calendar is in the
     script owner's own Google Calendar list, and when it silently isn't, no
     error appears anywhere. The clock trigger runs the SAME incremental pass
     every 5 minutes as a floor -- a quiet pass costs nothing (sync_since makes
     it a no-op), so the worst case is a move taking 5 minutes to land instead
     of one. */
  var handlers = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction() + ':' + t.getEventType();
  });
  if (handlers.indexOf('onCalendarChange:ON_EVENT_UPDATED') < 0) {
    ScriptApp.newTrigger('onCalendarChange')
      .forUserCalendar(CALENDAR_ID)
      .onEventUpdated()
      .create();
  }
  if (handlers.indexOf('onCalendarChange:CLOCK') < 0) {
    ScriptApp.newTrigger('onCalendarChange')
      .timeBased()
      .everyMinutes(5)
      .create();
  }
  PropertiesService.getScriptProperties()
    .setProperty('sync_since', String(Date.now()));
  syncBotToken();   // fail HERE, loudly, if the bot login is not set up
  return 'Calendar -> quote sync is on (event trigger + 5-minute safety net).';
}

/* Fires on ANY change to the calendar (Google does not say which event), so
   it asks for everything of OURS that changed since the last look and
   reconciles each. The app's own writes come back through here too and
   reconcile to a no-op -- compare-first prevents echo loops. */
function onCalendarChange() {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return; }   // another run has it
  try {
    var props = PropertiesService.getScriptProperties();
    var since = Number(props.getProperty('sync_since') || 0);
    var now = Date.now();
    // Overlap the window by 5 minutes so a slow write is never missed;
    // reconciliation is idempotent, so seeing a change twice is free.
    var updatedMin = new Date((since || (now - 3600000)) - 5 * 60 * 1000);
    var out = syncPass(updatedMin);
    Logger.log('calendar sync: ' + out.checked + ' changed, ' + out.patched + ' quotes updated');
    props.setProperty('sync_since', String(now));
    props.setProperty('sync_last_run', new Date(now).toISOString() +
      ' — ' + out.checked + ' changed, ' + out.patched + ' patched');
  } finally { lock.releaseLock(); }
}

/* One reconcile pass over everything of ours changed since updatedMin. */
function syncPass(updatedMin) {
  var items = [], page = null;
  do {
    var res = Calendar.Events.list(CALENDAR_ID, {
      privateExtendedProperty: 'app=blower-crm',   // only OUR events
      updatedMin: updatedMin.toISOString(),
      showDeleted: true, singleEvents: true, maxResults: 250,
      pageToken: page || undefined
    });
    items = items.concat(res.items || []);
    page = res.nextPageToken;
  } while (page);
  var patched = 0, firstErr = null;
  if (items.length) {
    var token = syncBotToken();
    items.forEach(function (ev) {
      try { if (reconcileEvent(ev, token)) patched++; }
      catch (err) {
        if (!firstErr) firstErr = String(err && err.message || err);
        Logger.log('sync skip ' + ev.id + ': ' + err);
      }
    });
  }
  return { checked: items.length, patched: patched, error: firstErr };
}

/* Run this BY HAND from the editor to force a pass over the last 24 hours and
   see exactly what it did -- the fastest way to test a drag you just made. */
function syncNow() {
  var out = syncPass(new Date(Date.now() - 24 * 3600 * 1000));
  var msg = 'Checked ' + out.checked + ' changed event(s), updated ' +
            out.patched + ' quote(s).';
  if (out.error) msg += ' PROBLEM: ' + out.error;
  Logger.log(msg);
  return msg;
}

/* Run this BY HAND when the sync seems dead. It tests every link in the chain
   and names the first broken one. Read the result in the execution log. */
function checkCalendarSync() {
  var lines = [];
  var props = PropertiesService.getScriptProperties();

  // 1. trigger installed?
  var trig = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'onCalendarChange';
  });
  var kinds = trig.map(function (t) { return String(t.getEventType()); });
  lines.push(trig.length
    ? 'OK    trigger installed (' + kinds.join(' + ') + ')'
    : 'FAIL  no trigger — run setupCalendarSync() once');
  if (trig.length && kinds.indexOf('CLOCK') < 0)
    lines.push('NOTE  no 5-minute safety-net trigger — re-run setupCalendarSync() to add it');

  // 2. credentials present?
  var haveCreds = props.getProperty('SYNC_BOT_EMAIL') && props.getProperty('SYNC_BOT_PASSWORD');
  lines.push(haveCreds
    ? 'OK    SYNC_BOT_EMAIL / SYNC_BOT_PASSWORD are set'
    : 'FAIL  Script properties missing — Project Settings > Script properties');

  // 3. bot can sign in? (bypass the cache so a rotated password shows up)
  if (haveCreds) {
    CacheService.getScriptCache().remove('sync_bot_token');
    try { syncBotToken(); lines.push('OK    bot signs in to Supabase'); }
    catch (e) { lines.push('FAIL  ' + e.message); }
  }

  // 4. calendar readable with the app filter?
  try {
    var res = Calendar.Events.list(CALENDAR_ID, {
      privateExtendedProperty: 'app=blower-crm',
      timeMin: new Date(Date.now() - 30 * 86400000).toISOString(),
      timeMax: new Date(Date.now() + 60 * 86400000).toISOString(),
      singleEvents: true, maxResults: 50
    });
    var n = (res.items || []).length;
    lines.push('OK    calendar readable — ' + n + ' app-created event(s) within -30/+60 days');
    if (!n) lines.push('NOTE  0 app events found: only events this app CREATED sync back. ' +
      'An event added by hand, or made before the app was deployed, never will.');
  } catch (e) {
    lines.push('FAIL  cannot list the calendar: ' + e.message);
  }

  // 5. can the bot actually WRITE a quote? RLS silently matches zero rows for
  //    a user without rights, so probe with a no-op patch and count rows back.
  try {
    var probeEvents = Calendar.Events.list(CALENDAR_ID, {
      privateExtendedProperty: 'app=blower-crm',
      timeMin: new Date(Date.now() - 30 * 86400000).toISOString(),
      timeMax: new Date(Date.now() + 60 * 86400000).toISOString(),
      singleEvents: true, maxResults: 10
    }).items || [];
    var probeId = null;
    for (var i = 0; i < probeEvents.length; i++) {
      var pp = (probeEvents[i].extendedProperties || {})['private'] || {};
      if (pp.quoteId) { probeId = pp.quoteId; break; }
    }
    if (probeId) {
      var tok = syncBotToken();
      var qr = sbFetch('/rest/v1/quotes?select=id,scheduled_at&id=eq.' +
        encodeURIComponent(probeId), { token: tok });
      if (qr && qr[0]) {
        var wrote = patchQuote(probeId, tok, { scheduled_at: qr[0].scheduled_at });
        lines.push(wrote
          ? 'OK    bot can update quotes'
          : 'FAIL  the sync user cannot update quotes — RLS matched zero rows. ' +
            'Run sql/18_sync_bot_admin.sql (makes the sync user an admin).');
      } else {
        lines.push('NOTE  could not read a quote to probe write access');
      }
    } else {
      lines.push('NOTE  no app event with a quote stamp to probe write access with');
    }
  } catch (e) {
    lines.push('FAIL  write probe errored: ' + e.message);
  }

  // 6. has the trigger ever actually run?
  lines.push('INFO  last trigger run: ' + (props.getProperty('sync_last_run') ||
    'never — if the trigger exists, check the Executions page for errors, and ' +
    'confirm this calendar is in your own Google Calendar list (the trigger ' +
    'only fires for calendars in the owner\u2019s list)'));

  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

function reconcileEvent(ev, token) {
  // Internal: called by the sync pass with one changed event. Running it from
  // the editor's Run menu passes no arguments -- use syncNow() or
  // checkCalendarSync() for hand-testing instead.
  if (!ev) { Logger.log('reconcileEvent is internal — run syncNow() instead.'); return false; }
  var p = (ev.extendedProperties && ev.extendedProperties['private']) || {};
  if (!p.quoteId) return;
  var rows = sbFetch('/rest/v1/quotes?select=id,scheduled_date,scheduled_time,' +
    'scheduled_hours,calendar_event_id,calendar_event_id2,scheduled_time2' +
    '&id=eq.' + encodeURIComponent(p.quoteId), { token: token });
  var q = rows && rows[0];
  if (!q) return;
  // Only reconcile events this quote currently points at. An old event the
  // app has already replaced must not drag the quote backwards.
  var isSecond = String(q.calendar_event_id2 || '') === String(ev.id);
  if (!isSecond && String(q.calendar_event_id || '') !== String(ev.id)) return;

  /* The load-2 event: only its start time and existence are quote fields
     (both loads share the project's date). */
  if (isSecond) {
    if (ev.status === 'cancelled') {
      patchQuote(q.id, token, { calendar_event_id2: null });
      return true;
    }
    if (ev.start && ev.start.dateTime) {
      var t2 = Utilities.formatDate(new Date(ev.start.dateTime), TIMEZONE, 'HH:mm');
      if (String(q.scheduled_time2 || '').slice(0, 5) !== t2) {
        if (!patchQuote(q.id, token, { scheduled_time2: t2 }))
          throw new Error('Supabase updated nothing — the sync user cannot edit quotes. ' +
            'Run sql/18_sync_bot_admin.sql.');
        return true;
      }
    }
    return false;
  }

  if (ev.status === 'cancelled') {
    // Deleted in Google: the booking is off. The date and truck stay on the
    // quote so the app shows "not on calendar" and one press of Hold or
    // Schedule puts it back.
    if (!patchQuote(q.id, token, { calendar_event_id: null, calendar_id: null }))
      throw new Error('Supabase updated nothing — the sync user cannot edit quotes. ' +
        'Run sql/18_sync_bot_admin.sql.');
    return true;
  }

  var patch = {};
  if (ev.start && ev.start.date) {                      // now an all-day event
    if (q.scheduled_date !== ev.start.date) patch.scheduled_date = ev.start.date;
    if (q.scheduled_time) { patch.scheduled_time = null; patch.scheduled_hours = null; }
  } else if (ev.start && ev.start.dateTime && ev.end && ev.end.dateTime) {
    var sd = new Date(ev.start.dateTime), ed = new Date(ev.end.dateTime);
    var date = Utilities.formatDate(sd, TIMEZONE, 'yyyy-MM-dd');
    var time = Utilities.formatDate(sd, TIMEZONE, 'HH:mm');
    var hours = Math.round(((ed - sd) / 3600000) * 4) / 4;   // quarter hours
    if (q.scheduled_date !== date) patch.scheduled_date = date;
    if (String(q.scheduled_time || '').slice(0, 5) !== time) patch.scheduled_time = time;
    if (Math.abs(Number(q.scheduled_hours || 0) - hours) > 0.01) patch.scheduled_hours = hours;
  }
  if (Object.keys(patch).length) {
    patch.scheduled_at = new Date().toISOString();
    if (!patchQuote(q.id, token, patch))
      throw new Error('Supabase updated nothing — the sync user cannot edit quotes. ' +
        'Run sql/18_sync_bot_admin.sql.');
    return true;
  }
  return false;
}

/* The trigger has no signed-in rep behind it, so it writes as a dedicated
   Supabase user -- credentials live in Script properties, never in code, and
   row-level security applies to it like anyone else. The service_role key is
   deliberately nowhere in this system. */
function syncBotToken() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('sync_bot_token');
  if (t) return t;
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('SYNC_BOT_EMAIL');
  var pw = props.getProperty('SYNC_BOT_PASSWORD');
  if (!email || !pw)
    throw new Error('Calendar sync needs SYNC_BOT_EMAIL and SYNC_BOT_PASSWORD in ' +
      'Project Settings -> Script properties (a dedicated Supabase user).');
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY },
    payload: JSON.stringify({ email: email, password: pw }),
    muteHttpExceptions: true
  });
  var j = {};
  try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (!j.access_token)
    throw new Error('Calendar-sync sign-in failed: ' +
      String(res.getContentText() || '').slice(0, 140));
  cache.put('sync_bot_token', j.access_token, 45 * 60);
  return j.access_token;
}
