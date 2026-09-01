/* Time-ordered back-test of the ERP-derived blow-time benchmark.
 *
 * Question: given product + yards, how well does the benchmark predict the
 * equipment hours the job actually billed?
 *
 * No leakage: benchmarks are rebuilt from only the orders dated strictly
 * before the one being predicted, exactly as the app would have known them.
 */
const fs = require('fs');
const path = require('path');
const Engine = require('./app/engine.js');

const B = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/bundle.json')));

const orders = B.orders
  .filter(o => o.order_type === 'blow_in' && o.product && o.ord_date &&
               +o.total_yards > 0 && +o.equip_hours > 0 &&
               (+o.equip_hours / +o.total_yards) < 3)
  .sort((a, b) => a.ord_date < b.ord_date ? -1 : 1);

console.log(`Back-testing ${orders.length} delivered blow-in orders, ` +
            `${orders[0].ord_date} -> ${orders[orders.length - 1].ord_date}\n`);

const pools = new Map();          // "product|band" -> [hr/yd,...]
const bySite = new Map();         // site_key -> [order,...]

function pct(a, p) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.max(0, Math.min(s.length - 1, Math.round((s.length - 1) * p)))];
}
function snapshot() {
  const out = [];
  for (const [k, v] of pools) {
    if (v.length < 3) continue;
    const i = k.lastIndexOf('|');
    out.push({
      product: k.slice(0, i), volume_band: k.slice(i + 1), n: v.length,
      blow_hr_per_yard_p25: pct(v, .25),
      blow_hr_per_yard_median: pct(v, .50),
      blow_hr_per_yard_p75: pct(v, .75)
    });
  }
  return out;
}

const err = [], byBasis = {}, inRange = { hit: 0, tot: 0 };
const perProduct = {};

for (const o of orders) {
  const yards = +o.total_yards, actual = +o.equip_hours;
  const warm = pools.size > 0;
  if (warm) {
    const est = Engine.estimateBlow({
      product: o.product, yards,
      blowBenchmarks: snapshot(),
      siteHistory: { orders: (bySite.get(o.site_key) || []), quotes: [] }
    });
    const e = est.hours - actual;
    err.push(e);
    const k = est.basis;
    (byBasis[k] = byBasis[k] || []).push(Math.abs(e));
    (perProduct[o.product] = perProduct[o.product] || []).push(Math.abs(e));
    if (est.low != null && est.high != null) {
      inRange.tot++;
      if (actual >= est.low && actual <= est.high) inRange.hit++;
    }
  }
  // fold in AFTER predicting
  const hy = actual / yards;
  for (const band of [Engine.volumeBand(yards), 'ALL']) {
    const k = o.product + '|' + band;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push(hy);
  }
  if (o.site_key) {
    if (!bySite.has(o.site_key)) bySite.set(o.site_key, []);
    bySite.get(o.site_key).push(o);
  }
}

const abs = err.map(Math.abs).sort((a, b) => a - b);
const bias = err.reduce((s, x) => s + x, 0) / err.length;
const within = t => (err.filter(x => Math.abs(x) <= t).length / err.length * 100).toFixed(0);

console.log('--- PREDICTING BILLED EQUIPMENT HOURS ---');
console.log(`n = ${err.length}`);
console.log(`median |err| ${abs[Math.floor(abs.length / 2)].toFixed(2)}h   ` +
            `p90 ${abs[Math.floor(abs.length * .9)].toFixed(2)}h   ` +
            `bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}h`);
console.log(`within 0.25h: ${within(0.25)}%   within 0.5h: ${within(0.5)}%   within 1h: ${within(1)}%`);
console.log(`actual fell inside the predicted p25-p75 range: ${inRange.hit}/${inRange.tot} ` +
            `(${(inRange.hit / inRange.tot * 100).toFixed(0)}%)`);

console.log('\n--- BY TIER ---');
Object.entries(byBasis).sort((a, b) => b[1].length - a[1].length).forEach(([k, v]) => {
  const s = v.sort((a, b) => a - b);
  console.log(`  ${k.padEnd(15)} n=${String(v.length).padStart(5)}  ` +
    `median |err| ${s[Math.floor(s.length / 2)].toFixed(2)}h`);
});

console.log('\n--- BY PRODUCT (top 10 by volume) ---');
Object.entries(perProduct).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
  .forEach(([k, v]) => {
    const s = v.sort((a, b) => a - b);
    console.log(`  ${k.slice(0, 30).padEnd(32)} n=${String(v.length).padStart(5)}  ` +
      `median |err| ${s[Math.floor(s.length / 2)].toFixed(2)}h`);
  });
