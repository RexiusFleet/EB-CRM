"""Address normalization shared by both ETL passes and the app.

Job-site matching has to work across two very differently-formatted sources:
  ERP export   : structured columns, ZIP usually present
  Saved Quotes : one free-text field, ZIP usually absent, city often
                 appended with no comma ("2096 Musket St Eugene")

Strategy: reduce every address to a `street_key` (house number + normalized
street name, city/state/zip/unit stripped). That key alone is distinctive --
only 66 of 2,618 ERP street keys collide -- and it survives the missing ZIPs.
`site_key` keeps the ZIP when we have one, for display and disambiguation.
"""
import re

SUFFIX = {
    'avenue': 'ave', 'aven': 'ave', 'av': 'ave', 'ave': 'ave',
    'street': 'st', 'stret': 'st', 'str': 'st', 'st': 'st',
    'road': 'rd', 'rd': 'rd',
    'drive': 'dr', 'driv': 'dr', 'dr': 'dr',
    'lane': 'ln', 'ln': 'ln',
    'court': 'ct', 'crt': 'ct', 'ct': 'ct',
    'boulevard': 'blvd', 'blvd': 'blvd', 'blv': 'blvd',
    'place': 'pl', 'pl': 'pl',
    'terrace': 'ter', 'terr': 'ter', 'ter': 'ter',
    'circle': 'cir', 'cir': 'cir', 'crcl': 'cir',
    'parkway': 'pkwy', 'pkwy': 'pkwy', 'pky': 'pkwy',
    'highway': 'hwy', 'hwy': 'hwy',
    'way': 'way', 'wy': 'way',
    'loop': 'loop', 'trail': 'trl', 'trl': 'trl',
    'square': 'sq', 'sq': 'sq',
    'crossing': 'xing', 'xing': 'xing',
    'heights': 'hts', 'hts': 'hts',
    'ridge': 'rdg', 'rdg': 'rdg',
    'view': 'vw', 'vw': 'vw',
    'north': 'n', 'south': 's', 'east': 'e', 'west': 'w',
    'northeast': 'ne', 'northwest': 'nw',
    'southeast': 'se', 'southwest': 'sw',
    'saint': 'st', 'mount': 'mt', 'mt': 'mt',
    'mckenzie': 'mckenzie', 'mc': 'mc',
}

# Cities that appear glued onto the end of free-text quote addresses.
CITIES = [
    'eugene', 'springfield', 'spfld', 'spr', 'eug', 'coburg', 'creswell',
    'veneta', 'junction city', 'j city', 'j. city', 'jct city', 'harrisburg',
    'cottage grove', 'c grove', 'c. grove', 'goshen', 'pleasant hill',
    'marcola', 'walterville', 'leaburg', 'vida', 'blue river', 'lowell',
    'dexter', 'fall creek', 'elmira', 'noti', 'crow', 'florence', 'mapleton',
    'corvallis', 'albany', 'salem', 'philomath', 'monroe', 'brownsville',
    'halsey', 'sweet home', 'lebanon', 'roseburg', 'sutherlin', 'oakland',
    'winchester', 'coos bay', 'north bend', 'reedsport', 'bandon', 'newport',
    'waldport', 'yachats', 'toledo', 'sisters', 'bend', 'redmond', 'portland',
    'gresham', 'oakridge', 'westfir', 'drain', 'yoncalla', 'curtin',
    'deadwood', 'swisshome', 'triangle lake', 'blachly', 'alvadore',
    'santa clara', 'thurston', 'jasper', 'trent', 'agassiz', 'chilliwack',
]
CITY_RE = re.compile(r'[,\s]+(?:' + '|'.join(
    sorted((re.escape(c) for c in CITIES), key=len, reverse=True)) + r')\.?\s*$', re.I)

STATE_RE = re.compile(r'[,\s]+(?:or|ore|oregon|wa|washington|ca|bc)\.?\s*$', re.I)
ZIP_RE = re.compile(r'[,\s]+(\d{5})(?:-\d{4})?\s*$')
UNIT_RE = re.compile(
    r'\s+(?:apt|apartment|unit|ste|suite|bldg|building|lot|space|spc|#)\s*[\w-]*\s*$', re.I)
# "behind the barn", "back yard", parenthetical directions, phone-ish tails
NOISE_RE = re.compile(r'\((?:[^)]*)\)|\b(?:behind|back of|next to|across from)\b.*$', re.I)


def _strip_tail(s):
    """Peel state / city / zip / unit off the end, repeatedly."""
    prev = None
    while prev != s:
        prev = s
        s = ZIP_RE.sub('', s).strip().rstrip(',')
        s = STATE_RE.sub('', s).strip().rstrip(',')
        s = CITY_RE.sub('', s).strip().rstrip(',')
        s = UNIT_RE.sub('', s).strip().rstrip(',')
    return s


def street_key(addr):
    """House number + normalized street name. The primary join key."""
    if not addr:
        return ''
    s = str(addr).lower().strip()
    s = NOISE_RE.sub(' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = _strip_tail(s)
    s = re.sub(r'[.,#]', ' ', s)
    s = re.sub(r'\b(\d+)(?:st|nd|rd|th)\b', r'\1', s)   # 25th -> 25
    toks = [SUFFIX.get(t, t) for t in s.split() if t]
    # drop a leading directional duplicate and trailing empties
    key = ' '.join(toks).strip()
    return key if re.match(r'^\d', key) else key       # keep even if no house no.


HOUSE_NO_RE = re.compile(r'^\s*\d+[A-Za-z]?\s+')
ZIP_TAIL_RE = re.compile(r'\b(\d{5})(?:-\d{4})?[\s,.]*$')


def extract_zip(addr):
    """ZIP from a free-text address, or None.

    Two traps, both seen in the real data:
      '81372 Lost Creek Rd, Dexter'          house number, no ZIP at all
      'Sierra Pacific 90201 Hwy 99, Eugene'  house number after a business name

    Naively taking the first five digits turned 230 of 238 parsed ZIPs into
    house numbers. So: drop a leading house number, require the address to
    contain letters (a bare '23954' is not an address), and only accept a
    five-digit group sitting at the END, which is where a ZIP actually lives.
    """
    s = str(addr or '').strip()
    if not s:
        return None
    s = HOUSE_NO_RE.sub(' ', s)
    if not re.search(r'[A-Za-z]', s):
        return None
    m = ZIP_TAIL_RE.search(s)
    return m.group(1) if m else None


def extract_city(addr):
    if not addr:
        return None
    s = re.sub(r'\s+', ' ', str(addr)).strip()
    s = ZIP_RE.sub('', s).strip().rstrip(',')
    s = STATE_RE.sub('', s).strip().rstrip(',')
    m = CITY_RE.search(s)
    if m:
        c = m.group(0).strip(' ,.').title()
    else:
        parts = [p.strip() for p in s.split(',') if p.strip()]
        c = parts[-1].title() if len(parts) >= 2 else None
    if not c:
        return None
    fix = {'Spfld': 'Springfield', 'Spr': 'Springfield', 'Eug': 'Eugene',
           'C Grove': 'Cottage Grove', 'C. Grove': 'Cottage Grove',
           'J City': 'Junction City', 'J. City': 'Junction City'}
    return fix.get(c, c)


def site_key(addr, zip_code=None):
    """street_key plus ZIP when known -- used for display / disambiguation."""
    sk = street_key(addr)
    z = re.sub(r'\D', '', str(zip_code or ''))[:5] or extract_zip(addr) or ''
    return f'{sk}|{z}' if sk else ''
