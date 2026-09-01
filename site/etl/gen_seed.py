#!/usr/bin/env python3
"""Emit sql/03_seed_reference.sql -- the small config tables as plain INSERTs so
they don't need the CSV importer (and so rate_card's generated cost_per_yard
column isn't fed a value)."""
import csv, os

HERE = os.path.dirname(os.path.abspath(__file__))
D, S = os.path.join(HERE, 'data'), os.path.join(HERE, 'sql')


# Columns that are text in the schema. These must ALWAYS be quoted -- ERP codes
# like '020' and zone keys like '97451' look numeric but are text, and emitting
# them bare both breaks the insert and silently eats the leading zero.
TEXT_COLS = {'product', 'erp_code', 'category', 'source', 'key', 'note',
             'volume_band', 'zone_type', 'zone_key'}


def lit(v, col=None):
    if v is None or v == '':
        return 'null'
    s = str(v)
    if col in TEXT_COLS:
        return "'" + s.replace("'", "''") + "'"
    if s.lower() in ('true', 'false'):
        return s.lower()
    try:
        float(s)
        return s
    except ValueError:
        return "'" + s.replace("'", "''") + "'"


def block(table, cols, rows, conflict):
    out = [f'\n-- {table} ({len(rows)} rows)',
           f'insert into {table} ({", ".join(cols)}) values']
    vals = [f'  ({", ".join(lit(r.get(c), c) for c in cols)})' for r in rows]
    out.append(',\n'.join(vals))
    out.append(f'on conflict ({conflict}) do update set ' +
               ', '.join(f'{c} = excluded.{c}' for c in cols if c not in conflict.split(', ')) + ';')
    return '\n'.join(out)


def load(f):
    with open(os.path.join(D, f)) as fh:
        return list(csv.DictReader(fh))


parts = ["""-- ============================================================================
-- Reference/config seed data. Run AFTER 01_schema.sql.
-- Safe to re-run: every insert upserts.
--
-- The BIG tables (customers, sites, orders, order_lines, quote_history) are
-- loaded from CSV instead -- see README, step 4.
-- ============================================================================"""]

parts.append(block('rate_card',
                   ['product', 'erp_code', 'category', 'unit_cost',
                    'yards_per_unit', 'needs_cost', 'active', 'source'],
                   load('rate_card.csv'), 'product'))
parts.append(block('markup_curve', ['min_yards', 'markup'],
                   load('markup_curve.csv'), 'min_yards'))
parts.append(block('settings', ['key', 'value', 'note'],
                   load('settings.csv'), 'key'))
parts.append(block('blow_benchmarks',
                   ['product', 'volume_band', 'n', 'blow_hr_per_yard_p25',
                    'blow_hr_per_yard_median', 'blow_hr_per_yard_p75'],
                   load('blow_benchmarks.csv'), 'product, volume_band'))
parts.append(block('drive_zones',
                   ['zone_type', 'zone_key', 'n', 'drive_hours_p25',
                    'drive_hours_median', 'drive_hours_p75'],
                   load('drive_zones.csv'), 'zone_type, zone_key'))

path = os.path.join(S, '03_seed_reference.sql')
with open(path, 'w') as f:
    f.write('\n'.join(parts) + '\n')
print(path, f'{os.path.getsize(path)/1024:.0f} KB')
