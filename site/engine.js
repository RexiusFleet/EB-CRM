/* ============================================================================
 * Rexius Blower Quote Engine
 * ----------------------------------------------------------------------------
 * Reverse-engineered from "Eugene Blower Pricing 2026 v2.xlsm" and verified
 * against 447 fully-testable rows of that workbook's own Saved Quotes sheet
 * (hours identity reproduced 447/447).
 *
 *   equipment_hrs = prep + drive + blow
 *   labor_hrs     = equipment_hrs * (1 + helpers)
 *
 *   cost  = product_cost_per_yd * yards
 *         + labor_rate    * labor_hrs
 *         + equip_rate    * equip_hrs
 *         + overhead                       // yards*OH_yd  if yards < threshold
 *                                          // equip_hrs*OH_hr  if yards >= threshold
 *   price = cost * (1 + markup(yards))
 *
 * Revenue splits backwards: labor and equipment bill at fixed rates and the
 * material line absorbs whatever is left of the bid.
 *
 * Blow-time benchmarks come from the ERP's billed equipment hours, not from
 * quoted blow time -- see etl_quotes.py for why the two are interchangeable
 * (median ratio 1.019) and why the ERP is the better source.
 *
 * HISTORY IS REFERENCE ONLY. Past extended prices are displayed to the rep but
 * never feed the arithmetic -- every quote is computed fresh from the current
 * rate card. History informs only the two genuinely variable HOUR inputs
 * (drive time and blow time), and the rep can override both.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    labor_rate_blended: 27.50,
    driver_wage: 30.0,
    helper_wage: 25.0,
    prevailing_wage: 70.0,
    equipment_rate: 85.0,
    overhead_per_yard: 25.0,
    overhead_per_equip_hour: 145.0,
    overhead_yard_threshold: 16.0,
    prep_hours_default: 0.5,
    helpers_default: 1.0,
    yards_per_unit: 7.5,
    default_drive_hours: 1.5
  };

  function round(n, step) {
    if (n === null || n === undefined || isNaN(n)) return null;
    step = step || 0.01;
    return Math.round(n / step) * step;
  }
  function q(n) { return round(n, 0.25); }          // hours land on quarter hours
  function money(n) { return Math.round(n * 100) / 100; }

  function median(a) {
    if (!a || !a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function volumeBand(y) {
    if (y == null) return null;
    if (y <= 10) return '1-10';
    if (y <= 20) return '11-20';
    if (y <= 35) return '21-35';
    if (y <= 60) return '36-60';
    return '60+';
  }

  /* ---------------------------------------------------------------- markup */
  // curve: [{min_yards, markup}] ascending. Yards at or above the last band
  // that is <= yards wins; below the first band we use the first band's rate.
  function markupFor(curve, yards) {
    if (!curve || !curve.length) return 0;
    var sorted = curve.slice().sort(function (a, b) { return a.min_yards - b.min_yards; });
    var m = sorted[0].markup;
    for (var i = 0; i < sorted.length; i++) {
      if (yards >= sorted[i].min_yards) m = sorted[i].markup; else break;
    }
    return m;
  }

  /* ------------------------------------------------------------ drive time */
  /* Tiered: this exact site -> city zone -> zip zone -> global default.
     Returns the value AND the basis, so the UI can always show its work. */
  function estimateDrive(ctx) {
    var s = Object.assign({}, DEFAULTS, ctx.settings || {});
    var hist = ctx.siteHistory || {};
    var quotes = (hist.quotes || []).filter(function (r) {
      return r.drive_hours != null && r.drive_hours > 0 && r.drive_hours <= 8;
    });
    if (quotes.length) {
      return {
        hours: q(median(quotes.map(function (r) { return r.drive_hours; }))),
        basis: 'site', n: quotes.length,
        detail: 'Median drive time on ' + quotes.length + ' prior quote' +
                (quotes.length > 1 ? 's' : '') + ' at this address'
      };
    }
    var zones = ctx.driveZones || [];
    function zone(type, key) {
      if (!key) return null;
      var k = String(key).toLowerCase();
      for (var i = 0; i < zones.length; i++) {
        if (zones[i].zone_type === type &&
            String(zones[i].zone_key).toLowerCase() === k) return zones[i];
      }
      return null;
    }
    var z = zone('city', ctx.city) || zone('zip', ctx.zip);
    if (z) {
      return {
        hours: q(z.drive_hours_median), basis: 'zone', n: z.n,
        detail: 'Median for ' + z.zone_key + ' (' + z.n + ' past quotes)'
      };
    }
    var d = zone('default', '*');
    return {
      hours: q(d ? d.drive_hours_median : s.default_drive_hours),
      basis: 'default', n: d ? d.n : 0,
      detail: 'Company-wide median - no history for this address or city'
    };
  }

  /* ------------------------------------------------------------- blow time */
  /* Tiered: same site+same product -> same site any product (scaled by the
     ratio of the two products' benchmark rates) -> product+volume band ->
     product overall -> global. Always returns hr/yd basis plus a p25-p75
     range so the rep sees the spread, not a false point estimate. */
  function estimateBlow(ctx) {
    var yards = ctx.yards, product = ctx.product;
    var bench = ctx.blowBenchmarks || [];
    var hist = ctx.siteHistory || {};

    /* Site-level observations, ERP first.
       Delivered orders record BILLED equipment hours -- what the blower truck
       actually ran -- so they beat a quoted estimate for the same address.
       Quotes fill in where the ERP has nothing. Both are reduced to the same
       shape: {product, yards, hours}. */
    var qs = [];
    (hist.orders || []).forEach(function (o) {
      var y = +o.total_yards, h = +o.equip_hours;
      if (o.order_type === 'blow_in' && y > 0 && h > 0 && h / y < 3) {
        qs.push({product: o.product || o.primary_product, yards: y,
                 blow_hours: h, src: 'delivered'});
      }
    });
    (hist.quotes || []).forEach(function (r) {
      if (r.blow_hours != null && r.yards > 0 && r.blow_hours > 0) {
        qs.push({product: r.product, yards: +r.yards,
                 blow_hours: +r.blow_hours, src: 'quoted'});
      }
    });

    function benchFor(prod, band) {
      for (var i = 0; i < bench.length; i++) {
        if (bench[i].product === prod && bench[i].volume_band === band) return bench[i];
      }
      return null;
    }
    var band = volumeBand(yards);
    var bBand = benchFor(product, band);
    var bAll = benchFor(product, 'ALL');
    var b = bBand && bBand.n >= 5 ? bBand : (bAll || bBand);

    // Tier 1 -- same address, same product
    var same = qs.filter(function (r) { return r.product === product; });
    if (same.length) {
      var rate = median(same.map(function (r) { return r.blow_hours / r.yards; }));
      var nDeliv = same.filter(function (x) { return x.src === 'delivered'; }).length;
      return {
        hours: q(rate * yards), hrPerYard: rate, basis: 'site_product', n: same.length,
        low: b ? q(b.blow_hr_per_yard_p25 * yards) : null,
        high: b ? q(b.blow_hr_per_yard_p75 * yards) : null,
        detail: same.length + ' prior ' + product + ' job' + (same.length > 1 ? 's' : '') +
                ' at this address (' +
                (nDeliv ? nDeliv + ' delivered' + (nDeliv < same.length
                    ? ', ' + (same.length - nDeliv) + ' quoted' : '')
                        : 'quoted') + ', ' + rate.toFixed(3) + ' hr/yd)'
      };
    }
    // Tier 2 -- same address, different product: keep the site's difficulty
    // factor but re-base it onto the requested product.
    if (qs.length && bAll) {
      var siteRate = median(qs.map(function (r) { return r.blow_hours / r.yards; }));
      var otherProd = qs[0].product;
      var ob = benchFor(otherProd, 'ALL');
      if (ob && ob.blow_hr_per_yard_median > 0) {
        var factor = siteRate / ob.blow_hr_per_yard_median;
        factor = Math.max(0.5, Math.min(2.0, factor));       // clamp outliers
        var r2 = bAll.blow_hr_per_yard_median * factor;
        return {
          hours: q(r2 * yards), hrPerYard: r2, basis: 'site_scaled', n: qs.length,
          low: q(bAll.blow_hr_per_yard_p25 * yards),
          high: q(bAll.blow_hr_per_yard_p75 * yards),
          detail: 'This address blows ' + (factor >= 1 ? (factor).toFixed(2) + 'x slower' :
                  (1 / factor).toFixed(2) + 'x faster') + ' than average (' + qs.length +
                  ' prior job' + (qs.length > 1 ? 's' : '') + '), applied to ' + product
        };
      }
    }
    // Tier 3/4 -- product benchmark
    if (b) {
      return {
        hours: q(b.blow_hr_per_yard_median * yards),
        hrPerYard: b.blow_hr_per_yard_median,
        basis: b === bBand ? 'product_band' : 'product', n: b.n,
        low: q(b.blow_hr_per_yard_p25 * yards),
        high: q(b.blow_hr_per_yard_p75 * yards),
        // Say which source the figure came from -- delivered ERP jobs and
        // quoted estimates carry different weight to a rep.
        detail: b.n + ' ' + (b.source === 'quote_blow_hours'
                  ? 'past ' + product + ' quotes'
                  : 'delivered ' + product + ' jobs') +
                (b === bBand ? ' at ' + band + ' yards' : '') +
                ' (' + b.blow_hr_per_yard_median.toFixed(3) + ' hr/yd)'
      };
    }
    return {
      hours: q(0.1 * yards), hrPerYard: 0.1, basis: 'fallback', n: 0,
      low: null, high: null,
      detail: 'No history for this product - generic 0.10 hr/yd. Verify before quoting.'
    };
  }

  /* ------------------------------------------------------------ full hours */
  function estimateHours(ctx) {
    var s = Object.assign({}, DEFAULTS, ctx.settings || {});
    var drive = estimateDrive(ctx);
    var blow = estimateBlow(ctx);
    var prep = ctx.prep != null ? ctx.prep : s.prep_hours_default;
    var helpers = ctx.helpers != null ? ctx.helpers : s.helpers_default;
    var equip = prep + drive.hours + blow.hours;
    return {
      prep: prep, drive: drive.hours, blow: blow.hours, helpers: helpers,
      equipHours: round(equip, 0.01),
      laborHours: round(equip * (1 + helpers), 0.01),
      driveBasis: drive, blowBasis: blow
    };
  }

  /* ---------------------------------------------------------------- price */
  function price(ctx) {
    var s = Object.assign({}, DEFAULTS, ctx.settings || {});
    var yards = ctx.yards;
    var prod = ctx.rateCardRow || null;
    var costPerYard = prod && prod.cost_per_yard != null ? prod.cost_per_yard : null;

    var equipHours = +ctx.equipHours || 0, laborHours = +ctx.laborHours || 0;
    var laborRate = ctx.prevailingWage ? s.prevailing_wage : s.labor_rate_blended;

    var materialCost = costPerYard == null ? null : costPerYard * yards;
    var laborCost = laborRate * laborHours;
    var equipCost = s.equipment_rate * equipHours;
    var overhead = yards < s.overhead_yard_threshold
      ? yards * s.overhead_per_yard
      : equipHours * s.overhead_per_equip_hour;
    var overheadBasis = yards < s.overhead_yard_threshold
      ? yards + ' yd x $' + s.overhead_per_yard + '/yd'
      : equipHours.toFixed(2) + ' equip hr x $' + s.overhead_per_equip_hour + '/hr';

    var missingCost = costPerYard == null;
    var cost = missingCost ? null
      : materialCost + laborCost + equipCost + overhead;
    var mk = markupFor(ctx.markupCurve, yards);
    var target = cost == null ? null : cost * (1 + mk);
    var bid = ctx.bidAmount != null ? ctx.bidAmount : target;

    // Revenue split: labor + equipment bill at rate, material takes the rest.
    var laborRev = laborRate * laborHours;
    var equipRev = s.equipment_rate * equipHours;
    var materialRev = bid == null ? null : bid - laborRev - equipRev;

    var grossMargin = (bid == null || cost == null || !bid) ? null : (bid - cost) / bid;

    return {
      missingCost: missingCost,
      costPerYard: costPerYard,
      materialCost: money(materialCost),
      laborCost: money(laborCost),
      equipCost: money(equipCost),
      overhead: money(overhead),
      overheadBasis: overheadBasis,
      laborRate: laborRate,
      cost: money(cost),
      markup: mk,
      targetPrice: money(target),
      bidAmount: money(bid),
      materialRev: money(materialRev),
      laborRev: money(laborRev),
      equipRev: money(equipRev),
      grossMargin: grossMargin,
      unitsOfTruck: s.yards_per_unit ? round(yards / s.yards_per_unit, 0.01) : null
    };
  }

  function quote(ctx) {
    var hours = ctx.hoursOverride || estimateHours(ctx);
    var p = price(Object.assign({}, ctx, {
      equipHours: hours.equipHours, laborHours: hours.laborHours
    }));
    return { hours: hours, price: p };
  }

  return {
    DEFAULTS: DEFAULTS,
    volumeBand: volumeBand,
    markupFor: markupFor,
    estimateDrive: estimateDrive,
    estimateBlow: estimateBlow,
    estimateHours: estimateHours,
    price: price,
    quote: quote,
    _median: median,
    _round: round
  };
}));
