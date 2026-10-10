#!/usr/bin/env python3
"""Build docs/training/syllabi/*.json from the official texts fetched for this change.

Inputs are local copies of public documents (not committed). Outputs are the
syllabus lists and the concept-graph refs. Re-run only after those downloads
are refreshed.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs" / "training"
SRC = Path("/tmp/syllabi")
RETRIEVED = "2026-10-09"

# First matching rule wins. Specific phrases come before broad ones.
RULES: list[tuple[str, list[str]]] = [
    (r"density altitude", ["perf.density-altitude"]),
    (r"pressure altitude|altimeter setting|qnh|hectopascal|inches of mercury|inhg", ["perf.pressure-altitude"]),
    (r"transition altitude|transition level|flight level", ["law.transition-altitude"]),
    (r"alternate (aerodrome|airport)|destination alternate|take-off alternate", ["law.alternate"]),
    (r"\binter\b|\btempo\b|\bcavok\b|taf\b|metar\b|speci\b|sigmet", ["met.taf-groups"]),
    (r"final reserve|contingency fuel|fuel requirement|usable fuel|holding fuel", ["fpl.fuel-plan"]),
    (r"equal time|critical point|point of no return|safe return", ["fpl.safe-return"]),
    (r"semicircular|cruising level|cruise level", ["fpl.cruise-level"]),
    (r"crosswind|headwind component|tailwind component", ["fpl.wind-component"]),
    (r"duty time|flight duty|fatigue risk|frms|flight time limitation", ["hum.fatigue-rules"]),
    (r"hypoxi|time of useful consciousness|cabin altitude", ["hum.hypoxia"]),
    (r"vestibular|somatogravic|the leans|spatial disorient", ["hum.vestibular"]),
    (r"crew resource|situational awareness|threat and error|decision-making|decision making", ["hum.crm"]),
    (r"medical certificate|pilot licence|pilot license|privileges of|rating and endorsement", ["law.documents"]),
    (r"\bvmc\b|\bvfr\b|visual meteorological|cloud separation|distance from cloud", ["law.vfr-minima"]),
    (r"right of way|right-of-way|airspace class|class [a-g] airspace", ["law.airspace"]),
    (r"buys ballot|geostrophic", ["met.geostrophic"]),
    (r"coriolis", ["met.coriolis"]),
    (r"gradient wind|cyclostrophic", ["met.gradient-wind"]),
    (r"friction layer|surface friction|cross-isobar|backing and veering|veer and back", ["met.surface-friction"]),
    (r"pressure gradient|isobar", ["met.pressure-gradient"]),
    (r"thunderstorm|microburst|cumulonimbus|squall line", ["met.thunderstorm"]),
    (r"\bicing\b|freezing level|freezing rain|supercool", ["met.icing"]),
    (r"turbulence|mountain wave|wind shear|windshear", ["met.turbulence"]),
    (r"jet stream", ["met.jet-stream"]),
    (r"\bfront|air mass|airmass", ["met.fronts"]),
    (r"adiabatic|lapse rate|atmospheric stability|conditionally unstable", ["met.stability"]),
    (r"dewpoint|dew point|relative humidity|precipitation|saturated", ["met.moisture"]),
    (r"temperature inversion|isotherm|diurnal variation of surface air temperature|heating and cooling", ["met.temperature"]),
    (r"runway visual range|\bvisibility\b|\bfog\b|mist\b|ceiling", ["met.ceiling"]),
    (r"climatolog|seasonal weather|intertropical|itcz", ["met.climatology"]),
    (r"hydraulic|\bpsi\b|constant pressure system|pressurised only on specific demand|pressurized only on specific demand", ["sys.hydraulics"]),
    (r"high pressure|low pressure|cyclone|anticyclone", ["met.pressure-systems"]),
    (r"\bvor\b|\bndb\b|\badf\b|\bdme\b|\bils\b|\bgnss\b|\bgps\b|vortac|tacan|inertial nav", ["nav.radio-aids"]),
    (r"great circle|rhumb line", ["nav.great-circle"]),
    (r"time zone|local mean time|co-ordinated universal|coordinated universal|\butc\b", ["nav.place-time"]),
    (r"mercator|lambert|chart projection", ["nav.charts"]),
    (r"pitot|static port|altimeter error|airspeed indicator", ["sys.pitot-static"]),
    (r"anti-ice|de-ice|deice|ice protection", ["sys.anti-ice"]),
    (r"pressuris", ["sys.pressurisation"]),
    (r"\bmel\b|minimum equipment list|configuration deviation", ["sys.mel-dispatch"]),
    (r"turbine engine|piston engine|propeller|powerplant|power plant", ["sys.powerplant"]),
    (r"electrical (system|bus)|generator and battery|busbar", ["sys.electrical"]),
    (r"aileron|elevator|rudder|flight control", ["sys.flight-controls"]),
    (r"hydraulic system", ["sys.hydraulics"]),
    (r"centre of gravity|center of gravity|loading system|\bmoment\b", ["perf.weight"]),
    (r"take-off distance|takeoff distance|field length|accelerate-stop", ["perf.takeoff-factors"]),
    (r"landing distance", ["perf.landing-distance"]),
    (r"climb gradient|net take-off flight path|drift down", ["perf.climb"]),
    (r"induced drag", ["aero.induced-drag"]),
    (r"load factor|manoeuvre envelope|maneuver envelope", ["aero.load-factor"]),
    (r"manoeuvr(e|ing) speed|maneuvering speed|\bva\b", ["aero.manoeuvre-speed"]),
    (r"\bstall\b|angle of attack|critical angle", ["aero.stall-aoa"]),
    (r"\blift\b|coefficient of lift|bernoulli", ["aero.lift"]),
    (r"static stability|directional stability|phugoid|dutch roll", ["aero.stability"]),
    (r"phraseology|radiotelephony|mayday|distress and urgency", ["comm.procedures"]),
    (r"holding procedure|instrument approach|missed approach|departure procedure", ["inst.procedures"]),
    (r"aerodynamics", ["aero.lift"]),
]

FALLBACK = {
    "AGKC": "sys.aircraft-general",
    "AGKA": "sys.aircraft-general",
    "AFRC": "law.flight-rules",
    "AFRA": "law.flight-rules",
    "AHFC": "hum.crm",
    "ANVC": "nav.charts",
    "AMTC": "met.climatology",
    "AFPA": "fpl.atpl",
    "APLA": "perf.climb",
    "IREX": "inst.procedures",
    "010": "law.flight-rules",
    "021": "sys.aircraft-general",
    "022": "sys.aircraft-general",
    "031": "perf.weight",
    "032": "perf.climb",
    "033": "fpl.atpl",
    "040": "hum.crm",
    "050": "met.climatology",
    "061": "nav.charts",
    "062": "nav.radio-aids",
    "070": "law.flight-rules",
    "071": "law.flight-rules",
    "081": "aero.stability",
    "090": "comm.procedures",
    "091": "comm.procedures",
    "092": "comm.procedures",
    "100": "hum.crm",
    "SARON-1": "law.flight-rules",
    "SARON-2": "sys.aircraft-general",
    "SARON-3": "sys.pitot-static",
    "SARON-4": "nav.charts",
    "SARON-5": "law.flight-rules",
    "SARON-6": "aero.lift",
    "SARON-7": "hum.crm",
    "SAMRA-8": "met.climatology",
    "SAMRA-9": "fpl.atpl",
    "SAMRA-10": "nav.radio-aids",
    "SARON-FLIGHT": "ops.flight-standards",
    "CTP": "hum.crm",
}

STUBS = [
    ("met.climatology", "Seasonal and regional climate", "met", "met.fronts"),
    ("met.jet-stream", "Jet streams", "met", "met.geostrophic"),
    ("nav.radio-aids", "Radio and satellite navigation aids", "nav", "nav.great-circle"),
    ("nav.charts", "Aeronautical charts and projections", "nav", "nav.great-circle"),
    ("sys.powerplant", "Engines and propellers", "sys", "aero.lift"),
    ("sys.electrical", "Aircraft electrical system", "sys", "sys.pitot-static"),
    ("sys.flight-controls", "Flight controls", "sys", "aero.lift"),
    ("sys.hydraulics", "Hydraulic systems", "sys", "sys.flight-controls"),
    ("sys.aircraft-general", "Aircraft general knowledge", "sys", "sys.pitot-static"),
    ("law.airspace", "Airspace and right of way", "law", "law.vfr-minima"),
    ("law.flight-rules", "Flight rules and air law", "law", "law.documents"),
    ("hum.crm", "Crew resource management", "hum", "hum.fatigue-rules"),
    ("fpl.atpl", "Airline flight planning", "fpl", "fpl.fuel-plan"),
    ("perf.climb", "Climb and en-route performance", "perf", "perf.takeoff-factors"),
    ("aero.stability", "Aircraft stability and control", "aero", "aero.lift"),
    ("comm.procedures", "Radiotelephony procedures", "comm", "law.documents"),
    ("inst.procedures", "Instrument procedures", "inst", "nav.radio-aids"),
    ("ops.flight-standards", "ATPL flight standards", "ops", "law.documents"),
]

NOTES = {
    "law.transition-altitude": {"easa_note": "gap", "ca_note": "reuses US"},
    "law.alternate": {"easa_note": "gap", "ca_note": "gap"},
    "law.documents": {"easa_note": "gap", "ca_note": "gap"},
    "law.vfr-minima": {"easa_note": "gap", "ca_note": "gap"},
    "law.flight-rules": {"easa_note": "gap", "ca_note": "gap"},
    "fpl.fuel-plan": {"easa_note": "gap", "ca_note": "gap"},
    "fpl.cruise-level": {"easa_note": "gap", "ca_note": "reuses US"},
    "fpl.taf-threshold": {"easa_note": "gap", "ca_note": "gap"},
    "hum.fatigue-rules": {"easa_note": "gap", "ca_note": "gap"},
    "met.taf-groups": {"easa_note": "gap", "ca_note": "gap"},
    "met.ceiling": {"easa_note": "gap", "ca_note": "gap"},
    "perf.pressure-altitude": {"easa_note": "gap", "ca_note": "reuses US"},
}


def dump(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def plain(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", "", fragment)
    text = html.unescape(text).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def assign(bucket: str, text: str) -> list[str]:
    # EASA 021 03 02 is the hydraulic-systems topic. Its leaves say "low pressure"
    # without the word hydraulic, which would otherwise hit the weather rule.
    if bucket.startswith("021 03 02") or bucket.startswith("021-03-02"):
        return ["sys.hydraulics"]
    blob = f"{text}".lower()
    for pattern, ids in RULES:
        if re.search(pattern, blob, re.I):
            return ids
    key = bucket.split()[0] if " " in bucket else bucket
    fallback = FALLBACK.get(bucket) or FALLBACK.get(key[:3] if key[:3].isdigit() else key)
    return [fallback] if fallback else []


def objective(oid: str, text: str, bucket: str, kind: str = "objective") -> dict:
    concepts = [] if kind == "reserved" else assign(bucket, text)
    row = {"id": oid, "text": text, "kind": kind, "concept_ids": concepts}
    if not concepts:
        row["gap"] = True
    return row


def extract_casa() -> dict:
    html_doc = (SRC / "p61-d3.html").read_text(encoding="utf-8", errors="replace")
    heads = list(re.finditer(r"<h3[^>]*>([\s\S]*?)</h3>", html_doc))
    wanted = {
        "AGKC": "AGKC",
        "AGKA": "AGKA",
        "AFRC": "AFRC",
        "AFRA": "AFRA",
        "AHFC": "AHFC",
        "ANVC": "ANVC",
        "AMTC": "AMTC",
        "AFPC": "AFPC",
        "AFPA": "AFPA",
        "APLC": "APLC",
        "APLA": "APLA",
        "IREX": "IREX",
    }
    found: dict[str, tuple[str, str]] = {}
    for index, match in enumerate(heads):
        title = plain(match.group(1))
        code = next((code for code in wanted if re.search(rf"\b{code}\b", title)), None)
        if not code or code in found:
            continue
        end = heads[index + 1].start() if index + 1 < len(heads) else match.end()
        found[code] = (title, html_doc[match.end() : end])

    order = ["AGKC", "AGKA", "AFRC", "AFRA", "AHFC", "ANVC", "AMTC", "AFPC", "AFPA", "APLC", "APLA", "IREX"]
    subjects = []
    source = "https://www.legislation.gov.au/F2014L01102/latest/text"
    for code in order:
        title, body = found[code]
        short = re.sub(rf"^Unit\s+[\d.]+\s+{code}\s*:\s*", "", title).strip()
        reserved = "reserved" in title.lower() or "reserved" in plain(body)[:80].lower()
        if reserved and code in {"AFPC", "APLC"}:
            subjects.append({
                "code": code,
                "title": short,
                "source_url": source,
                "gap": "Marked Reserved in Schedule 3. No knowledge elements are published for this unit.",
                "objectives": [objective(f"casa:{code}:reserved", "Reserved", code, "reserved")],
            })
            continue
        subjects.append({
            "code": code,
            "title": short,
            "source_url": source,
            "gap": None,
            "objectives": casa_objectives(code, body),
        })
    flight = [
        ("C2", "Perform pre- and post-flight actions and procedures"),
        ("C3", "Operate aeronautical radio"),
        ("C5", "Manage passengers and cargo"),
        ("NTS1", "Non-technical skills 1"),
        ("NTS2", "Non-technical skills 2"),
        ("IFF", "Full instrument panel manoeuvres"),
        ("IFL", "Limited instrument panel manoeuvres"),
        ("RNE", "Radio navigation – en route"),
        ("MCO", "Manage flight during multi-crew operations"),
        ("CIR", "Conduct an IFR flight"),
        ("IAP2", "Conduct an instrument approach 2D"),
        ("IAP3", "Conduct an instrument approach 3D"),
        ("TR-MEA", "Type rating multi-engine aeroplane"),
    ]
    subjects.append({
        "code": "K1-FLIGHT",
        "title": "Appendix K.1 practical flight standards",
        "source_url": source,
        "gap": "Competency unit titles from Appendix K.1. Schedule 2 elements are not knowledge objectives and are not copied here.",
        "objectives": [
            objective(f"casa:K1-FLIGHT:{code}", title, "SARON-FLIGHT", "competency")
            for code, title in flight
        ],
    })
    return {
        "schema": "isobar.training.syllabus/v1",
        "id": "casa-atpl",
        "authority": "CASA",
        "title": "ATPL(A) aeronautical knowledge standards",
        "version": "Part 61 Manual of Standards Instrument 2014, Compilation No. 6 (F2025C00050)",
        "version_date": "2024-11-19",
        "retrieved": RETRIEVED,
        "licence": "CC BY 4.0",
        "licence_note": "Commonwealth legislation on the Federal Register of Legislation. This repo records those compilations as CC BY 4.0. The register copyright page returned no article text on this fetch.",
        "source_url": source,
        "gap": "Appendix K.1 prints AAGA and AGKA in one cell titled aircraft general knowledge – aeroplane. Schedule 3 titles AAGA as the aerial-application endorsement, so AAGA is not listed here. Schedule 3 also has AMTA (ATPL meteorology – aeroplane), which Appendix K.1 does not list. Practical flight standards are unit titles only.",
        "subjects": subjects,
    }


def casa_objectives(code: str, body: str) -> list[dict]:
    paragraphs = []
    for attrs, fragment in re.findall(r"<p\b([^>]*)>([\s\S]*?)</p>", body):
        matched = re.search(r'class="([^"]+)"', attrs)
        paragraphs.append((matched.group(1) if matched else "", fragment))
    rows: list[dict] = []
    current: dict | None = None
    seen: dict[str, int] = {}

    def close() -> None:
        nonlocal current
        if current and current["text"]:
            rows.append(current)
        current = None

    for cls, fragment in paragraphs:
        text = plain(fragment)
        if not text:
            continue
        if cls.startswith("LDP") and current is not None:
            current["text"] = f"{current['text']} {text}".strip()
            continue
        if cls in {"LDSubClause", "LDClause", "LDClauseHeading"}:
            close()
            number = re.match(r"^(\d+(?:\.\d+)*)\s+(.*)$", text)
            verb = re.search(r"\b(describe|explain|state|list|identify|know|calculate|differentiate|select|give|compare|apply|recall|define|determine|complete)\b", text, re.I)
            if cls == "LDClauseHeading" or cls == "LDClause" and (not number or (len(number.group(2)) < 90 and not verb)):
                continue
            if not number:
                continue
            key = number.group(1)
            seen[key] = seen.get(key, 0) + 1
            suffix = "" if seen[key] == 1 else f"-{seen[key]}"
            kind = "reserved" if re.fullmatch(r"reserved\.?", number.group(2), re.I) else "objective"
            current = objective(f"casa:{code}:{key}{suffix}", text, code, kind)
            continue
        close()
    close()
    if not rows:
        rows.append(objective(f"casa:{code}:gap", "No numbered elements parsed from this unit.", code, "reserved"))
    return rows


def extract_faa() -> dict:
    lines = (SRC / "atp_acs.txt").read_text(encoding="utf-8", errors="replace").splitlines()
    area = "I. Preflight Preparation"
    task = ""
    subjects: dict[str, dict] = {}
    current: dict | None = None
    started = False
    code_re = re.compile(r"^(AA\.(?:I|II|III|IV|V|VI|VII|VIII)\.[A-Z]\.K\d+[a-z]?)\s+(.*\S)\s*$")
    for raw in lines:
        text = raw.strip()
        if not started:
            if text == "Task A. Operation of Systems":
                started = True
                task = "A. Operation of Systems"
            continue
        if text.startswith("Appendix 1"):
            break
        if "...." in raw or not text:
            continue
        area_m = re.match(r"^Area of Operation\s+([IVX]+)\.\s+(.+)$", text)
        if area_m:
            area = f"{area_m.group(1)}. {area_m.group(2).strip()}"
            continue
        task_m = re.match(r"^Task\s+([A-Z])\.\s+(.+)$", text)
        if task_m:
            if current:
                add_faa(subjects, current)
                current = None
            task = f"{task_m.group(1)}. {task_m.group(2).strip()}"
            continue
        if text in {"Risk", "Skills", "Knowledge"} or re.match(r"^(Knowledge|Risk Management|Skills|Objective|References|Note|Management)\b", text):
            if current:
                add_faa(subjects, current)
                current = None
            continue
        matched = code_re.match(text)
        if matched and re.search(r"\bAA\.", matched.group(2)):
            continue
        if matched:
            if current:
                add_faa(subjects, current)
            current = {"code": matched.group(1), "text": matched.group(2).strip(), "area": area, "task": task}
            continue
        if current and raw.startswith(" ") and not text.startswith("AA."):
            current["text"] = f"{current['text']} {text}"
    if current:
        add_faa(subjects, current)
    ctp = extract_ctp()
    source = "https://www.faa.gov/training_testing/testing/acs/atp_airplane_acs_11.pdf"
    ordered = []
    for key, subject in subjects.items():
        subject["source_url"] = source
        subject["gap"] = None
        ordered.append(subject)
    ordered.append(ctp)
    return {
        "schema": "isobar.training.syllabus/v1",
        "id": "faa-atp",
        "authority": "FAA",
        "title": "ATP airplane airman certification standards and ATP CTP",
        "version": "FAA-S-ACS-11A (November 2023, effective 31 May 2024); 14 CFR 61.156 as in the 2025 CFR",
        "version_date": "2024-05-31",
        "retrieved": RETRIEVED,
        "licence": "US government work, public domain",
        "licence_note": "FAA ACS and the Code of Federal Regulations are US government works.",
        "source_url": source,
        "gap": "Risk-management (R) and skill (S) elements are in the same ACS and are not knowledge elements, so they are not listed. Letter codes were read from FAA-S-ACS-11A.",
        "subjects": ordered,
    }


def faa_bucket(area: str, task: str) -> str:
    blob = f"{area} {task}".lower()
    if "weather" in blob:
        return "AMTC"
    if "human" in blob:
        return "AHFC"
    if "regulation" in blob or "cfr" in blob:
        return "AFRC"
    if "performance" in blob:
        return "APLA"
    if "aerodynamic" in blob:
        return "081"
    if "air carrier" in blob:
        return "AFPA"
    if "system" in blob:
        return "AGKA"
    return "AGKC"


def add_faa(subjects: dict[str, dict], row: dict) -> None:
    code = row["area"] or "ACS"
    subject = subjects.setdefault(code, {"code": code, "title": row["area"] or "ACS", "objectives": []})
    text = re.sub(r"\s+", " ", row["text"]).strip()
    if row["task"]:
        text = f"{row['task']}: {text}"
    subject["objectives"].append(objective(f"faa:{row['code']}", text, faa_bucket(row["area"], row["task"])))


def extract_ctp() -> dict:
    raw = (SRC / "cfr61156.xml").read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"<[^>]+>", " ", raw)
    text = re.sub(r"\s+", " ", html.unescape(text))
    start = text.find("(a) Academic training.")
    end = text.find("(b) FSTD training.")
    academic = text[start:end]
    items = [
        ("61.156(a)(1)", "At least 8 hours of instruction on aerodynamics including high altitude operations."),
        ("61.156(a)(2)", "At least 2 hours of instruction on meteorology, including adverse weather phenomena and weather detection systems."),
        ("61.156(a)(3)(i)", "Air carrier operations: physiology."),
        ("61.156(a)(3)(ii)", "Air carrier operations: communications."),
        ("61.156(a)(3)(iii)", "Air carrier operations: checklist philosophy."),
        ("61.156(a)(3)(iv)", "Air carrier operations: operational control."),
        ("61.156(a)(3)(v)", "Air carrier operations: minimum equipment list/configuration deviation list."),
        ("61.156(a)(3)(vi)", "Air carrier operations: ground operations."),
        ("61.156(a)(3)(vii)", "Air carrier operations: turbine engines."),
        ("61.156(a)(3)(viii)", "Air carrier operations: transport category aircraft performance."),
        ("61.156(a)(3)(ix)", "Air carrier operations: automation, navigation, and flight path warning systems."),
        ("61.156(a)(4)", "At least 6 hours of instruction on leadership, professional development, crew resource management, and safety culture."),
        ("61.156(b)(1)(i)", "FSTD: low energy states/stalls."),
        ("61.156(b)(1)(ii)", "FSTD: upset recovery techniques."),
        ("61.156(b)(1)(iii)", "FSTD: adverse weather conditions, including icing, thunderstorms, and crosswinds with gusts."),
        ("61.156(b)(2)(i)", "FSTD: navigation including flight management systems."),
        ("61.156(b)(2)(ii)", "FSTD: automation including autoflight."),
    ]
    # Keep the parse so a drift in the file is visible during the build.
    if "high altitude operations" not in academic:
        raise SystemExit("14 CFR 61.156 academic text was not found")
    source = "https://www.govinfo.gov/content/pkg/CFR-2025-title14-vol2/xml/CFR-2025-title14-vol2-sec61-156.xml"
    return {
        "code": "ATP-CTP",
        "title": "ATP certification training program topics (14 CFR 61.156)",
        "source_url": source,
        "gap": None,
        "objectives": [objective(f"faa:{code}", line, "CTP") for code, line in items],
    }


def extract_easa() -> dict:
    path = SRC / "Easy Access Rules for Aircrew - Revision November 2025 - xml.xml"
    data = path.read_bytes()
    start = data.find(b"010 00 00 00")
    table = data.rfind(b"<w:tbl>", 0, start)
    end = data.find(b"010 00 00 00", start + 20)
    chunk = data[table:end]
    rows = re.findall(br"<w:tr(?:\s[^>]*)?>[\s\S]*?</w:tr>", chunk)
    subjects: dict[str, dict] = {}
    topic = ""
    seen = set()
    source = "https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-aircrew-regulation-eu-no-11782011"

    def cells(row: bytes) -> list[str]:
        out = []
        for cell in re.findall(br"<w:tc(?:\s[^>]*)?>[\s\S]*?</w:tc>", row):
            parts = []
            for para in re.findall(br"<w:p(?:\s[^>]*)?>[\s\S]*?</w:p>", cell):
                runs = [html.unescape(t.decode("utf-8", "replace")) for t in re.findall(br"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", para)]
                piece = ""
                for run in runs:
                    if piece and run and piece[-1].isalnum() and run[0].isalnum():
                        piece += " "
                    piece += run
                if piece.strip():
                    parts.append(piece.strip())
            out.append(re.sub(r"\s+", " ", " ".join(parts)).strip())
        return out

    for row in rows:
        cell = cells(row)
        if len(cell) < 4:
            continue
        code, _bk, text, atpl = cell[0], cell[1], cell[2], cell[3]
        if re.fullmatch(r"\d{3} \d{2} \d{2} \d{2}", code):
            topic = code
            if code.endswith("00 00 00"):
                title = next((item for item in cell[1:] if item and item not in {"X", "BK"}), code[:3])
                subjects.setdefault(code[:3], {"code": code[:3], "title": title, "source_url": source, "gap": None, "objectives": []})
            continue
        if not re.fullmatch(r"\(\d{2}\)", code) or atpl != "X" or not topic:
            continue
        oid = f"easa:{topic.replace(' ', '-')}-{code[1:-1]}"
        if oid in seen:
            continue
        seen.add(oid)
        bucket = topic[:3]
        subject = subjects.setdefault(bucket, {"code": bucket, "title": bucket, "source_url": source, "gap": None, "objectives": []})
        subject["objectives"].append(objective(oid, text, topic))
    if "071" in subjects and subjects["071"]["title"] == "071" and "070" in subjects:
        subjects["071"]["title"] = subjects["070"]["title"]
    kept = [subjects[code] for code in sorted(subjects) if subjects[code]["objectives"]]
    return {
        "schema": "isobar.training.syllabus/v1",
        "id": "easa-atpl",
        "authority": "EASA",
        "title": "Part-FCL ATPL(A) learning objectives",
        "version": "Easy Access Rules for Aircrew (Regulation (EU) No 1178/2011), revision November 2025",
        "version_date": "2025-11-25",
        "retrieved": RETRIEVED,
        "licence": "© European Union, 1998-2025",
        "licence_note": "The EAR copyright notice permits reuse of EUR-Lex legal documents with attribution and says the consolidated book is not an official publication. AMC learning objectives in the same book were extracted for this syllabus map. Cite the EAR, not this file, as the text.",
        "source_url": source,
        "gap": "Rows are the ATPL(A) column of AMC1 FCL.310; FCL.515(b); FCL.615(b). Topic headings are the parent codes on each objective id. Helicopter-only rows without an ATPL(A) mark are omitted. Basic-knowledge marks are not a separate list.",
        "subjects": kept,
    }


def extract_tc() -> dict:
    xml = (SRC / "tp690.xml").read_text(encoding="utf-8", errors="replace")
    pages = re.findall(r"<page[^>]*>([\s\S]*?)</page>", xml)
    lines: list[str] = []
    for page in pages:
        items = []
        for top, left, fragment in re.findall(r'<text top="(-?\d+)" left="(-?\d+)"[^>]*>([\s\S]*?)</text>', page):
            text = plain(fragment)
            if text:
                items.append((int(left), text))
        left_col = [text for left, text in items if left < 360 and not re.fullmatch(r"\d{1,2}", text)]
        right_col = [text for left, text in items if left >= 360 and not re.fullmatch(r"\d{1,2}", text)]
        lines.extend(left_col)
        lines.extend(right_col)
    subjects: dict[str, dict] = {}
    current = None
    topic = ""
    topic_slug = "topic"
    started = False
    title_open = False
    source = "https://tc.canada.ca/en/aviation/publications/study-reference-guide-written-examinations-airline-transport-pilot-licence-aeroplane-tp-690"
    for line in lines:
        if "...." in line or "…" in line:
            continue
        if (line.startswith("ANNEX") or line.startswith("RECOMMENDED STUDY")) and subjects.get("SAMRA-10", {}).get("objectives"):
            break
        section = re.match(r"^SECTION\s+(\d+):\s+(.+)$", line)
        if section:
            number = int(section.group(1))
            exam = "SARON" if number <= 7 else "SAMRA"
            code = f"{exam}-{number}"
            raw_title = section.group(2).strip()
            title = raw_title.strip(" -–").title()
            current = subjects.get(code)
            if current is None:
                current = {"code": code, "title": title, "source_url": source, "gap": None, "objectives": []}
                subjects[code] = current
            elif not current["objectives"]:
                current["title"] = title
            topic, topic_slug, started, title_open = "", "topic", True, raw_title.rstrip(" -–").endswith("AND")
            continue
        if title_open:
            title_open = False
            if current is not None and line.isupper() and len(line) < 48 and not re.match(r"^\d", line):
                current["title"] = f"{current['title']} {line.strip(' -–').title()}"
                continue
        if not started or current is None:
            continue
        if re.match(r"^(SARON|SAMRA)\b", line):
            continue
        numbered = re.match(r"^(\d{3}\.\d+[A-Za-z]?|\d+)\s+(.+)$", line)
        if numbered:
            ref, text = numbered.group(1), numbered.group(2).strip()
            if current["objectives"] and current["objectives"][-1]["text"].endswith(("/", "–", "-")):
                current["objectives"][-1]["text"] = f"{current['objectives'][-1]['text']} {text}".strip()
                continue
            slug = re.sub(r"[^a-z0-9]+", "-", f"{topic_slug}-{ref}".lower()).strip("-")
            oid = f"ca:{current['code']}:{slug}"
            used = {row["id"] for row in current["objectives"]}
            if oid in used:
                oid = f"{oid}-{len(used)}"
            row = objective(oid, text, current["code"])
            if topic:
                row["topic"] = topic
            current["objectives"].append(row)
            continue
        if line.isupper() or (line[:1].isupper() and line.upper() == line and len(line) > 3):
            topic = f"{topic} {line}".strip() if topic and not current["objectives"] else line
            topic_slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:40] or "topic"
            continue
        if current["objectives"]:
            current["objectives"][-1]["text"] = f"{current['objectives'][-1]['text']} {line}".strip()
    order = [f"SARON-{n}" for n in range(1, 8)] + [f"SAMRA-{n}" for n in range(8, 11)]
    return {
        "schema": "isobar.training.syllabus/v1",
        "id": "tc-atpl",
        "authority": "Transport Canada",
        "title": "ATPL(A) SAMRA and SARON knowledge requirements",
        "version": "TP 690E, twenty-first edition, March 2016 (TP file updated 03/2016)",
        "version_date": "2016-03-01",
        "retrieved": RETRIEVED,
        "licence": "Crown copyright, reproduction permitted with acknowledgement",
        "licence_note": "© Her Majesty the Queen in Right of Canada, as represented by the Minister of Transport, 1977. Transport Canada grants permission to reproduce this guide with full acknowledgement. It is a guide, not the legal text of the CARs.",
        "source_url": source,
        "gap": "Item-level CAR wording was not copied from the regulations. SARON section 1 lists the guide's provision titles. CARs Parts IV, VI and VII are the legal text at https://laws-lois.justice.gc.ca/eng/regulations/SOR-96-433/index.html and were not re-parsed section by section.",
        "subjects": [subjects[code] for code in order if code in subjects],
    }


def retitle(concept: dict) -> dict:
    easa = concept.get("easa_refs", [])
    ca = concept.get("ca_refs", [])
    ordered = {}
    for key, value in concept.items():
        if key in {"easa_refs", "ca_refs"}:
            continue
        ordered[key] = value
        if key == "us_refs":
            ordered["easa_refs"] = easa
            ordered["ca_refs"] = ca
    if "easa_refs" not in ordered:
        ordered["easa_refs"] = easa
        ordered["ca_refs"] = ca
    return ordered


def main() -> None:
    syllabi = [extract_casa(), extract_faa(), extract_easa(), extract_tc()]
    concepts_path = DOCS / "concepts.json"
    graph = json.loads(concepts_path.read_text(encoding="utf-8"))
    by_id = {concept["id"]: concept for concept in graph["concepts"]}
    for stub_id, title, strand, prereq in STUBS:
        if stub_id not in by_id:
            by_id[stub_id] = {
                "id": stub_id,
                "title": title,
                "strand": strand,
                "au_refs": [],
                "us_refs": [],
                "easa_refs": [],
                "ca_refs": [],
                "prerequisites": [prereq] if prereq in by_id or prereq == "sys.flight-controls" else ["law.documents"],
                "why": [prereq] if prereq in by_id or prereq == "sys.flight-controls" else ["law.documents"],
                "mode": "bank-only",
                "layer": "none",
                "levels": [],
            }
            graph["concepts"].append(by_id[stub_id])
    # Second pass so a stub can name an earlier new stub.
    for stub_id, _title, _strand, prereq in STUBS:
        concept = by_id[stub_id]
        if prereq in by_id:
            concept["prerequisites"] = [prereq]
            concept["why"] = [prereq]
    ref_field = {"casa-atpl": "au_refs", "faa-atp": "us_refs", "easa-atpl": "easa_refs", "tc-atpl": "ca_refs"}
    buckets: dict[str, dict[str, list[str]]] = {field: {} for field in ref_field.values()}
    for syllabus in syllabi:
        field = ref_field[syllabus["id"]]
        for subject in syllabus["subjects"]:
            for row in subject["objectives"]:
                for concept_id in row["concept_ids"]:
                    if concept_id not in by_id:
                        raise SystemExit(f"missing concept {concept_id} for {row['id']}")
                    buckets[field].setdefault(concept_id, []).append(row["id"])
    prefixes = {"au_refs": "casa:", "us_refs": "faa:", "easa_refs": "easa:", "ca_refs": "ca:"}
    for concept in graph["concepts"]:
        for field, prefix in prefixes.items():
            concept[field] = [ref for ref in concept.get(field) or [] if not str(ref).startswith(prefix)]
    graph["concepts"] = [retitle(concept) for concept in graph["concepts"]]
    by_id = {concept["id"]: concept for concept in graph["concepts"]}
    for field, mapping in buckets.items():
        for concept_id, ids in mapping.items():
            current = list(by_id[concept_id].get(field) or [])
            have = set(current)
            for oid in sorted(set(ids)):
                if oid not in have:
                    current.append(oid)
            by_id[concept_id][field] = current
    for concept_id, notes in NOTES.items():
        if concept_id in by_id:
            by_id[concept_id].update(notes)
    graph["written"] = RETRIEVED
    graph["authority"]["au_instrument"] = "Part 61 Manual of Standards Instrument 2014 (F2014L01102), Compilation No. 6 (F2025C00050)"
    graph["authority"]["au_instrument_url"] = "https://www.legislation.gov.au/F2014L01102/latest/text"
    graph["authority"]["au_code_status"] = "Checked 2026-10-09. F2014L01585 is not this MOS. Appendix K.1 knowledge units are AGKC, AGKA, AFRC, AFRA, AHFC, ANVC, AMTC, AFPC, AFPA, APLC, APLA and IREX. The four-letter exam booking codes remain a separate layer."
    graph["authority"]["us_document"] = "FAA-S-ACS-11A, Airline Transport Pilot and Type Rating for Airplane Category Airman Certification Standards (November 2023, effective 31 May 2024)"
    graph["authority"]["us_document_url"] = "https://www.faa.gov/training_testing/testing/acs/atp_airplane_acs_11.pdf"
    graph["authority"]["us_code_status"] = "Knowledge-element codes were read from FAA-S-ACS-11A on 2026-10-09. Risk and skill elements are not in the knowledge list."
    graph["authority"]["easa_document"] = "Easy Access Rules for Aircrew, revision November 2025"
    graph["authority"]["easa_document_url"] = "https://www.easa.europa.eu/en/document-library/easy-access-rules/easy-access-rules-aircrew-regulation-eu-no-11782011"
    graph["authority"]["ca_document"] = "TP 690E, Study and Reference Guide for the Airline Transport Pilot Licence — Aeroplane, 21st edition, March 2016"
    graph["authority"]["ca_document_url"] = "https://tc.canada.ca/en/aviation/publications/study-reference-guide-written-examinations-airline-transport-pilot-licence-aeroplane-tp-690"
    out = DOCS / "syllabi"
    out.mkdir(exist_ok=True)
    names = {"casa-atpl": "casa-atpl.json", "faa-atp": "faa-atp.json", "easa-atpl": "easa-atpl.json", "tc-atpl": "tc-atpl.json"}
    for syllabus in syllabi:
        dump(out / names[syllabus["id"]], syllabus)
        objectives = sum(len(subject["objectives"]) for subject in syllabus["subjects"])
        mapped = sum(1 for subject in syllabus["subjects"] for row in subject["objectives"] if row["concept_ids"])
        print(f"{syllabus['id']}: subjects {len(syllabus['subjects'])} objectives {objectives} mapped {mapped}")
    dump(concepts_path, graph)


if __name__ == "__main__":
    main()
