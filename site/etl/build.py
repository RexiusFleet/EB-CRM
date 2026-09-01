#!/usr/bin/env python3
"""Build site/index.html as a SINGLE self-contained file.

engine.js stays a separate file in the repo because the node test suite imports
it, but shipping it as a separate <script src> made the app fragile: deploy a
new index.html without the matching engine.js and `Engine` is undefined, which
kills the boot sequence and leaves an empty product dropdown and a spinner that
never resolves. Inlining removes that whole class of problem -- one file to
deploy, no version skew.
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_HTML = os.path.join(HERE, 'app', 'index.html')
SRC_JS = os.path.join(HERE, 'app', 'engine.js')
OUT = os.path.join(HERE, 'site', 'index.html')

html = open(SRC_HTML).read()
js = open(SRC_JS).read()

TAG = '<script src="engine.js"></script>'
if TAG not in html:
    sys.exit('ERROR: engine.js script tag not found -- did the markup change?')

inlined = ('<!-- engine.js inlined at build time (etl/build.py) so this file is\n'
           '     entirely self-contained: nothing else needs deploying with it. -->\n'
           '<script>\n' + js + '\n</script>')
html = html.replace(TAG, inlined, 1)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w').write(html)

# engine.js is still copied alongside for the test suite / readability
open(os.path.join(HERE, 'site', 'engine.js'), 'w').write(js)

print(f'site/index.html  {os.path.getsize(OUT)/1024:.0f} KB  (engine.js inlined, '
      f'{len(js)/1024:.0f} KB)')
