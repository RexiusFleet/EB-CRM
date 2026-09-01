"""Validate and normalise contact details.

The quote log's Email and Phone columns are free text and reps used them as
scratch space: 236 of 289 "emails" are notes or company names ("POWR",
"Bi-mart", "This quote is X20 for the job..."), and 155 of 852 "phones" are
names. Anything that reaches the app's contact fields must be checked, or a
rep sees a sentence where an address's email should be.
"""
import re

EMAIL_RE = re.compile(r'^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$')


def clean_email(v):
    """Return a valid-looking email, or None."""
    if not v:
        return None
    s = str(v).strip().strip('.,;').lower()
    if not s or '@' not in s:
        return None
    # a rep sometimes pastes "Name <a@b.com>" or two addresses
    m = re.search(r'[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}', s)
    if not m:
        return None
    cand = m.group(0).strip('.')
    if not EMAIL_RE.match(cand):
        return None
    if 'nope@' in cand:            # known placeholder in the ERP export
        return None
    return cand


def clean_phone(v):
    """Return a 10-digit US phone as (XXX) XXX-XXXX, or None.

    'Damion 541.206.5093' still contains a real number, so digits are extracted
    rather than the whole value being thrown away; 'Renee' has none and is
    dropped.
    """
    if not v:
        return None
    digits = re.sub(r'\D', '', str(v))
    if len(digits) == 11 and digits.startswith('1'):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    if len(set(digits)) == 1:      # 0000000000 and friends
        return None
    return f'({digits[:3]}) {digits[3:6]}-{digits[6:]}'
