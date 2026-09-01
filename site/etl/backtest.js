/* Time-ordered back-test of the quote engine.
 *
 * No leakage: for each quote we rebuild benchmarks and site history from ONLY
 * the quotes dated strictly before it, then ask the engine to predict drive
 * and blow hours, and compare against what the rep actually used.
 *
 * We also re-price each quote from its ACTUAL hours to confirm the pricing
 * arithmetic still reproduces the workbook's Projected Cost / Target Price.
 */
const fs = require('fs');
const path = require('path');
const Engine = require('./app/engine.js');

const B = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/bundle.json')));
const settings = B.settings;
const rateByName = {};
B.rate_card.forEach(r => { rateByName[r.product.toLowerCase()] = r; });

const quotes = B.quote_history
  .filter(q => q.quote_date && q.product && q.yards > 0 &&
               q.blow_hours != null && q.drive_hours != null)
  .sort((a, b) => a.quote_date < b.quote_date ? -1 : 1);

console.log(`Back-testing ${quotes.length} quotes, ` +
            `${quotes[0].quote_date} -> ${quotes[quotes.length - 1].quote_date}\n`);

/* ---- incremental state: everything the engine may look at, prior-only ---- */
const bySite = new Map();                 // site_key -> [quote,...]
const blowVals = new Map();               // "product|band" -> [hr/yd,...]
const driveVals = new Map();              // "type|key" -> [hr,...]

function pct(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round((s.length - 1) * p)))];
}
function benchSnapshot() {
  const out = [];
  for (const [k, v] of blowVals) {
    if (v.length < 3) continue;
    const [product, band] = k.split('|');
    out.push({
      product, volume_band: band, n: v.length,
      blow_hr_per_yard_p25: pct(v, .25),
      blow_hr_per_yard_median: pct(v, .50),
      blow_hr_per_yard_p75: pct(v, .75)
    });
  }
  return out;
}
function zoneSnapshot() {
  const out = [];
  for (const [k, v] of driveVals) {
    if (v.length < 3) continue;
    const i = k.indexOf('|');
    out.push({
      zone_type: k.slice(0, i), zone_key: k.slice(i + 1), n: v.length,
      drive_hours_p25: pct(v, .25),
      drive_hours_median: pct(v, .50),
      drive_hours_p75: pct(v, .75)
    });
  }
  return out;
}

const errBlow = [], errDrive = [], errEquip = [];
const inRange = { hit: 0, tot: 0 };
const byBasis = {};
const priceErr = [], targetErr = [];
let priced = 0, skippedNoCost = 0;

for (const qt of quotes) {
  const prior = bySite.get(qt.site_key) || [];
  const ctx = {
    product: qt.product, yards: qt.yards,
    city: qt.city, zip: qt.zip,
    siteHistory: { quotes: prior },
    blowBenchmarks: benchSnapshot(),
    driveZones: zoneSnapshot(),
    settings,
    prep: qt.prep_hours, helpers: qt.helpers      // hold constants fixed
  };

  // only score once there is *some* prior data to learn from
  const warm = blowVals.size > 0 && driveVals.size > 0;
  if (warm) {
    const h = Engine.estimateHours(ctx);
    errBlow.push(h.blow - qt.blow_hours);
    errDrive.push(h.drive - qt.drive_hours);
    if (qt.equip_hours != null) errEquip.push(h.equipHours - qt.equip_hours);

    const bb = h.blowBasis;
    if (bb.low != null && bb.high != null) {
      inRange.tot++;
      if (qt.blow_hours >= bb.low && qt.blow_hours <= bb.high) inRange.hit++;
    }
    const k = bb.basis;
    byBasis[k] = byBasis[k] || { n: 0, abs: [] };
    byBasis[k].n++;
    byBasis[k].abs.push(Math.abs(h.blow - qt.blow_hours));
  }

  /* ---- pricing check: use the rep's ACTUAL hours, compare to workbook ---- */
  // Only 2026 quotes: the rate card in the workbook is the CURRENT cost table,
  // so applying it to 2023-25 quotes would just be measuring cost inflation.
  const rc = rateByName[qt.product.toLowerCase()];
  const current = qt.quote_date >= '2026-01-01' && qt.equip_hours != null;
  if (current && rc && rc.cost_per_yard != null && qt.projected_cost) {
    const p = Engine.price({
      yards: qt.yards, rateCardRow: rc, settings,
      markupCurve: B.markup_curve,
      equipHours: qt.equip_hours, laborHours: qt.labor_hours
    });
    priceErr.push(p.cost - qt.projected_cost);
    if (qt.target_price) targetErr.push(p.targetPrice - qt.target_price);
    priced++;
  } else if (current && qt.projected_cost) skippedNoCost++;

  /* ---- now fold this quote into history for the next iteration ---- */
  if (qt.site_key) {
    if (!bySite.has(qt.site_key)) bySite.set(qt.site_key, []);
    bySite.get(qt.site_key).push(qt);
  }
  const hy = qt.blow_hours / qt.yards;
  if (hy > 0 && hy < 3) {
    for (const band of [Engine.volumeBand(qt.yards), 'ALL']) {
      const k = qt.product + '|' + band;
      if (!blowVals.has(k)) blowVals.set(k, []);
      blowVals.get(k).push(hy);
    }
  }
  if (qt.drive_hours > 0 && qt.drive_hours <= 8) {
    for (const [t, v] of [['city', qt.city], ['zip', qt.zip], ['default', '*']]) {
      if (!v) continue;
      const k = t + '|' + v;
      if (!driveVals.has(k)) driveVals.set(k, []);
      driveVals.get(k).push(qt.drive_hours);
    }
  }
}

/* ------------------------------------------------------------------ report */
function stats(a, label, unit) {
  const abs = a.map(Math.abs).sort((x, y) => x - y);
  const med = abs[Math.floor(abs.length / 2)];
  const p90 = abs[Math.floor(abs.length * 0.9)];
  const bias = a.reduce((s, x) => s + x, 0) / a.length;
  const within = (t) => (a.filter(x => Math.abs(x) <= t).length / a.length * 100).toFixed(0);
  console.log(`${label.padEnd(22)} n=${String(a.length).padStart(5)}  ` +
    `median |err| ${med.toFixed(2)}${unit}  p90 ${p90.toFixed(2)}${unit}  ` +
    `bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}${unit}  ` +
    `within .25${unit}: ${within(0.25)}%  within .5${unit}: ${within(0.5)}%`);
}

console.log('--- HOUR ESTIMATION (prior data only) ---');
stats(errDrive, 'Drive hours', 'h');
stats(errBlow, 'Blow hours', 'h');
stats(errEquip, 'Equipment hours', 'h');
console.log(`\nActual blow time fell inside the predicted p25-p75 range: ` +
  `${inRange.hit}/${inRange.tot} (${(inRange.hit / inRange.tot * 100).toFixed(0)}%)`);

console.log('\n--- BLOW ACCURACY BY WHICH TIER FIRED ---');
Object.entries(byBasis).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => {
  const s = v.abs.sort((a, b) => a - b);
  console.log(`  ${k.padEnd(15)} n=${String(v.n).padStart(5)}  ` +
    `median |err| ${s[Math.floor(s.length / 2)].toFixed(2)}h`);
});

console.log('\n--- PRICING ARITHMETIC (2026 quotes, actual hours -> workbook figures) ---');
const pe = priceErr.map(Math.abs).sort((a, b) => a - b);
const te = targetErr.map(Math.abs).sort((a, b) => a - b);
const exact = priceErr.filter(x => Math.abs(x) < 0.51).length;
console.log(`Projected Cost  n=${priced}  exact: ${exact} (${(exact / priced * 100).toFixed(0)}%)  ` +
  `median |err| $${pe[Math.floor(pe.length / 2)].toFixed(2)}`);
console.log(`Target Price    n=${te.length}  median |err| $${te[Math.floor(te.length / 2)].toFixed(2)}`);
console.log(`Skipped (product has no 2026 cost): ${skippedNoCost}`);
