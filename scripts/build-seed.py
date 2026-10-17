#!/usr/bin/env python3
"""
Builds data/seed/schools.json (the versioned seed file) from raw NYC Open Data extracts.

Inputs (raw/*.json): rows from NYC DOE "2019-2020 School Locations" (wg9x-4ke6), filtered to
managed_by_name=Charter & status=Open, with a zip code geocoded from each street address via
NYC Planning GeoSearch and 2020-21 enrollment from the DOE Demographic Snapshot (vmmu-wj3w).

Only facts with a source are written. Anything we could not verify stays null and the app shows
"Not available". Network-level facts come from each network's own website (checked 2026-10-17);
admissions rules come from the NYC DOE "How to Enroll in Charter Schools" page (checked 2026-10-17).
"""
import json, re, sys, pathlib

RAW = pathlib.Path(sys.argv[1])
OUT = pathlib.Path(sys.argv[2])
VERIFIED = "2026-10-17"
CYCLE = "2027-28"
DEADLINE = "2027-04-01"
COMMON_APP = "https://nyccharterschools.schoolmint.net/signup"
DOE_ENROLL = "https://www.schools.nyc.gov/enrollment/enroll-in-charter-schools/how-to-enroll-in-charter-schools"
DOE_TRANSPORT = "https://www.schools.nyc.gov/school-life/transportation/bus-eligibility"

K = ["id", "name", "address", "lat", "lng", "grades", "open_date", "neighborhood", "phone",
     "district", "category", "building", "zip", "enrollment"]
BORO = {"M": "Manhattan", "K": "Brooklyn", "X": "Bronx", "Q": "Queens", "R": "Staten Island"}
ORDER = ["PK", "0K", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]

# Grades actually enrolled in 2020-21 (DOE Demographic Snapshot) for schools whose 2019-20
# location record has no grade list (mostly schools that opened in 2018-19 or later).
SNAPSHOT_GRADES = {
    "84K928": "0K,06,07", "84K929": "0K,01", "84K930": "0K,01,02", "84K933": "0K,01,02",
    "84K934": "0K,01,02", "84K937": "0K,01,02", "84K910": "0K,01,02,03", "84K927": "0K,01,02",
    "84M373": "PK,0K,01,02,03", "84M380": "0K,01,02", "84M383": "0K,01,02", "84Q385": "0K,01,02,03",
    "84Q386": "0K,01,02,03,04", "84Q387": "05,06", "84Q388": "09,10", "84R070": "08,09,10,11",
    "84R076": "01,02,03", "84R077": "PK,0K,01,02", "84X597": "09,10,11", "84X598": "0K,01,05,06,07",
    "84X599": "0K,01,02", "84X606": "05,06,07", "84X608": "0K,01,02,03", "84X609": "0K,01,02,03",
    "84X610": "10,11,12", "84X611": "09,10", "84X613": "0K,01,02", "84X614": "0K,01,02",
    "84X615": "05,06,07", "84X616": "0K,01,02", "84X617": "05,06,07", "84X619": "0K,01,02,03",
    "84X620": "0K,01,02", "84X623": "0K,01,02",
}
# Schools that enrolled Pre-K in 2020-21 (the 2019-20 grade lists omit Pre-K).
HAS_PREK = {"84K362", "84K702", "84K785", "84K789", "84M085", "84M168", "84M186", "84M329",
            "84M330", "84M382", "84M483", "84M518", "84Q170", "84Q342", "84Q372", "84Q705",
            "84X394", "84X465", "84X487", "84X554", "84X718", "84M373", "84R077"}
# Newer official names from the 2020-21 snapshot (where the 2019-20 name differs).
NAMES = {
    "84K741": "Success Academy Charter School - Crown Heights",
    "84K752": "Success Academy Charter School - Fort Greene",
    "84K756": "Success Academy Charter School - Prospect Heights",
    "84M170": "Success Academy Charter School - Hell's Kitchen",
    "84M174": "Success Academy Charter School - Union Square",
    "84K788": "Achievement First Linden Charter School",
    "84K892": "Brooklyn Emerging Leaders Academy Charter School",
    "84K930": "LEEP Dual Language Academy Charter School",
    "84M068": "KIPP NYC Washington Heights Academy Charter School",
    "84M338": "WHIN Music Community Charter School",
    "84M373": "Zeta Charter Schools - Inwood 1",
    "84X185": "Pharos Academy Charter School",
    "84X585": "Legacy College Preparatory Charter School",
    "84X597": "Urban Assembly Charter School for Computer Science",
    "84X609": "Zeta Charter Schools - Bronx 1",
    "84X616": "KIPP Bronx II Charter School",
    "84X617": "KIPP Bronx III Charter School",
    # Source names are cut off at 50 characters; these are the full names.
    "84K406": "EMBER Charter School for Mindful Education, Innovation and Transformation",
    "84K724": "Leadership Prep Canarsie Charter School",
    "84K807": "Collegiate Academy for Mathematics and Personal Awareness Charter School",
    "84K772": "Success Academy Charter School - Bensonhurst",
    "84K781": "Success Academy Charter School - Bergen Beach",
    "84Q337": "Success Academy Charter School - Rosedale",
    "84Q339": "Success Academy Charter School - Springfield Gardens",
    "84X464": "Success Academy Charter School - Bronx 4",
    "84M265": "Success Academy Charter School - Washington Heights",
    "84X309": "South Bronx Charter School for International Cultures and the Arts",
    "84X395": "NYC Charter High School for Architecture, Engineering and Construction Industries",
    "84X611": "AECI II: NYC Charter High School for Computer Engineering and Innovation",
}

# Network facts, each from the network's own website (checked 2026-10-17).
NETWORKS = {
    "Success Academy Charter Schools": dict(
        pattern=r"^Success Academy", website="https://www.successacademies.org/",
        apply_url="https://www.successacademies.org/",
        how="Apply with Success Academy's own online application (\"Apply Now\" on the network website).",
        mission="Give children the knowledge and confidence they need to succeed in life, through tuition-free public charter schools.",
        uniform="Uniform provided free (per Success Academy)", after_care="Free after-school clubs (per Success Academy)"),
    "KIPP NYC": dict(
        pattern=r"^KIPP", website="https://www.kippnyc.org/",
        apply_url="https://kippnyc.my.site.com/Apply/GuestApplication",
        how="Apply with KIPP NYC's own online application; enrollment help by phone/text at 929-822-4430 or enroll@kippnyc.org.",
        mission="Free public charter schools preparing students for college, career and beyond.",
        email="enroll@kippnyc.org"),
    "Achievement First": dict(
        pattern=r"^Achievement First", website="https://www.achievementfirst.org/",
        apply_url="https://www.achievementfirst.org/",
        how="Apply with Achievement First's own NYC application (Enroll menu on the network website).",
        mission="Prepare every student for college and career and a purposeful life, working with families to address educational inequity."),
    "Uncommon Schools": dict(
        pattern=r"(Collegiate Charter School$|^Leadership Prep|^Excellence (Boys|Girls))",
        exclude=r"^Key Collegiate",
        website="https://uncommonschools.org/", apply_url="https://uncommonschools.org/enroll/",
        how="Apply through Uncommon Schools' NYC enrollment page.",
        mission="Help students get to and through college."),
    "Ascend Public Charter Schools": dict(
        pattern=r"Ascend Charter School$", website="https://www.ascendlearning.org/",
        apply_url="https://www.ascendlearning.org/application/",
        how="Apply with Ascend's own online application; questions to enroll@ascendlearning.org or 347-227-6070.",
        mission="A well-rounded, joyful education with teachers who see every child's potential from day one.",
        email="enroll@ascendlearning.org"),
    "Democracy Prep Public Schools": dict(
        pattern=r"^Democracy Prep", website="https://democracyprep.org/",
        apply_url="https://democracyprep.org/enrollny/",
        how="Apply through Democracy Prep's New York enrollment page.",
        mission="Prepare thoughtful, engaged students for college and active citizenship."),
}
# Brand-name networks where we know the affiliation from the school name only.
NAME_ONLY_NETWORKS = [
    (r"^Explore (Charter|Exceed|Excel|Empower)", "Explore Schools"),
    (r"^New Visions", "New Visions for Public Schools"),
    (r"^Harlem Children's Zone", "Harlem Children's Zone"),
    (r"^Icahn Charter School", "Icahn Charter Schools"),
    (r"Hebrew Language", "Hebrew Public"),
    (r"^South Bronx Classical", "Classical Charter Schools"),
    (r"^Brilla", "Brilla Public Charter Schools"),
    (r"^Zeta Charter", "Zeta Charter Schools"),
    (r"^Harlem Village Academy", "Harlem Village Academies"),
    (r"^Family Life Academy", "Family Life Academy Charter Schools"),
    (r"^Bronx Charter School for Excellence", "Bronx Charter School for Excellence"),
    (r"^(Girls|Boys) Preparatory Charter School", "Public Prep"),
    (r"^Hyde Leadership", "Hyde Leadership Charter Schools"),
    (r"^Growing Up Green", "Growing Up Green Charter Schools"),
    (r"^Brooklyn Prospect", "Brooklyn Prospect Charter Schools"),
    (r"^Storefront Academy", "Storefront Academy Charter Schools"),
    (r"^DREAM", "DREAM"),
    (r"^Amber Charter", "Amber Charter Schools"),
    (r"^Hellenic Classical", "Hellenic Classical Charter Schools"),
    (r"^NYC Autism", "NYC Autism Charter Schools"),
    (r"^Urban Dove", "Urban Dove"),
    (r"^Our World Neighborhood", "Our World Neighborhood Charter Schools"),
    (r"^Bronx Charter School for Better Learning", "Bronx Better Learning"),
    (r"^(Brooklyn LAB|Edmund W\. Gordon)", "Brooklyn LAB"),
    (r"^East Harlem Scholars", "East Harlem Scholars Academies"),
    (r"^New Dawn Charter", "New Dawn Charter Schools"),
]

TRAILING = [(r"Charter S(c(h(o(o)?)?)?)?$", "Charter School"), (r"Charter Hig(h)?$", "Charter High School"),
            (r" Charter$", " Charter School"), (r" C$", " Charter School")]


def fix_name(code, name):
    if code in NAMES:
        return NAMES[code]
    if name.startswith("New Visions Charter High School for Advanced Math"):
        return "New Visions Charter High School for Advanced Math and Science"
    for pat, rep in TRAILING:
        if re.search(pat, name):
            return re.sub(pat, rep, name)
    return name


def title(s):
    if not s:
        return None
    s = re.sub(r"\s+", " ", s.strip())
    t = s.title()
    t = re.sub(r"\b(\d+)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), t)
    t = re.sub(r"\bSt\b(?= [A-Z])", "St.", t) if False else t
    t = t.replace("'S ", "'s ")
    return t


def norm_grades(code, g):
    raw = SNAPSHOT_GRADES.get(code) if not g or g == "9" else g
    if raw is None and g == "9":
        raw = "09"
    toks = [x.strip().upper() for x in (raw or "").split(",")]
    toks = ["0K" if t == "K" else t for t in toks]
    out = {t for t in toks if t in ORDER}
    if code in HAS_PREK:
        out.add("PK")
    return [t for t in ORDER if t in out]


def entry_grades(grades):
    """Typical entry points: the first grade served, plus grade 6 and 9 when a school spans
    elementary→middle or middle→high (common NYC entry years)."""
    if not grades:
        return []
    e = [grades[0]]
    for g in ("06", "09"):
        if g in grades and g != grades[0]:
            e.append(g)
    if grades[0] == "PK" and "0K" in grades:
        e.insert(1, "0K")
    return sorted(set(e), key=ORDER.index)


rows = []
for f in sorted(RAW.glob("c*.json")):
    rows += json.loads(f.read_text())

seen, schools = set(), []
for r in rows:
    d = dict(zip(K, r))
    code = d["id"]
    if code in seen:
        continue
    seen.add(code)
    name = fix_name(code, d["name"])
    boro = BORO[code[2]]
    grades = norm_grades(code, d["grades"])
    network = None
    net = None
    for nname, info in NETWORKS.items():
        if re.search(info["pattern"], name) and not (info.get("exclude") and re.search(info["exclude"], name)):
            network, net = nname, info
            break
    if not network:
        for pat, nname in NAME_ONLY_NETWORKS:
            if re.search(pat, name):
                network = nname
                break

    district = int(d["district"]) if d["district"] else None
    phone = d["phone"] if d["phone"] and re.fullmatch(r"\d{3}-\d{3}-\d{4}", d["phone"]) else None
    year = int(d["open_date"][:4]) if d["open_date"] else None
    sources = [
        "NYC DOE 2019–20 School Locations (NYC Open Data): name, address, location, phone, district, year opened",
        "NYC DOE 2020–21 Demographic Snapshot (NYC Open Data): enrollment",
        "NYC Planning GeoSearch: zip code",
        "NYC DOE 'How to Enroll in Charter Schools': deadline rule, preferences, Common Application",
    ]
    if net:
        sources.append(f"{network} website: application, mission summary, contact")

    prefs = ["Returning students", "Siblings of students already enrolled"]
    prefs.append(f"Students living in Community School District {district}" if district else "Students living in the school's community school district")

    schools.append({
        "id": code,
        "name": name,
        "network": network,
        "borough": boro,
        "district": district,
        "zip": d["zip"],
        "neighborhood": d["neighborhood"],
        "address": title(d["address"]),
        "lat": round(float(d["lat"]), 6),
        "lng": round(float(d["lng"]), 6),
        "grades_served": grades,
        "entry_grades": entry_grades(grades),
        "enrollment": d["enrollment"],
        "year_founded": year,
        "mission": net["mission"] if net else None,
        "building_code": d["building"],
        "source": "; ".join(sources),
        "last_verified": VERIFIED,
        "admissions": {
            "cycle": CYCLE,
            "how_to_apply": (net["how"] if net else
                             "Apply with the school's own application, or the NYC Charter School Center Common Application if the school uses it. Contact the school to confirm."),
            "eligibility": "Open to all New York City children entering the grades the school serves. Charter schools must admit students of all kinds and cannot use admissions tests.",
            "lottery_preferences": "; ".join(prefs) + ". Some schools also prefer English language learners, students with disabilities, or students eligible for free or reduced-price lunch.",
            "application_open": None,
            "application_deadline": DEADLINE,
            "deadline_note": "By law the deadline can't be earlier than April 1; some schools accept applications later. Confirm with the school.",
            "lottery_date": None,
            "lottery_note": "If applications exceed seats, a random lottery is held (typically April–May).",
            "apply_url": net["apply_url"] if net else COMMON_APP,
            "apply_url_label": f"{network} application" if net else "NYC Charter School Center Common Application",
        },
        "contact_costs": {
            "phone": phone,
            "email": net.get("email") if net else None,
            "website": net["website"] if net else None,
            "tuition_free": True,
            "uniform": net.get("uniform") if net else None,
            "after_care": net.get("after_care") if net else None,
            "meals": None,
            "transportation": "NYC DOE school bus or student OMNY card, based on grade and walking distance. Confirm with the school.",
        },
    })

schools.sort(key=lambda s: s["id"])
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "version": f"{VERIFIED}.1",
    "generated": VERIFIED,
    "description": "Curated seed of open NYC charter schools. Facts without a source are null.",
    "sources": {
        "locations": "https://data.cityofnewyork.us/d/wg9x-4ke6",
        "enrollment": "https://data.cityofnewyork.us/d/vmmu-wj3w",
        "zip": "https://geosearch.planninglabs.nyc/",
        "admissions_rules": DOE_ENROLL,
        "transportation": DOE_TRANSPORT,
    },
    "schools": schools,
}, indent=1, ensure_ascii=False) + "\n")

from collections import Counter
print(len(schools), "schools", Counter(s["borough"] for s in schools))
print("with network:", sum(1 for s in schools if s["network"]), "mission:", sum(1 for s in schools if s["mission"]))
print("phone:", sum(1 for s in schools if s["contact_costs"]["phone"]), "no grades:", [s["id"] for s in schools if not s["grades_served"]])
print("cut names:", [s["name"] for s in schools if len(s["name"]) == 50])
