# agent/voc_stagegate.py — PM Intel Engine
# Domain-agnostic VOC stage-gating and sub-category classification.
# DIVISIONS below are the default (SaaS/tech domain).
# Override by setting DOMAIN_DIVISIONS in your domain.yaml under voc_divisions.
# Fire & life safety divisions are the reference implementation in
# configs/fire-life-safety.yaml.
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Tuple

DIVISIONS: Dict[str, Dict[str, List[str]]] = {
    "Communication": {
        "Inter-department handoffs": [
            "handoff", "handoffs", "shift notes", "ops to prevention", "operations to prevention",
            "handover", "turnover", "after action", "aar", "close the loop",
            "doesn't talk", "dont talk", "does not talk", "silo"
        ],
        "AHJ ↔ Fire Service": [
            "ahj", "authority having jurisdiction", "plan review", "permit", "occupancy", "inspection request",
            "preplan shared", "share data", "submit plans", "code interpretation", "communicat.* chief"
        ],
        "External stakeholders": [
            "contractor", "vendor", "building owner", "facility manager", "third party",
            "the compliance engine", "irol", "portal", "customer service"
        ],
    },
    "Integration & Interop": {
        "Apps don't talk": [
            "integration", "integrat", "interoperab", "apps.*dont.*talk", "apps.*do not.*talk",
            "siloed data", "data silo", "export csv", "import csv", "duplicate entry",
            "double entry", "rekey", "webhook", "api", "sdk"
        ],
        "CAD/RMS/Records": [
            r"\bcad\b", "dispatch", "tablet command", r"\brms\b", "records management", "incident data",
            "nfirs", "neris", "data warehouse", "etl", "snowflake", "incident report", "records system"
        ],
        "Third-party compliance": [
            r"\btce\b", "the compliance engine", "brycer", r"\birol\b", "contractor upload",
            "device level history", "portal upload"
        ],
    },
    "Software UX": {
        "Reporting & dashboards": ["dashboard", "analytics", "reports", r"\bkpi\b", "trend", "insight"],
        "Field usability": ["mobile app", "tablet app", "offline mode", "usability", "laggy", "too many taps", "field workflow", "touch screen"],
        "Search & data quality": ["search result", "lookup", "duplicate record", "merge records", "data quality", "bad data", "inaccurate data"],
    },
    "Inspections & Compliance": {
        "ITM testing": [
            r"\bitm\b", r"\bitp\b", "inspection.*testing.*maintenance", "test.*inspect", "deficiency",
            r"\btagged\b", "failed.*test", "deficiency report", "annual.*inspection", "fire inspection report",
            "sprinkler.*inspection", "alarm.*inspection", "suppression.*inspection", "itm software",
            "inspection.*software", "inspection.*app", "inspection.*platform", "inspect point",
            "fire inspection", "commercial inspection"
        ],
        "Permits/Occupancy": ["permit", r"\boccupancy\b", "reinspection", r"\bviolation\b", "citation", "certificate of occupancy"],
        "Plan review/Pre-plan": ["plan review", "preplan", "pre-plan", "site plan", "preplanning"],
    },
    "Standards & Codes": {
        "NFPA/ICC standards": [
            r"\bnfpa\b", r"\bicc\b", "national fire protection", "national electrical code", r"\bnec\b",
            "life safety code", "fire code", "building code", "code development", "standards council",
            "code.*update", "code.*revision", "code.*edition", "code.*change", "code.*compliance",
            "nfpa 72", "nfpa 13", "nfpa 25", "nfpa 10", "nfpa 70", "nfpa 1", "nfpa 101"
        ],
        "Interpretation": ["interpretation", "what code", "which code", "standard says", r"question.*nfpa", "is.*required"],
        "Updates & adoptions": ["adopted", r"\bedition\b", "code change", "amendment", "tia", "errata", "tentative interim amendment"],
    },
    "Operations & Training": {
        "Training/curriculum": [
            "training.*course", "training.*program", "certification.*training", "firefighter training",
            "online.*training", "lms", "learning management", "curriculum", "academy", r"\bdrill\b", "exercise",
            "vector solutions", "targetsolutions", "continuing education", r"\bceup\b"
        ],
        "Pre-incident planning": ["preplan", "pre-incident", "hydrant map", "floor plan", "site plan"],
        "After-action/lessons": ["after action", r"\baar\b", "post incident", "incident review"],
    },
    "Built Environment": {
        "Fire alarm systems": ["alarm panel", "smoke detector", "pull station", "addressable", r"\bclss\b", "fire alarm system", "notification appliance"],
        "Sprinkler/water": ["sprinkler", r"\bhydrant\b", "flow test", "hydraulic", r"\bvalve\b", "backflow", "standpipe", r"\bpump\b"],
        "Special systems": ["clean agent", "kitchen hood", r"\bfoam\b", "aspiration"],
    },
    "Community Risk Reduction": {
        "Public education": [r"\bcrr\b", "risk reduction", "smoke alarm program", "install smoke", "home visit", "community risk"],
        "Prevention campaigns": ["campaign", "outreach", "community event", "door to door", "public education"],
        "Analytics & targeting": ["hotspot", r"\btarget.*risk\b", "vulnerability index", r"\bequity\b", "risk model"],
    },
    "Procurement & Funding": {
        "Grants": [r"\bgrant\b", r"\bafg\b", r"\bsafer\b", "funding", "federal grant", "fire grant"],
        "Purchasing": ["procurement", r"\brfp\b", r"\bbid\b", r"\bquote\b", "purchase decision"],
        "Budget": [r"\bbudget\b", r"\bcapital\b", r"\bpricing\b", "subscription cost", "cost per user"],
    },
    "Wildland/WUI": {
        "Mitigation": ["defensible space", r"\bwui\b", "mitigation", "fuel break", "vegetation management", "wildland urban interface"],
        "Operations": ["red flag", "evacuation", "wildland operations", "wildland fire", "prescribed burn"],
        "Hardening": ["home hardening", r"\bember\b", r"\bmesh\b", "roof vent"],
    },
    "Incident Command & Response": {
        "Command Accountability / PAR": [
            r"\bpar\b", "personnel accountability", "accountability system", "crew integrity",
            "passport system", "tag system", r"\bmayday\b", "rapid intervention",
            r"\bric\b", "firefighter down", "lost firefighter",
        ],
        "Span of Control / ICS Structure": [
            "span of control", r"\bics\b", "incident command system", r"\bnims\b",
            "section chief", "division supervisor", "unified command", "area command",
            "tactical gap", "command structure", "command post", "incident commander",
            "operations section", "safety officer",
        ],
        "CAD / MDT / Dispatch Integration": [
            r"\bcad\b", r"\bmdt\b", r"\bmdc\b", "mobile data", "computer-aided dispatch",
            "tablet command", "dispatch integration", "mutual aid.*cad", "cad.*mutual aid",
            "cad-to-cad", "dispatch.*fire",
        ],
        "Radio / Communications Failure": [
            "radio failure", "radio traffic", "channel saturation", "interoperability",
            r"\bp25\b", r"\bfirstnet\b", "radio interoperability", "push-to-talk",
            "auditory exclusion", "radio.*command", "communications.*failure",
        ],
        "Cross-Agency / Multi-Agency Coordination": [
            "multi-agency", "mutual aid", r"\bmac\b", "common operating picture",
            r"\bcop\b", "situational awareness", "joint command", "interagency",
        ],
        "Fire + EMS Integration": [
            r"\beprc\b", r"\bepcr\b", "electronic patient care", "medical command",
            "mass casualty", r"\bmci\b", "triage officer", "medical director",
            "transport officer", "ems.*fire.*command", "fire.*ems.*command",
        ],
        "LODD / After-Action / Accountability": [
            r"\blodd\b", "line of duty", "after action", r"\baar\b", "post-incident",
            "niosh.*fire", "niosh.*lodd", "lodd.*verdict", "firefighter.*verdict",
            r"nfpa 1561", "incident review", "command failure",
        ],
        "AI / Digital Command Tools": [
            "scene watcher", "firstdue.*command", "tablet command", "digital command",
            "ai.*incident", "incident.*ai", "command.*software", "command.*app",
            "command.*tablet", "command.*mobile", "situational awareness.*software",
        ],
    },
}

# --- Negative patterns: reject clearly non-VOC content ---
NEGATIVE_TOPICS = [
    # Career / jobs
    r"how to (become|get) (a )?firefighter", r"career advice", r"interview tips?", r"resume",
    r"job (posting|openings?)", r"hiring", r"applying for", r"what is it like.*firefighter",
    # Subscription/marketing noise
    r"newsletter", r"subscribe", r"podcast episode",
    # Conference/webinar marketing (not NFPA/ICC technical)
    r"conference recap", r"vendor spotlight", r"webinar(?!.*nfpa|.*icc|.*inspection|.*code)",
    # Physical fitness / personal
    r"workout", r"fitness", r"cardio", r"crossfit",
    r"training (advice|routine)", r"gym", r"physical (agility|ability|fitness) test",
    # Raw incident news (not VOC) — NOTE: LODD/command-failure signals are whitelisted below
    r"house fire.*killed", r"fatal (crash|fire|incident)", r"arson arrest",
    # Workplace HR / employment law (not fire service operational VOC)
    r"harassment.*(report|allege|lawsuit|sue|claim|complaint)",
    r"retaliation.*reporting", r"sexual (orientation|harassment|discrimination)",
    r"anti-gay", r"sex discrimination", r"hostile work environment",
    # International non-US fire disasters (not US fire service market intelligence)
    r"gaza", r"ukraine.*fire", r"syria.*fire", r"building collapse.*(kill|dead|injur)",
    # Physical fitness / personal lifestyle
    r"stroke (recognition|prevention|risk|symptom)", r"heart attack symptom",
    r"stroke.*age.*factor",
    # Legal/ToS pages
    r"terms of service", r"terms and conditions", r"privacy policy", r"cookie policy",
    r"legal notice", r"disclaimer",
    # Vendor marketing noise: product launches without clear pain signal
    r"proud to announce", r"excited to introduce", r"nascar", r"motorsports", r"race car",
    r"sponsorship", r"brand ambassador",
    # Forest management policy (not fire service operational)
    r"roadless rule", r"forest management.*policy", r"usda.*repeal",
]

# Extra path-based junk detection (checked against URL)
JUNK_URL_PATTERNS = [
    r"/terms", r"/privacy", r"/cookie", r"/legal", r"/disclaimer",
    r"/careers", r"/jobs", r"/apply", r"/recruit",
]

# WHITELIST_HINTS: signals that override the negative filter.
# Extend in your domain.yaml under voc_whitelist_hints.
WHITELIST_HINTS = [
    "integration", "api", "webhook", "workflow", "automation",
    "compliance", "regulation", "standard", "certification",
    "software", "platform", "saas", "vendor", "pricing",
    "procurement", "rfp", "grant", "funding",
    "customer complaint", "user feedback", "frustration", "workaround",
]

# AUDIENCE_KEYS: persona-to-keyword mapping.
# Override in your domain config under voc_audience_keys.
AUDIENCE_KEYS = {
    "Executive": ["ceo", "cto", "cpo", "vp of product", "head of product", "director"],
    "Product Manager": ["product manager", "pm", "product lead", "product owner"],
    "Operations": ["operations manager", "ops", "operations director"],
    "IT / Data": ["it manager", "data engineer", "systems admin", "cto", "ciso"],
    "End User": ["user", "customer", "practitioner", "field", "frontline"],
    "Procurement": ["procurement", "purchasing", "buyer", "sourcing"],
}

# Minimum non-ASCII ratio to flag as non-English (basic heuristic)
_NON_ASCII_THRESHOLD = 0.15


def _is_non_english(text: str) -> bool:
    """Returns True if text appears to be non-English based on character ratio."""
    if not text:
        return False
    non_ascii = sum(1 for c in text if ord(c) > 127)
    return (non_ascii / max(len(text), 1)) > _NON_ASCII_THRESHOLD


def _has_junk_url(url: str) -> bool:
    u = (url or "").lower()
    return any(re.search(p, u) for p in JUNK_URL_PATTERNS)


def _clean(text: str) -> str:
    t = (text or "").lower()
    t = re.sub(r"\s+", " ", t)
    return f" {t} "


def _score_relevance(blob: str, title: str = "", url: str = "") -> int:
    score = 0

    # Hard rejection: junk URL patterns
    if _has_junk_url(url):
        return -10

    # Hard rejection: non-English title
    if _is_non_english(title):
        return -10

    # Negative topic patterns
    for pat in NEGATIVE_TOPICS:
        if re.search(pat, blob):
            score -= 3

    # Whitelist boost
    for hint in WHITELIST_HINTS:
        if hint in blob:
            score += 2

    # Strong fire-service signal boosts
    if "fire department" in blob or "fire service" in blob:
        score += 3
    if "fire chief" in blob or "fire marshal" in blob or "fire inspector" in blob:
        score += 2
    if "nfpa" in blob or "inspection" in blob or "ahj" in blob:
        score += 2

    return score


def _classify_division_and_sub(blob: str) -> Tuple[str, str]:
    best_div = "Other / Not Relevant"
    best_sub = ""
    best_hits = 0
    for division, subs in DIVISIONS.items():
        div_hits = 0
        local_best: Tuple[str, int] = ("", 0)
        for sub, keys in subs.items():
            hits = sum(1 for k in keys if re.search(k, blob))
            div_hits += hits
            if hits > local_best[1]:
                local_best = (sub, hits)
        if div_hits > best_hits:
            best_hits = div_hits
            best_div = division
            best_sub = local_best[0]
    return best_div, best_sub


def _audiences(blob: str) -> List[str]:
    out: List[str] = []
    for name, keys in AUDIENCE_KEYS.items():
        if any(re.search(k, blob) for k in keys):
            out.append(name)
    if not out:
        if "ahj" in blob or "plan review" in blob:
            out = ["Inspector", "AHJ"]
        elif "inspection" in blob:
            out = ["Inspector", "Fire Marshal"]
        else:
            out = ["Fire Chief"]
    return out[:4]


def stagegate(item: Dict[str, str]) -> Dict[str, object]:
    title = (item.get("title") or "").strip()
    text  = (item.get("text") or item.get("summary") or "").strip()
    url   = (item.get("url") or "").strip()
    blob  = _clean(title + " " + text)
    rel   = _score_relevance(blob, title=title, url=url)

    if rel < 1:
        return {"accepted": False, "division": "", "subdivision": "", "personas": [],
                "reason": f"Rejected by stage-gate (score={rel})"}

    division, sub = _classify_division_and_sub(blob)
    personas = _audiences(blob)

    return {
        "accepted": True,
        "division": division,
        "subdivision": sub,
        "personas": personas,
        "reason": f"Accepted; rel={rel}",
    }
