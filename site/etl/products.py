"""Canonicalize ERP product descriptions to rate-card product names.

The ERP `Descr` field is free text typed by whoever entered the order, so a
single product appears under dozens of spellings:

    Econo Bark · ECONO BARK · ECONO--Bark · Econo-bark · ECONO - BARK ·
    Econo--BARK · ECONO---Bark · Econobark · Econo

Left unmerged these fragment into ~150 near-empty buckets and the per-product
hour benchmarks become useless. This maps them onto the ~30 names in the rate
card so ERP history and the rate card speak the same vocabulary.
"""
import re

# Words that describe a VARIANT, not a different product. Colour and freshness
# do not change how fast it blows, and the rate card has no separate row.
MODIFIERS = {
    'dark', 'darker', 'darkest', 'darkes', 'darh', 'fresh', 'freshest',
    'black', 'red', 'blk',
    'wholesale', 'retail', 'drop', 'ship', 'shipped',
    'recycled', 'rexius', 'premium', 'standard', 'custom',
    'the', 'and', 'with', 'w', 'all', 'nat', 'natural', 'organic', 'org',
    'bulk', 'yd', 'yds', 'yard', 'yards',
}

# Ordered rules: first match wins. Each is (required tokens, canonical name).
RULES = [
    (('econo',),                       'Econo-Bark'),
    (('beautibark',),                  'BeautiBark'),
    (('beauti', 'bark'),               'BeautiBark'),
    (('hemlock',),                     'Hemlock'),
    (('ultrakote',),                   'UltraKote'),
    (('decobark',),                    'DecoBark Nuggets'),
    (('deco', 'bark'),                 'DecoBark Nuggets'),
    (('fiberex',),                     'Fiberex'),
    (('microblend',),                  'Microblend'),
    (('turf', 'start'),                'Turf Start'),
    (('turfstart',),                   'Turf Start'),
    (('flower',),                      'Flower-n-Garden'),
    (('tree', 'shrub'),                'Tree-n-Shrub'),
    (('primary', 'planting'),          'Primary Planting Soil'),
    (('patio',),                       'Patio Potting Soil'),
    (('steer',),                       'Steer Plus'),
    (('alder', 'sawdust'),             'Alder Sawdust'),
    (('sawdust',),                     'Fresh Sawdust'),
    (('extra', 'fine'),                'Extra Fine Bark'),
    (('commercial', 'hog'),            'Commercial Hog'),
    (('garden', 'mulch'),              'Garden Mulch'),
    (('opus',),                        'Opus #1'),
    # --- composts: GVO is a distinct product from plain garden compost ---
    (('gvo',),                         'GVO Compost'),
    (('garden', 'valley'),             'GVO Compost'),
    (('worm',),                        'GVO Compost'),
    (('greenwaste',),                  'Garden Compost'),
    (('green', 'waste'),               'Garden Compost'),
    (('gw',),                          'Garden Compost'),
    (('food', 'waste'),                'Garden Compost'),
    (('compost',),                     'Garden Compost'),
    # --- rock ---
    (('3/8',),                         '3/8" round rock from RiverBend'),
    (('pea', 'gravel'),                '3/8" round rock from RiverBend'),
    (('quarter', 'ten'),               'Quarter Ten from RiverBend'),
    (('1/4', '10'),                    'Quarter Ten from RiverBend'),
    (('1/4-10',),                      'Quarter Ten from RiverBend'),
    (('3/4', 'open'),                  '3/4" open quarry from Coburg Quarry'),
    (('3/4', 'quarry'),                '3/4" open quarry from Coburg Quarry'),
    (('3/4', 'round'),                 '3/4" round rock from RiverBend'),
    (('3/4', 'crushed'),               '3/4" round rock from RiverBend'),
    (('3/4', 'pcc'),                   '3/4" round rock from RiverBend'),
    (('3/4',),                         '3/4" round rock from RiverBend'),
]

# Descriptions that are not products at all -- these are labour, fees,
# discounts, or a rep typing the job name into the product field.
NOT_A_PRODUCT = re.compile(
    r'\b(labor|labour|equipment|hours?|discount|disc|freight|fee|delivery|'
    r'donation|fertilizer|seeding|filter sock|erosion|school|mileage|misc)\b', re.I)


def tokens(descr):
    s = str(descr or '').lower()
    # keep fraction digits together (3/4, 3/8, 1/4), split everything else
    s = re.sub(r'[^a-z0-9/]+', ' ', s)
    return [t for t in s.split() if t and t not in MODIFIERS]


def canonical_product(descr):
    """ERP description -> rate-card product name, or None if not a product."""
    if not descr or not str(descr).strip():
        return None
    if NOT_A_PRODUCT.search(str(descr)):
        return None
    toks = set(tokens(descr))
    if not toks:
        return None
    for required, name in RULES:
        if all(any(t == r or t.startswith(r) for t in toks) for r in required):
            return name
    return None


if __name__ == '__main__':
    import csv, collections, sys, os
    D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
    rows = list(csv.DictReader(open(os.path.join(D, 'orders.csv'))))
    hit, miss = collections.Counter(), collections.Counter()
    for r in rows:
        p = r['primary_product']
        if not p:
            continue
        c = canonical_product(p)
        (hit if c else miss)[(p, c)] += 1
    mapped = sum(v for v in hit.values())
    print(f'ERP orders with a product: {mapped + sum(miss.values())}')
    print(f'  mapped   : {mapped}')
    print(f'  unmapped : {sum(miss.values())}')
    print(f'  distinct raw names: {len(set(k[0] for k in list(hit)+list(miss)))}'
          f' -> {len(set(k[1] for k in hit))} canonical')
    print('\nTop unmapped:')
    for (raw, _), n in miss.most_common(15):
        print(f'  {n:5}  {raw!r}')
