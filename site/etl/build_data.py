#!/usr/bin/env python3
"""Fold the ETL CSVs into one JSON bundle used by (a) the node back-test and
(b) the app's offline demo mode. Numeric columns are coerced so the JS engine
never has to parse strings."""
import csv, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')

NUM = set("""yards qty ext_price unit_price total_yards labor_hours equip_hours
material_ext labor_ext equip_ext discount_ext fee_ext labor_hr_per_yard
equip_hr_per_yard note_sqft note_depth_in note_yards invc_tot n min_yards markup
value unit_cost cost_per_yard yards_per_unit prep_hours drive_hours blow_hours
helpers projected_cost target_price bid_amount material_rev labor_rev equip_rev
blow_hr_per_yard_p25 blow_hr_per_yard_median blow_hr_per_yard_p75
drive_hours_p25 drive_hours_median drive_hours_p75
labor_hr_per_yard_p25 labor_hr_per_yard_median labor_hr_per_yard_p75
equip_hr_per_yard_p25 equip_hr_per_yard_median equip_hr_per_yard_p75
n_orders""".split())
BOOL = {'needs_cost', 'active', 'qty_mismatch'}


def load(name):
    path = os.path.join(D, name)
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for row in csv.DictReader(f):
            r = {}
            for k, v in row.items():
                if v == '' or v is None:
                    r[k] = None
                elif k in BOOL:
                    r[k] = v.strip().lower() in ('true', '1', 'yes')
                elif k in NUM:
                    try:
                        r[k] = float(v)
                        if r[k] == int(r[k]):
                            r[k] = int(r[k]) if abs(r[k]) < 1e15 else r[k]
                    except ValueError:
                        r[k] = None
                else:
                    r[k] = v
            out.append(r)
    return out


bundle = {
    'customers':       load('customers.csv'),
    'sites':           load('sites.csv'),
    'orders':          load('orders.csv'),
    'quote_history':   load('quote_history.csv'),
    'rate_card':       load('rate_card.csv'),
    'markup_curve':    load('markup_curve.csv'),
    'settings':        {r['key']: r['value'] for r in load('settings.csv')},
    'blow_benchmarks': load('blow_benchmarks.csv'),
    'drive_zones':     load('drive_zones.csv'),
}

# order_lines is only needed for the line-level history panel; keep it lean
lines = load('order_lines.csv')
by_order = {}
for l in lines:
    by_order.setdefault(l['ord_nbr'], []).append({
        'k': l['line_kind'], 'd': l['descr'], 'q': l['qty'],
        'u': l['unit'], 'e': l['ext_price']
    })
bundle['order_lines'] = by_order

out = os.path.join(D, 'bundle.json')
with open(out, 'w') as f:
    json.dump(bundle, f, separators=(',', ':'))
print(f'{out}  {os.path.getsize(out)/1e6:.2f} MB')
for k, v in bundle.items():
    print(f'  {k:18} {len(v)}')
