"""Shared check: does a GeoSearch result really match the requested address (same house number and street)?"""
import re
ABR = {'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'BOULEVARD': 'BLVD', 'PLACE': 'PL', 'ROAD': 'RD', 'PARKWAY': 'PKWY', 'DRIVE': 'DR',
       'EAST': 'E', 'WEST': 'W', 'NORTH': 'N', 'SOUTH': 'S', 'TERRACE': 'TER', 'LANE': 'LN', 'FIRST': '1', 'SECOND': '2', 'THIRD': '3',
       'FOURTH': '4', 'FIFTH': '5', 'SAINT': 'ST', 'CONCOURSE': 'CONC', 'PAULS': 'PAUL', 'GUN': 'GUN', 'HL': 'HILL', 'RD.': 'RD'}


def parts(a):
    """'101 E 150th St, Floor 2' -> ('101', 'E 150 ST')"""
    if not a:
        return None, None
    a = re.sub(r'\.\s*(QUEENS|BROOKLYN|BRONX|MANHATTAN|STATEN ISLAND)\s*$', '', a.upper().split(',')[0])
    a = re.sub(r"[.']", '', a)
    a = re.sub(r'\b(FLOOR|FL|SUITE|STE|ROOM|RM|#)\b.*$', '', a)
    a = ' '.join(ABR.get(w, 'ST' if re.fullmatch(r'STRE+T', w) else w) for w in a.split())
    a = re.sub(r'(\d+)(ST|ND|RD|TH)\b', r'\1', a).strip()
    m = re.match(r'^(\d+(?:-\d+)?[A-Z]?)\s+(.*)$', a)
    return (m.group(1), m.group(2).strip()) if m else (None, a)


LABEL_ABR = {'FT': 'FORT', 'CON': 'CONC', 'BWAY': 'BROADWAY', 'RIV': 'RIVER', 'CO OP': 'COOP', 'CO-OP': 'COOP', 'MT': 'MOUNT'}


def _street(s):
    s = s.replace('CO-OP', 'COOP').replace('CO OP', 'COOP')
    s = ' '.join(LABEL_ABR.get(w, w) for w in s.split())
    s = re.sub(r'\b(CITY|STREET)\b', lambda m: m.group(0), s)
    return s.replace(' ', '')


def _numbers(n, queens=False):
    """'2244-2246' -> {'2244','2246'} for a range; '109-55' (Queens hyphenated) -> {'10955'}"""
    a, _, b = n.partition('-')
    out = {n.replace('-', '')}
    # a building range like 1166-1182 or 2-12 (second number larger), not a Queens number like 109-55
    if b and not queens and a.isdigit() and b.isdigit() and int(b) > int(a):
        out |= {a, b}
    return out


def matches(requested, label, borough=None):
    """Same building: house number equal (or inside a listed range) and the same street, allowing abbreviations."""
    import difflib
    rn, rs = parts(requested)
    ln, ls = parts(label)
    if not rn or not ln:
        return False
    q = borough == 'Queens' or (borough is None and '-' in rn and len(rn.split('-')[1]) == 2 and int(rn.split('-')[1] or 0) < 100 and False)
    if not (_numbers(rn, q) & _numbers(ln, q)):
        return False
    a, b = _street(rs), _street(ls)
    if re.sub(r'\D', '', a) != re.sub(r'\D', '', b):  # numbered streets must agree exactly (162 vs 167)
        return False
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= 0.8
