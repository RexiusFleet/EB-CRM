#!/usr/bin/env python3
"""Build demo/ from site/ with CONFIG blanked.

site/index.html now ships with the live Supabase credentials baked in, which is
what Taylor deploys. The browser test suite needs a copy that runs against the
offline bundle instead -- otherwise every test would hit the real project.
"""
import os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, DST = os.path.join(HERE, 'site'), os.path.join(HERE, 'demo')

if os.path.exists(DST):
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)

p = os.path.join(DST, 'index.html')
s = open(p).read()
s2 = re.sub(r"(SUPABASE_URL:\s*)'[^']*'", r"\1''", s, count=1)
s2 = re.sub(r"(SUPABASE_ANON_KEY:\s*)'[^']*'", r"\1''", s2, count=1)
if s2 == s:
    sys.exit('ERROR: could not blank CONFIG -- the block must have changed shape.')
open(p, 'w').write(s2)

blanked = re.search(r"SUPABASE_URL:\s*''", s2) and re.search(r"SUPABASE_ANON_KEY:\s*''", s2)
print(f'demo/ built from site/  (CONFIG blanked: {bool(blanked)})')
