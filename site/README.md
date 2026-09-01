# Rexius Blower Quote CRM

A quoting tool for the blower services department. A rep searches a job address,
sees every past job and quote there, and gets a fresh quote priced from the
current rate card — with drive time and blow time pre-filled from what actually
happened at that address before.

**History is reference only.** Past prices are shown but never feed the
arithmetic. Every quote is computed from the current rate card and markup curve.
History informs only the two genuinely variable hour inputs — drive time and
blow time — and the rep can override both.

---

## What's in here

```
index.html                 the app (open this)
engine.js                  pricing + estimating engine, shared by app and tests
data/bundle.json           offline demo dataset
data/*.csv                 import files for Supabase
sql/00_setup_all.sql       EVERYTHING except the CSV import -- run this one
sql/01_schema.sql          tables, indexes, triggers
sql/02_rls.sql             row level security
sql/03_seed_reference.sql  rate card, markup curve, settings, benchmarks
sql/04_fix_zips.sql        one-off patch for ZIPs read from house numbers
sql/05_search_index.sql    site_index view that powers the search dropdown
sql/06_erp_products.sql    canonicalises ERP product names; adds orders.product
sql/07_merge_site_keys.sql re-unites sites split by a missing street suffix
sql/08_clean_contacts.sql  strips junk from the email and phone columns
diagnose.html              standalone Supabase connection checker
etl/                       ETL scripts and the browser test suite
```

## The pricing engine

Reverse-engineered from `Eugene Blower Pricing 2026 v2.xlsm` and verified
against that workbook's own Saved Quotes sheet.

```
equipment_hrs = prep + drive + blow
labor_hrs     = equipment_hrs × (1 + helpers)

cost  = product_cost_per_yd × yards
      + labor_rate × labor_hrs            $27.50 blended, or $70 prevailing wage
      + equip_rate × equip_hrs            $85/hr
      + overhead                          yards × $25/yd   when yards < 16
                                          equip_hrs × $145/hr when yards ≥ 16
price = cost × (1 + markup(yards))         20% @3yd, 10% @4yd, 2% @5–16yd, 3% @17yd+
```

Product cost per yard is the unit cost ÷ 7.5 (a truck unit is 7.5 yards).
Revenue splits backwards: labor and equipment bill at their rates and the
material line absorbs the rest of the bid.

**Verification:** the hours identity reproduced on 447/447 testable workbook
rows. Re-pricing 2026 quotes from their actual hours matches the workbook to a
median error of **$0.01**.

## How hours get estimated

Both fall back through tiers, and the app always shows which tier it used.

**Drive time:** prior quotes at this exact address → city/ZIP median → company
median (1.5 hr).

**Blow time:** prior jobs at this address for this product → prior jobs at this
address for a *different* product, rescaled by how much slower or faster this
address runs → product + volume-band median → product median → 0.10 hr/yd.

### Where blow time comes from

**The ERP, not the quote log.** The ERP has no explicit "blow time" column, but
it records *billed* equipment hours — what the blower truck actually ran. Across
the 18 products present in both sources the median ratio of ERP
equipment-hours-per-yard to quoted blow-hours-per-yard is **1.019**, so the two
are interchangeable, and the ERP is the better source: it is what happened and
was invoiced, over **4,244 observations against 2,247** in the quote log.

ERP descriptions are free text (`Econo Bark` / `ECONO BARK` / `ECONO--Bark` /
`Econo-bark` …), so they are canonicalised to rate-card names first — 172 raw
spellings collapse to 23 products, mapping 95.6% of orders. The rest are
genuinely not blow-in products (Terra Seeding, EcoBlanket, custom mixes).

Only `Patio Potting Soil` still falls back to quote-derived figures; the ERP has
no delivered rows for it. Every benchmark row records its `source`, and the app
says "delivered jobs" or "past quotes" accordingly.

### Accuracy

Back-tested time-ordered across **4,236 delivered orders**, predicting the
equipment hours each job actually billed. Each prediction sees only orders that
predate it:

| | Median error | Within 0.5 hr | Within 1 hr |
|---|---|---|---|
| All predictions | **0.34 hr** | 70% | 86% |

| Tier that fired | Orders | Median error |
|---|---|---|
| Product + volume band | 2,216 | 0.25 hr |
| Same address, same product | 1,468 | 0.50 hr |
| Same address, rescaled | 308 | 0.50 hr |
| Product average | 188 | 0.50 hr |
| No data | 56 | 0.50 hr |

**An honest caveat about site history.** An earlier back-test against the quote
log showed the site tier predicting with 0.00 hr error, which was an artifact:
reps copy their own previous quote for an address, so predicting a quote from
prior quotes there is self-fulfilling. Measured against what actually got
*billed*, site history is roughly neutral — mean absolute error 0.572 hr with it
versus 0.580 hr without. It is kept because it is informative to the rep and
does no harm, not because it measurably sharpens the estimate.

Drive time still comes from the quote log, because the ERP does not record it:
median error 0.25 hr, 86% within half an hour.

---

## Setup

### 1. Try it first (no setup)

The app runs offline against `data/bundle.json`. Because browsers block
`fetch` on `file://` URLs, serve the folder rather than double-clicking:

```bash
cd this-folder
python3 -m http.server 8000
# open http://localhost:8000
```

Quotes you save in demo mode stay in that browser only.

### 2. Create the Supabase project

At [supabase.com](https://supabase.com), create a project. From
**Project Settings → API**, copy the **Project URL** and the **anon public**
key. You'll need them in step 5.

Never put the `service_role` key in this file — it bypasses all security.

### 3. Run the setup

In the Supabase **SQL Editor**, run **`sql/00_setup_all.sql`**. That one file is
schema, security, reference data and the search view, in dependency order.

It ends by printing a row count for every table, so you can see exactly what
landed rather than trusting a "Success" message.

**Why one file.** The SQL editor runs a whole script as a single transaction.
Run the pieces out of order and one statement fails, rolling back *everything*
above it — including the rate card. The symptom is confusing: the editor reports
partial success, but the product dropdown in the app stays empty. `00_setup_all`
removes that failure mode. It is safe to re-run at any time, and re-running it
is the fix if the rate card is ever empty.

The individual files (`01_schema`, `02_rls`, `03_seed_reference`,
`05_search_index`) are still there if you want to read them, and each is now
self-guarding, but you should not need to run them separately.

### 4. Import the history

**Table Editor → (table) → Insert → Import data from CSV.** Import in this
order — `order_lines` references `orders`, so orders must exist first:

| Order | Table | File | Rows |
|---|---|---|---|
| 1 | `customers` | `data/customers.csv` | 1,823 |
| 2 | `sites` | `data/sites.csv` | 2,607 |
| 3 | `orders` | `data/orders.csv` | 4,553 |
| 4 | `order_lines` | `data/order_lines.csv` | 15,109 |
| 5 | `quote_history` | `data/quote_history.csv` | 2,251 |

These imports were tested end to end against PostgreSQL 16 — all 26,343 rows
load with no type errors and no orphaned foreign keys.

### 5. Point the app at Supabase

**Already done.** `index.html` ships with the live credentials baked into the
`CONFIG` block near the top of the script, so edits no longer need re-entering
them.

The value there is the **anon** key (role `anon`, project
`jmvciokrclgtsnlrtvwg`, expires 2036-08-22) and it is designed to be published —
every RLS policy requires an authenticated user, so the key alone reads nothing.

If you ever replace it, check the role first. A key whose role is
`service_role` bypasses all security and must never reach the browser. You can
decode any Supabase key by pasting it into jwt.io and reading the `role` claim.

To run against the offline demo data instead, blank both values.

### 6. Create the reps

**Authentication → Users → Add user**, one per sales associate, with
"Auto Confirm User" checked. A profile row is created automatically.

Then make yourself an admin — only admins can change the rate card:

```sql
update profiles set is_admin = true where full_name = 'taylora@rexius.com';
```

### 6b. If you already imported (patch)

Already loaded the data? Run **`sql/04_fix_zips.sql`**, then re-run
**`sql/03_seed_reference.sql`**. Nothing else needs re-importing.

This corrects ZIPs that the first address parser read out of house numbers —
`81372 Lost Creek Rd, Dexter` was being stored as ZIP 81372. 230 of 238 parsed
ZIPs were wrong, and every ZIP-based drive-time zone was built from them. The
patch recomputes all 2,251 rows and was verified to produce results identical
to the ETL, row for row.

### 6b2. Re-unite job sites split by a missing street suffix

Run **`sql/07_merge_site_keys.sql`**, then re-run **`sql/05_search_index.sql`**.

The ERP records `33860 Oak Springs Dr`; the quote log records
`33860 Oak Springs Coburg`. Stripping the city leaves `33860 oak springs`,
which does not equal `33860 oak springs dr` — so one property became two, and
its delivered history did not appear against the quote. 80 quote-side keys are
repointed at their ERP equivalent. Only unambiguous merges are applied: two
genuinely ambiguous cases (`1767 Walnut` matching both `Dr` and `St`) are left
alone rather than guessed at.

Re-running `05_search_index.sql` also strips the city and any trailing
punctuation from the displayed address, so `2096 Musket St Eugene` stops
reading as "2096 Musket St Eugene · Eugene".

### 6c. Canonicalise the ERP product names

Run **`sql/06_erp_products.sql`** — *after* the CSV import, because it backfills
existing rows. It adds `orders.product`, the rate-card name each free-text ERP
description maps to, and fills it for all 4,338 mapped orders.

Skip this only if you imported `orders.csv` from this same package, which
already contains the column.

### 7. Publish to GitHub Pages

```bash
git init
git add .
git commit -m "Blower quote CRM"
git branch -M main
git remote add origin https://github.com/YOURNAME/YOURREPO.git
git push -u origin main
```

Then **Settings → Pages → Source: Deploy from a branch → main / (root)**.
The app appears at `https://YOURNAME.github.io/YOURREPO/` within a minute or two.

Once Supabase is connected you can delete `data/bundle.json` (7 MB) — it's only
used for the offline demo.

---

## Troubleshooting

**The product dropdown is empty.** The `rate_card` table has no rows. Sign in,
open the **Rate Card** tab and read the **Data status** panel — it counts every
table and names the fix. Nine times out of ten the answer is to re-run
`sql/00_setup_all.sql`.

**The app says "Sign in to load your data".** That is correct, not a fault. Row
level security returns zero rows to a signed-out visitor, so the app looks empty
until you log in.

**It sits on "Loading from …".** The panel lists each request live and gives up
after 12 seconds with a diagnostic. `diagnose.html` runs the same requests
standalone. Note that the app must be served over http(s) in a real browser —
opening the file from disk, or inside an app preview pane, breaks `fetch`.

## Search

Click the search box and the list drops open on the most recently worked sites —
no typing needed. Typing narrows it, and **words match in any order**: `couey
cindy`, `cindy couey` and `couey spyglass` all find the same property. It also
matches city, ZIP, and every customer name a site has *ever* had, so an old
contact still finds it — searching `arbor south` turns up the site now billed
to Seven Bridge, Inc.

Arrow keys move through the list, Enter selects, Escape closes.

**Street suffixes are optional.** The ERP says `Oak Springs Dr`, a rep may
remember `Oak Springs Lane`. Requiring every word to match found nothing, so
suffix words (`dr`, `lane`, `ave`, `st`, …) no longer have to match — they just
score a bonus when they do, keeping an exact hit at the top.

This is powered by the `site_index` view (`sql/05_search_index.sql`), one
compact row per job site, loaded once in the background and filtered in the
browser. Without that view the app falls back to the old server-side substring
search — still works, but you have to type and word order matters. The
placeholder text tells you which mode you are in.

The view is declared `security_invoker`, so it honours row level security like
any table: a signed-out visitor gets zero rows, not the whole customer list.

## Autofill

Pick a site from the search box — or type a known address into the Address
field and tab out — and the app fills in customer name, phone, email, address,
city and ZIP, then pre-fills drive and blow time from that address's history.

Each field falls back across sources, because no single source has everything:
the most recent order, then the `sites` table, then the most recent quote, then
the customer record. An address with quotes but no delivered orders still gets
a ZIP from `sites`; a customer's email comes from the customer record when the
quote log has none.

A brand-new address fills nothing but the city parsed from what you typed, and
falls back to city and product averages for the hours — the panel says so.

## History at this address

Shows **delivered ERP jobs** — billed labor hours, billed equipment hours, and
the invoiced total, newest first.

Quotes are not mixed in, but they are not lost either. 814 addresses in the data
were quoted and never delivered (1,552 quote rows), and calling those "new
address" would invite a rep to re-quote blind. So an address with quotes but no
delivered work is tagged **"quoted, never delivered"** with a button to reveal
them, and an address with both shows the delivered timeline plus a "N prior
quotes not shown — Show" line.

## Contact details

The quote log's Email and Phone columns were used as scratch space, so they
cannot be trusted raw: **236 of 289 "emails" were not emails** — notes and
company names like `POWR`, `Bi-mart`, and *"This quote is X20 for the job. They
need 7000 linear foot..."* — and **155 of 852 "phones" were names** like
`Renee`.

Both are now validated in the ETL, in a one-off patch for data already loaded
(`sql/08_clean_contacts.sql`), and again in the browser before anything reaches
a form field. Phones are normalised to `(541) 206-5093`, and digits are rescued
from values like `Damion 541.206.5093` rather than the whole entry being
discarded.

That leaves 46 real emails in the quote log and 517 in the customer master. The
app takes the first value that actually validates — most recent quote, then the
customer record — so a blank field now means "we have no email", not "we have
something unusable".

## Drive-time reference

The drive-time box carries two links — **Coburg yard** and **Hwy 99 retail** —
that open Google Maps directions from that yard to the address on the quote.
No API key, no cost, always current with traffic.

It is a link rather than a live lookup on purpose: a Maps API key embedded in a
public GitHub Pages file is readable by anyone who views source, and billable to
you.

Beside the links it shows what that city has actually been billed, e.g.
*"0.75 hr round trip is the median billed for Coburg (22 jobs)"*.

**The two numbers are not the same thing.** Your `Drive` field is round trip and
clearly includes more than driving — Eugene's median is 1.25 hr round trip, or
38 minutes each way, against a Coburg→Eugene drive of roughly 15–20 minutes. So
Maps is a floor, not the figure to type in. The panel says so.

Yard addresses are the `YARDS` constant near the top of the script; edit there
if a yard moves.

## Delivered jobs, Requote, and the customer's other work

Each delivered job in **Delivered jobs at this address** names its customer in
the line and carries a **Requote** button: one click pulls that job's product
and volume back into the builder — the contact and address are already loaded
from the site — so "do it again like last time" becomes a priced quote in one
motion. Estimated hours re-derive from the current benchmarks and the price
from the current rate card; nothing is copied from what it cost back then.

Below it, **Other jobs for this customer** answers "have we worked for these
people anywhere else?". It searches by the **Customer #** field (the ERP
customer number), which autofills whenever a site with history loads and can be
typed over to look any account up directly. Jobs at the address you're quoting
are excluded — they're already in the history above.

The revenue split at the bottom of the quote carries the job facts in its
titles — *Material revenue · BeautiBark · 59 yd*, *Labor revenue · 16 hr*,
*Equipment revenue · 8 hr* — so the money always says what it is for.

Past quotes for an address are still visible in **History at this address**,
tagged `quoted` alongside `delivered` rows.

## Scheduling on Google Calendar

A saved quote can be put on the crew calendar from the **Schedule** card on the
quote form. Before picking a date, the rep sees what each crew already has that
day.

**Reps never authorise Google.** They sign into this app and schedule — no
consent screen, no "Connect Google" button, no hourly reconnect. A small Google
Apps Script owns every calendar write and runs inside Google as the calendar's
owner.

```
browser ──(Supabase session token)──> Apps Script ──> Google Calendar
   │                                      │
   └──> Supabase (quotes, crews)          └──> Supabase (re-reads the quote under RLS)
```

### How it got here

Two designs came before this one, and both worked in principle:

1. **Service account behind a Supabase Edge Function.** Needed a key deployed
   server-side, and that deployment kept failing — the Supabase dashboard editor
   reported "function updated" and then showed an empty editor.
2. **Browser OAuth**, where each rep authorised Google themselves. No key at
   all, but Google only issues browsers short-lived tokens with no offline
   renewal, so every rep had to reconnect roughly hourly.

Apps Script has neither problem: no key to store, and nobody to re-authorise.
The cost is one deployment, done once, from Google's own editor.

### How it is secured

The web app is deployed **Anyone**, because a browser has no Google identity to
offer it. That URL is therefore a capability, and the script does not trust it
alone:

1. Every request carries the caller's **Supabase session token**, checked
   against `/auth/v1/user`. No valid session, no work.
2. The quote is then re-read from Supabase **using that same token**, so
   row-level security applies exactly as it does in the app. A rep who cannot
   see a quote cannot book it.
3. **Hold-vs-approved is decided in the script**, from the status on the
   freshly-read row — never from anything the browser asserted. A tampered
   request cannot make an unapproved quote look sold.
4. `CALENDAR_ID` is a constant in the script. The caller never names a calendar,
   so a valid session cannot be turned into a write on some other calendar the
   account can reach.

Reps need **no Google permission on the calendar at all** now — the script does
the writing. Crew leads still get **See all event details** so they can read the
schedule.

### 8. Set up scheduling

**8a. Run the SQL.** Supabase SQL editor, in order: `sql/09_scheduling.sql`
through `sql/17_truck_capacity.sql`. All safe to re-run.

**8b. Create the script.** Go to <https://script.google.com> → **New project**.
Delete the placeholder `myFunction` and paste in all of `calendar-appscript.gs`.
Rename the project something like *Blower calendar service*.

The Calendar ID and Supabase details are already filled in at the top of the
file. If the calendar ever changes, `CALENDAR_ID` is the one line to edit.

**8c. Turn on the Calendar service.** In the left sidebar next to **Services**,
click **+**, choose **Google Calendar API**, and Add. The script uses
`Calendar.Events`, which only exists once that is added.

**8d. Deploy it.** **Deploy → New deployment → ⚙ → Web app**:

| Setting | Value | Why |
|---|---|---|
| Execute as | **Me** | so it acts as the calendar's owner and can write |
| Who has access | **Anyone** | the browser has no Google identity; the script checks the Supabase session instead |

Google will ask you to authorise the script the first time — that is you, once,
not your reps. Copy the **Web app URL**. It ends in `/exec`.

> The `/dev` URL shown in the editor only works while *you* are signed in as the
> script's owner. Reps would get a Google sign-in page. Always use `/exec`.

**8e. Give the app the URL.**

```sql
update app_config
   set value = 'https://script.google.com/macros/s/AKfy…/exec', updated_at = now()
 where key = 'apps_script_url';
```

**8f. Check it.** Sign in to the app, open the **Rate Card** tab and press
**Check** on the *Calendar connection* card:

| What it says | Fix |
|---|---|
| Calendar service URL — not set | 8e |
| URL shape — does not end in /exec | 8d — you copied the `/dev` URL |
| Calendar service — no answer in 25s | The URL is wrong, or **Who has access** is not **Anyone** |
| …answered with something that was not JSON | Same — Google returned a sign-in page instead of the script |
| Running as | Confirms which account writes the events. It needs **Make changes to events** on the calendar |
| Events readable — failed | That account cannot read the calendar. Share it with them |

All green means a real booking will work.

> **After editing the script, deploy a new version.** Saving the code does not
> change what the `/exec` URL runs: **Deploy → Manage deployments → ✏️ → Version:
> New version → Deploy.** This catches everyone at least once.

### What lands on the calendar

Bookings occupy a **timed slot**. The rep picks a start time, and the duration
defaults from the quote's own **equipment hours** — drive plus blow time, the
hours the crew is actually out — rounded to the quarter hour. The rep can type a
different duration and their number wins; the field says when it is following
the estimate. Times are stated in **America/Los_Angeles** explicitly, so a rep
booking from anywhere books Eugene time.

Leave the start time empty and the event falls back to **all-day** — for a job
where only the day is promised, not the hour.

When choosing a time, the crew-load line shows each crew's existing slots for
that day (`Crew #2 — 1 approved · 3 equip hr · 8:00 AM–11:00 AM`), so a rep can
see the gap they are booking into.

(Earlier builds were all-day only, on the grounds that just ~13% of historical
jobs carried a trustworthy clock time. Taylor overruled that, reasonably: the
duration here is not invented, it is the quote's own estimate.)

Events mirror the office's existing format exactly:

```
Title:  #56-BeautiBark (11) Caulleen Massingale        (HOLD prefix if unapproved)

Body:   Caulleen Massingale
        541.942.8380
        02-0104761
        SO: 0208260049
        PN: EB20267443

        1 load
        11 yds of BeautiBark
        Total: $985

        Notes from Quote:
        …

        Quote <id>

        Pre-Inspection Form:  (unique link, prefilled with this event's id and the address)
        Status:
        Pending pre-inspection

        Post-Job Inspection Form:  (unique link, prefilled with this event's id)
```

The **Account #, SO # and PN #** are quote fields — a compact row under Notes.
Type them into the app when the ERP assigns them, **not into the Google event**:
the app rewrites the event body on every save, so numbers typed straight into
Google would be lost on the next save.

The **# of loads** line is computed as `ceil(yards ÷ yards_per_load)`, with
`yards_per_load` in app_config defaulting to **15** — an assumption calibrated
to one known example (11 yds = 1 load). If the trucks hold more or less:

```sql
update app_config set value = '20' where key = 'yards_per_load';
```

### Inspection forms — built in at creation, in the office script's dialect

The office already runs a separate inspection Apps Script: a batch sweep that
adds prefilled form links to upcoming events, and form-submit triggers that
write the answers back into the event (a `Pre-Inspection Submitted:` link, a
filled `Status:` block, ✅/🔴/⚠️/🏁 icons on the title, Sage/Tomato/Banana
colours). This script speaks the same dialect, so the two coexist:

- **Links are built the same way** — `FormApp.createResponse().toPrefilledUrl()`
  against the same two forms (ids are constants at the top of
  `calendar-appscript.gs`), matching fields by title (`Event ID`, `Job
  Address`), never by a hardcoded entry number. Every event gets its unique
  prefilled links **the moment it is created** — no waiting for the sweep. If
  this account can't open a form (needs edit access), the base URLs in
  app_config (`pre_inspection_form` / `post_inspection_form`) are the fallback.
- **Blocks use the same labels** (`Pre-Inspection Form:` / `Status:` /
  `Post-Job Inspection Form:`), and the quote details sit as plain text at the
  top — exactly where the inspection script's reorder pass preserves free text.
- **Re-saves preserve inspection work.** Once a form is submitted, a save from
  the app keeps the `…Submitted:` link (and never re-offers the blank form),
  keeps the filled `Status:` and `Post-Job Status:` blocks, keeps the title
  icons, and keeps the inspection colour — the app's own colour only wins when
  the hold/approved state actually changes.

Two setup notes. First: using FormApp adds a Google Forms permission, so the
**first deploy after this change re-prompts for authorization** — accept it.
Second: the inspection script's `CONFIG.CALENDAR_ID` must point at the **same
calendar this script books on** (the master calendar id at the top of
`calendar-appscript.gs`), or its form-submit triggers won't find app-created
events. Its batch sweep becomes redundant for app-booked jobs but is harmless
to leave running — it skips events that already carry a link.

### Calendar → quote sync (optional, near-live)

Schedule changes made **on the calendar** flow back into the quote within about
a minute: drag an app-created event to another day or time and the quote's
date/time follow; resize it and the duration follows; delete it and the quote
shows *not on calendar* (its date and truck stay, so one press of Hold or
Schedule re-books it). Title and description edits deliberately do **not** flow
back — those are generated from the quote, and free text can't be parsed into
quote fields safely. Job facts change in the app; *when* can change in either
place.

One-time setup, in this order:

1. Supabase Dashboard → Authentication → **Add user**: e.g.
   `calendar-sync@rexius.com`, long random password, *Auto Confirm User* on.
   This is the identity the sync writes as — row-level security applies to it
   like any rep. (No service_role key anywhere.)
2. Apps Script → Project Settings → **Script properties** → add
   `SYNC_BOT_EMAIL` and `SYNC_BOT_PASSWORD` with those values.
3. In the script editor, run **`setupCalendarSync()`** once and grant the extra
   Calendar permission it asks for. It fails loudly right there if step 1–2
   are wrong.

No new deployment is needed — triggers run the saved code directly. The
trigger only looks at events stamped by this app, reconciles by comparing
first (the app's own writes come back as no-ops, so there is no echo loop),
and overlaps its lookback window so a slow write is never missed.

**Events added by hand in Google are left alone.** The script only edits or
deletes events it created — it stamps its own with the quote and crew id.
Anything else on the calendar is reported to the rep as *"also on the calendar"*
for that day, since it still eats into the day, but it is never attributed to a
crew and never touched.

### Three verbs: Save quote, Hold, Schedule

There is no status dropdown. The buttons are the status:

- **Save quote** files it in the Saved pile and leaves the calendar alone — and
  if the quote *was* holding a slot, that hold comes off, because the rep chose
  not to press Hold.
- **Hold** saves and places a grey HOLD on the picked date, truck and time
  slot. Pressing it again after edits updates the same hold.
- **Schedule** saves and books the slot as a confirmed job — or turns an
  existing hold solid, same event, no duplicate.
- **Mark lost** saves it as lost and removes any event.

Hold and Schedule refuse without a date and a truck; the message says so.
Every verb also saves the form, so updating a held job is one press of Hold —
there is no separate "update the calendar" step to forget. (An earlier build
had exactly that split, and it produced a hold that refused to become a
booking; the buttons exist so status and calendar can never disagree.)

**Remove booking** stays as the explicit way to take an entry off the calendar.
Clearing the date or crew and saving does *not* silently delete the event — the
save message tells you it is still out there and how to remove or move it.

### Suggested slots: the scheduling brain

Above the date field the app suggests the best slot **per truck**, computed from
the office's actual day shape: each truck runs about two jobs a day, job 1
starts at 7:30 AM (Truck #17 starts 10:00 AM on Mondays), job 2 starts 60
minutes after job 1 *ends* (drive back + reload), crews run Monday–Friday, and
nothing is suggested past a 4:30 PM start. The rules, in strict priority order —
a better rule later in the 14-day window beats a worse rule sooner:

1. **Share the load.** A scheduled job has the same product and this quote fits
   in the truck's remaining capacity → start when that job ends plus 15 minutes'
   travel. One load, two jobs, no reload.
2. **Same product.** Doesn't fit, but the product matches → the second slot of
   that day (reload, but no washout between products). Next best: the first slot
   of an empty day right after a day that *ended* on this product.
3. **Soonest open slot.**

One click on a suggestion fills the date, truck and start time. The starred row
is the best across both trucks.

**Capacities** come from the `truck_capacity` table — the Dept #32/#02
placement-truck sheet, keyed by rate-card product name. The sheet's two numbers
(dry and winter/wet) are both stored; which applies is the **Material is:
Dry / Winter-wet** toggle on the Rate Card tab (`app_config.capacity_mode`) —
the office flips it when material is wet, and every capacity check follows.
Products with no capacity row (Econo-Bark, Extra Fine Bark, the Opus line, …)
never get share-a-load suggestions, and the panel says so; add rows to
`truck_capacity` as numbers are established. Truck #17 is the only truck with
rock capacities (8 yds, per the sheet's footnote). Truck #58 is seeded in the
crews table but **inactive** — `update crews set active = true where id = '3';`
turns it on.

If a rep books over capacity by hand anyway (same truck, same day, same
product, too many yards), a note under the crew-load line says by how much and
that the trip will need its own reload — it warns, it doesn't block.

### Picking a time: chips and the live calendar

Under the slot fields the app offers **open starts as chips** — every half-hour
start in the working day (7:00–17:00) where the whole slot fits without
overlapping a timed event already booked on that crew. Tap one and the start
time is set. All-day entries can't block a time (they have no hours); they show
on the crew-load line instead.

The **Crew calendar** card sits at the bottom of the quote form, always
visible: the real Google Calendar embedded in the page, week view, Eugene time,
following whichever date is picked. One thing to know: the embed is Google's own
page rendered as the person viewing it, so each rep's Google account needs at
least read access to the calendar — share it with the reps (or the whole domain)
as **See all event details**. Booking does not need this; only the embedded view
does.

### Hold vs booked

Every scheduled quote goes on the calendar, but an unapproved one must never be
mistaken for sold work:

| Button pressed | Status stored | On the calendar as | Colour | Free/busy |
|---|---|---|---|---|
| Save quote | `draft` | nothing — any event is removed | — | — |
| Hold | `sent` | **HOLD** — pending approval | grey | Free |
| Schedule | `won` | confirmed job | crew colour | Busy |
| Mark lost | `lost` | nothing — removed | — | — |

A hold also says **⚠ NOT APPROVED — this is a hold, not a confirmed job** at the
top of the event body.

**Approving turns the same event solid.** Press **Schedule** on a held quote:
the hold's title, colour and free/busy change in place. It keeps its event id,
so nothing is duplicated and any comments on it survive. Press **Hold** on a
scheduled one and it becomes a hold again.

**A lost quote comes off entirely.** A hold means "waiting on approval"; a lost
quote isn't waiting on anything, and leaving even a grey block would have crews
reading a day as reserved for work that will never happen.

Holds show as **Free** rather than Busy so they mark the day without consuming
the crew in Google's own free/busy lookups.

### Capacity, approved and held

The crew-load line separates them, because "3 jobs" and "3 maybes" are very
different things to promise a customer against:

```
Crew #1   2 approved · 1 hold · 6.5 equip hr
Crew #2   0 approved · 0 equip hr
```

Capacity is judged on the whole day — a hold still reserves the crew — so the
*at capacity* warning counts holds and approved jobs together.

`crews.max_equip_hours` (default 8) and `crews.max_jobs` (default 4) drive it.
Those defaults come from your own history: the median crew-day is 2.25 equipment
hours and one job, and only 3.5% of crew-days go past 8 equipment hours.

```sql
update crews set max_equip_hours = 10, max_jobs = 5 where id = '2';
```

The warning is advisory — it never blocks a booking.

### Crew colours

Each crew gets a Google event colour so one calendar still reads at a glance.
Crew #1 is Basil (green), crew #2 Tangerine; holds are Graphite whatever the
crew. Colour ids: 1 Lavender, 2 Sage, 3 Grape, 4 Flamingo, 5 Banana, 6 Tangerine,
7 Peacock, 8 Graphite, 9 Blueberry, 10 Basil, 11 Tomato.

```sql
update crews      set calendar_color_id = '7' where id = '2';
update app_config set value = '5' where key = 'hold_color_id';   -- holds
```

Colours apply to events written from then on; existing events keep theirs until
the quote is next saved.

### The Saved Quotes tab

Quotes are filed in four piles, in the order they need attention:

- **On hold — awaiting confirmation**: holding a slot on a truck's calendar.
  These rows carry **Open**, **Schedule** and **Lost**.
- **Saved — not on the calendar**: saved with Save quote; holding nothing.
  These rows carry **Open** and **Lost** — plus **Hold** and **Schedule** when
  the quote already has a date and truck saved on it.
- **Won** and **Lost**: decided work, with **Open** only.

**The pile buttons carry the calendar with them.** Schedule writes the status
and runs the same server-side sync the quote-form buttons run — a grey HOLD
turns into a solid confirmed booking, same event, no duplicate. Lost removes
the event entirely. Neither asks "are you sure": both are one click to undo
(Open the quote and press the verb you meant), and the flash message says
exactly what happened to the calendar.

The **search box** filters all four piles at once, matching customer name,
address and city in any word order — `smith oak` finds the Smith quote on Oak St
whichever field each word lives in.

**Open** loads a quote back into the quote form with its booking attached —
schedule, move or unbook it there. There is one scheduling panel in the app, not
two that can disagree. Re-saving an opened quote updates it in place rather than
creating a second row, so the booking stays attached to the quote it belongs to.

### Trucks, and renaming them

The units are named for the trucks: **Truck #56** and **Truck #17** (run
`sql/14_trucks.sql`, which renames the original Crew #1/#2 rows). Names are
data, so a rename is one line and needs no redeploy anywhere — event titles,
the dropdown, the load line and the saved-quotes column all read `crews.name`.
Existing calendar events keep their old titles until each quote is next saved,
then converge on their own.

Adding a truck is a row, and needs nothing from Google:

```sql
insert into crews (id, name, calendar_color_id, active, sort_order)
values ('3', 'Truck #NN', '9', true, 3);
```

### What it costs

Nothing. Apps Script is included with Google Workspace. The script makes a
handful of calls per booking, against a daily quota in the tens of thousands.
There is no server to run and no API bill.

---

## Who can do what

| | Reps | Admins |
|---|---|---|
| Read history, quotes, rate card | yes | yes |
| Create quotes | yes | yes |
| Edit or delete a quote | own only | any |
| Change rate card, markup, settings | **no** | yes |
| Change history tables | **no** | **no** |
| Book work on the crew calendar | yes | yes |

Nothing is readable without signing in.

Reps need no Google permissions at all — the Apps Script does the writing, and it
only acts for a caller with a valid Supabase session who can already see the
quote under row-level security. Crew leads get read-only calendar access so they
can see the schedule without being able to alter it.

---

## Maintenance

**Prices change.** Update unit costs on the Rate Card tab (admin only). Cost per
yard recalculates automatically — it's a generated column, so it can never drift
out of sync with the unit cost.

**Six products have no 2026 cost** and are flagged `needs cost`: Extra Fine
Bark, Garden Mulch, Commercial Hog, Tree-n-Shrub, Opus Zero, and Quarter Ten
from RiverBend. They appear in the dropdown but won't price until you enter a
cost. Quarter Ten was quoted 21 times in the last two years, so it's worth
filling in first.

**Refreshing the benchmarks.** The blow-time and drive-time tables are derived
from history. Re-run the ETL against a fresh export and re-import
`blow_benchmarks.csv` and `drive_zones.csv` to fold in newer jobs.

---

## Known data issues

**439 orders** have a yardage in the job notes that disagrees with the `Qty`
field — e.g. a note reading "Blow in 23 yds of Beautibark" against a billed
`Qty` of 11. They're flagged `qty_mismatch` in the `orders` table. The hours
math trusts `Qty`. If your team treats the note as authoritative instead, that
flag is where to start.

**Only about 20% of saved quotes match a delivered order** in the ERP export.
The two sources are largely complementary — the quote log includes bids that
never converted, and the ERP export is Dept 02 only. The app shows both, which
is why an address can display "0 delivered, 3 quoted".

**A few site keys are not real addresses** — "Varied Schools" collapses 57
orders into one site. Harmless for quoting, but don't read it as one property.
