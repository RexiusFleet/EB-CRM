#!/usr/bin/env python3
"""
ETL: Rexius Dept 02 order export -> normalized CSVs for Supabase.

Input : Dept 02 20212026.xlsx  (one row per order line, header fields repeated)
Output: data/customers.csv, data/sites.csv, data/orders.csv, data/order_lines.csv
        data/product_stats.csv   (hours-per-yard benchmarks by product+volume band)
"""
import openpyxl, csv, re, os, sys, json, collections, statistics
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from addr import street_key, site_key as make_site_key, extract_city
from products import canonical_product
from contacts import clean_email, clean_phone

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    '~/.claude/projects/-home-claude/12cbdb16-281c-59b8-8a9d-1b95b84ac0c8/tool-results/'
    'project-file-ad113b6b-fef2-4d52-81cc-305aababbaee-Dept_02_20212026.xlsx')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(OUT, exist_ok=True)

LABOR_DESCR = 'Retail Labor Hours'
EQUIP_DESCR = 'Retail-Equipment Hours'
LABOR_ID, EQUIP_ID = '0220502', '0220503'

# ---------------------------------------------------------------- helpers

SUFFIX = {
    'avenue': 'ave', 'av': 'ave', 'ave': 'ave',
    'street': 'st', 'str': 'st', 'st': 'st',
    'road': 'rd', 'rd': 'rd',
    'drive': 'dr', 'dr': 'dr',
    'lane': 'ln', 'ln': 'ln',
    'court': 'ct', 'ct': 'ct',
    'boulevard': 'blvd', 'blvd': 'blvd',
    'place': 'pl', 'pl': 'pl',
    'terrace': 'ter', 'terr': 'ter', 'ter': 'ter',
    'circle': 'cir', 'cir': 'cir',
    'parkway': 'pkwy', 'pkwy': 'pkwy',
    'highway': 'hwy', 'hwy': 'hwy',
    'way': 'way', 'wy': 'way',
    'loop': 'loop', 'trail': 'trl', 'trl': 'trl',
    'square': 'sq', 'sq': 'sq',
    'north': 'n', 'south': 's', 'east': 'e', 'west': 'w',
    'northeast': 'ne', 'northwest': 'nw',
    'southeast': 'se', 'southwest': 'sw',
}


def norm_addr(addr, zip_code):
    """Job-site key. Delegates to the shared normalizer in addr.py so the ERP
    export and the free-text quote log resolve to the same key."""
    return street_key(addr)


def clean(v):
    if isinstance(v, str):
        v = v.strip()
        return v if v else None
    return v


def num(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def line_kind(descr, invt_id, ext, unit):
    d = (descr or '').lower()
    if invt_id == LABOR_ID or descr == LABOR_DESCR:
        return 'labor'
    if invt_id == EQUIP_ID or descr == EQUIP_DESCR:
        return 'equipment'
    if 'discount' in d or re.search(r'\bdisc\b', d) or 'donation' in d:
        return 'discount'
    if (ext or 0) < 0:
        return 'discount'
    if 'freight' in d or 'fee' in d or 'delivery' in d:
        return 'fee'
    return 'material'


SQFT_RE = re.compile(r'([\d][\d,]{1,9})\s*(?:sq\.?\s*ft|sf|square feet)\b', re.I)
DEPTH_RE = re.compile(r'(\d+(?:\.\d+)?|\d*\s*\d/\d)\s*(?:"|\'\'|\binch|\bin\b)', re.I)
YARDS_RE = re.compile(r'([\d][\d,]*(?:\.\d+)?)\s*(?:yds?\b|yards?\b|cy\b)', re.I)

FRAC = {'1/2': .5, '1/4': .25, '3/4': .75, '1/8': .125, '3/8': .375, '5/8': .625}


def parse_depth(txt):
    """Depth in inches from free-text notes. Everything is range-checked: these
    notes also contain phone numbers, and '653-2411\\n3/4"' will happily read as
    '2411 and 3/4 inches' unless both branches reject implausible values."""
    m = DEPTH_RE.search(txt or '')
    if not m:
        return None
    raw = m.group(1).strip()
    if '/' in raw:
        parts = raw.split()
        try:
            whole = float(parts[0]) if len(parts) > 1 else 0.0
        except ValueError:
            return None
        frac = FRAC.get(parts[-1])
        if frac is None:
            return None
        v = round(whole + frac, 3)
    else:
        try:
            v = float(raw)
        except ValueError:
            return None
    return v if 0 < v <= 12 else None


def parse_num(rx, txt):
    m = rx.search(txt or '')
    if not m:
        return None
    try:
        return float(m.group(1).replace(',', ''))
    except ValueError:
        return None


# ---------------------------------------------------------------- read

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
ws = wb.active
rows_iter = ws.iter_rows(values_only=True)
header = [str(h).strip() for h in next(rows_iter)]
IX = {h: i for i, h in enumerate(header)}


def G(row, key):
    return clean(row[IX[key]]) if key in IX else None


raw_orders = collections.OrderedDict()
for row in rows_iter:
    if row[IX['OrdNbr']] is None:
        continue
    raw_orders.setdefault(clean(row[IX['OrdNbr']]), []).append(row)

# ---------------------------------------------------------------- transform

orders, lines, sites, customers = [], [], {}, {}
mismatch_count = 0

for ord_nbr, lrows in raw_orders.items():
    h = lrows[0]
    ord_date = G(h, 'OrdDate')
    ship_addr = G(h, 'ShipAddr1') or G(h, 'Address Line 1')
    ship_zip = G(h, 'ShipZip') or G(h, 'Zip Code')
    ship_city = G(h, 'ShipCity') or G(h, 'City')
    site_key = norm_addr(ship_addr, ship_zip)
    cust_id = G(h, 'CustID')

    # ---- customer master
    if cust_id and cust_id not in customers:
        email = G(h, 'Email Address')   # validated below; 'nope@abc.com' is a
                                        # placeholder the ERP uses for "none"
        customers[cust_id] = {
            'cust_id': cust_id,
            'customer_name': G(h, 'Customer Name') or G(h, 'BillName'),
            'customer_class': G(h, 'Customer Class ID'),
            'cust_status': G(h, 'Cust Status'),
            'phone': clean_phone(G(h, 'Phone Number') or G(h, 'BillPhone')),
            'email': clean_email(email),
            'bill_addr1': G(h, 'Billing Address Line 1') or G(h, 'BillAddr1'),
            'bill_city': G(h, 'Billing City') or G(h, 'BillCity'),
            'bill_state': G(h, 'Billing State') or G(h, 'BillState'),
            'bill_zip': G(h, 'Billing Zip Code') or G(h, 'BillZip'),
            'sales_person_id': G(h, 'Sales Person ID'),
        }

    # ---- site master
    if site_key and site_key not in sites:
        sites[site_key] = {
            'site_key': site_key,
            # some ERP addresses end in a stray comma ("33860 Oak Springs Dr,")
            'address1': re.sub(r'[\s,]+$', '', ship_addr) if ship_addr else ship_addr,
            'address2': G(h, 'ShipAddr2'),
            'city': ship_city,
            'state': G(h, 'ShipState') or G(h, 'State'),
            'zip': re.sub(r'\D', '', ship_zip or '')[:5] or None,
            'attention': G(h, 'ShipAttn') or G(h, 'Attention'),
            'phone': clean_phone(G(h, 'ShipPhone')),
        }

    # ---- lines + rollups
    yards = labor_h = equip_h = 0.0
    mat_ext = lab_ext = eq_ext = disc_ext = fee_ext = 0.0
    products, discounts = [], []

    for r in lrows:
        descr, invt_id = G(r, 'Descr'), G(r, 'InvtID')
        qty, ext = num(G(r, 'Qty')) or 0.0, num(G(r, 'ExtPrice')) or 0.0
        unit = G(r, 'InvtUnit')
        kind = line_kind(descr, invt_id, ext, unit)

        lines.append({
            'ord_nbr': ord_nbr, 'line_nbr': G(r, 'LineNbr'), 'line_kind': kind,
            'invt_id': invt_id, 'descr': descr, 'qty': qty, 'unit': unit,
            'unit_price': round(ext / qty, 4) if qty else None,
            'ext_price': ext, 'rev_acct': G(r, 'RevAcct'),
        })

        if kind == 'material':
            mat_ext += ext
            if unit == 'YARD':
                yards += qty
            if descr:
                products.append((descr, qty, unit, ext, invt_id))
        elif kind == 'labor':
            labor_h += qty; lab_ext += ext
        elif kind == 'equipment':
            equip_h += qty; eq_ext += ext
        elif kind == 'discount':
            disc_ext += ext
            if descr:
                discounts.append({'descr': descr, 'amount': ext})
        elif kind == 'fee':
            fee_ext += ext

    primary = max(products, key=lambda p: p[3]) if products else None
    sum_descr, spcl = G(h, 'SumDescr'), G(h, 'Spcl Inst')
    note_blob = ' '.join(filter(None, [sum_descr, spcl]))
    note_yards = parse_num(YARDS_RE, note_blob)
    qty_mismatch = bool(note_yards and yards and abs(note_yards - yards) > 0.51)
    if qty_mismatch:
        mismatch_count += 1

    is_blow = bool(labor_h and equip_h and yards)

    orders.append({
        'ord_nbr': ord_nbr,
        'ord_date': ord_date.date().isoformat() if isinstance(ord_date, datetime) else None,
        'dlvry_date': (lambda d: d.date().isoformat() if isinstance(d, datetime) else None)(G(h, 'DlvryDate')),
        'cust_id': cust_id,
        'customer_name': G(h, 'Customer Name') or G(h, 'BillName'),
        'customer_class': G(h, 'Customer Class ID'),
        'site_key': site_key or None,
        'ship_addr1': re.sub(r'[\s,]+$', '', ship_addr) if ship_addr else ship_addr,
        'ship_city': ship_city,
        'ship_state': G(h, 'ShipState'),
        'ship_zip': re.sub(r'\D', '', ship_zip or '')[:5] or None,
        'sales_person_id': G(h, 'Sales Person ID'),
        'invc_nbr': G(h, 'InvcNbr'), 'invc_tot': num(G(h, 'InvcTot')),
        'order_type': 'blow_in' if is_blow else ('bulk_or_other'),
        'primary_product': primary[0] if primary else None,
        # ERP descriptions are free text; this is the rate-card name they map to
        'product': canonical_product(primary[0]) if primary else None,
        'primary_invt_id': primary[4] if primary else None,
        'primary_unit': primary[2] if primary else None,
        'total_yards': round(yards, 2) or None,
        'labor_hours': round(labor_h, 2) or None,
        'equip_hours': round(equip_h, 2) or None,
        'material_ext': round(mat_ext, 2),
        'labor_ext': round(lab_ext, 2),
        'equip_ext': round(eq_ext, 2),
        'discount_ext': round(disc_ext, 2),
        'fee_ext': round(fee_ext, 2),
        'labor_hr_per_yard': round(labor_h / yards, 4) if yards and labor_h else None,
        'equip_hr_per_yard': round(equip_h / yards, 4) if yards and equip_h else None,
        'sum_descr': sum_descr,
        'spcl_inst': spcl,
        'time_range': G(h, 'TimeRange'),
        'note_sqft': parse_num(SQFT_RE, note_blob),
        'note_depth_in': parse_depth(note_blob),
        'note_yards': note_yards,
        'qty_mismatch': qty_mismatch,
        'discounts_json': json.dumps(discounts) if discounts else None,
    })

# ---------------------------------------------------------------- benchmarks


def band(y):
    if y is None:
        return None
    for lo, hi, name in [(0, 10, '1-10'), (10, 20, '11-20'), (20, 35, '21-35'),
                         (35, 60, '36-60'), (60, 1e9, '60+')]:
        if lo < y <= hi:
            return name
    return None


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    k = max(0, min(len(sorted_vals) - 1, int(round((len(sorted_vals) - 1) * p))))
    return round(sorted_vals[k], 4)


buckets = collections.defaultdict(list)
for o in orders:
    if o['order_type'] != 'blow_in' or not o['labor_hr_per_yard']:
        continue
    b = band(o['total_yards'])
    if not b:
        continue
    for key in ((o['primary_product'], b), (o['primary_product'], 'ALL')):
        buckets[key].append(o)

stats = []
for (prod, b), os_ in sorted(buckets.items()):
    lab = sorted(x['labor_hr_per_yard'] for x in os_)
    eq = sorted(x['equip_hr_per_yard'] for x in os_ if x['equip_hr_per_yard'])
    yrs = sorted(x['ord_date'] for x in os_ if x['ord_date'])
    stats.append({
        'product': prod, 'volume_band': b, 'n_orders': len(os_),
        'labor_hr_per_yard_p25': pct(lab, .25),
        'labor_hr_per_yard_median': pct(lab, .5),
        'labor_hr_per_yard_p75': pct(lab, .75),
        'equip_hr_per_yard_p25': pct(eq, .25),
        'equip_hr_per_yard_median': pct(eq, .5),
        'equip_hr_per_yard_p75': pct(eq, .75),
        'first_order': yrs[0] if yrs else None,
        'last_order': yrs[-1] if yrs else None,
    })

# ---------------------------------------------------------------- write


def dump(name, recs, fields=None):
    path = os.path.join(OUT, name)
    if not recs:
        return
    fields = fields or list(recs[0].keys())
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(recs)
    print(f'  {name:22} {len(recs):>6} rows')


print('Writing CSVs:')
dump('customers.csv', list(customers.values()))
dump('sites.csv', list(sites.values()))
dump('orders.csv', orders)
dump('order_lines.csv', lines)
dump('product_stats.csv', stats)

blow = [o for o in orders if o['order_type'] == 'blow_in']
print(f'\nOrders: {len(orders)}  blow-in: {len(blow)}  bulk/other: {len(orders)-len(blow)}')
print(f'Customers: {len(customers)}   Sites: {len(sites)}')
sc = collections.Counter(o['site_key'] for o in orders if o['site_key'])
print(f'Sites with repeat business: {sum(1 for v in sc.values() if v>1)}')
print(f'Qty vs note-yardage mismatches flagged: {mismatch_count}')
print(f'Orders with parsed sq ft: {sum(1 for o in orders if o["note_sqft"])}, '
      f'with depth: {sum(1 for o in orders if o["note_depth_in"])}')
