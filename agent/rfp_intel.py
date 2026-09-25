"""agent/rfp_intel.py — Fire department RFP / procurement intelligence.

Sources:
  1. USASpending.gov — recent fire-related contract awards (confirmed working)
  2. SAM.gov Opportunities API — live solicitations (requires SAM_API_KEY env var;
     DEMO_KEY is blocked on the production endpoint as of mid-2024)
  3. Grants.gov v1 — AFG/SAFER-adjacent fire grant opportunities (open)

Categories:
  - Software/Tech: CAD, RMS, software, SaaS, IT, radio/comms systems, ePCR
  - Equipment: apparatus, SCBA, PPE, hose, nozzle, radio hardware, AED
  - Services: training, consulting, maintenance, inspection, staffing
  - Construction/Facilities: station, facility, renovation, HVAC, generator

Outputs: dashboard/rfp_intel.json
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
TIMEOUT = 20
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}

SAM_OPPORTUNITIES_URL = "https://api.sam.gov/prod/opportunities/v2/search"
SAM_API_KEY = os.environ.get("SAM_API_KEY", "")

USASPENDING_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
GRANTS_GOV_URL = "https://apply07.grants.gov/grantsws/rest/opportunities/search/"

# Fire-relevant NAICS for USASpending
FIRE_NAICS = [
    "922160",  # Fire Protection
    "541512",  # Computer Systems Design
    "541519",  # Other Computer Related Services
    "334290",  # Communications Equipment
    "336120",  # Heavy Duty Truck Manufacturing (fire apparatus)
    "811310",  # Commercial/Industrial Machinery Maintenance
    "611519",  # Other Technical and Trade Schools (fire training)
]

CATEGORY_KEYWORDS: Dict[str, List[str]] = {
    "Software/Tech": [
        "CAD", "computer aided dispatch", "computer-aided dispatch",
        "records management", "RMS", "software", "SaaS", "mobile app",
        "information technology", "IT services", "cybersecurity",
        "data platform", "analytics", "dashboard", "portal", "system integration",
        "station alerting", "incident command software", "ePCR", "electronic",
        "FirstNet", "interoperability", "radio system", "P25", "communications system",
        "data", "application",
    ],
    "Equipment": [
        "apparatus", "fire truck", "fire engine", "ladder truck", "pumper",
        "SCBA", "self-contained breathing", "PPE", "turnout gear", "protective",
        "hose", "nozzle", "thermal imaging", "TIC", "extrication", "rescue equipment",
        "radio", "portable radio", "handheld", "defibrillator", "AED",
        "ambulance", "medical equipment", "vehicle",
    ],
    "Services": [
        "training", "consulting", "maintenance", "support services", "inspection",
        "testing", "certification", "staffing", "technical assistance",
        "fire investigation", "hazmat", "planning services",
    ],
    "Construction/Facilities": [
        "fire station", "station construction", "facility", "renovation",
        "building construction", "remodel", "infrastructure", "HVAC",
        "exhaust system", "diesel exhaust", "generator", "installation",
    ],
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _classify(title: str, desc: str = "") -> str:
    text = f"{title} {desc}".lower()
    for cat, kws in CATEGORY_KEYWORDS.items():
        if any(kw.lower() in text for kw in kws):
            return cat
    return "Services"


def _val(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("$", ""))
    except (ValueError, TypeError):
        return None


# ── SAM.gov live solicitations ─────────────────────────────────────────────────

def _fetch_sam(fire_keywords: List[str]) -> List[Dict[str, Any]]:
    """Fetch open solicitations from SAM.gov. Requires SAM_API_KEY."""
    if not SAM_API_KEY:
        print("[rfp_intel] SAM_API_KEY not set — skipping SAM.gov solicitations")
        return []

    results: List[Dict[str, Any]] = []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%m/%d/%Y")
    today = datetime.now(timezone.utc).strftime("%m/%d/%Y")

    for term in fire_keywords[:6]:
        try:
            params = {
                "api_key": SAM_API_KEY,
                "title": term,
                "postedFrom": cutoff,
                "postedTo": today,
                "ptype": "o,p,k",  # solicitations, presolicitations, combined
                "limit": 100,
                "offset": 0,
            }
            r = requests.get(SAM_OPPORTUNITIES_URL, params=params,
                             headers=HEADERS, timeout=TIMEOUT)
            if r.status_code == 429:
                print(f"[rfp_intel] SAM rate-limited on '{term}', sleeping 3s")
                time.sleep(3)
                continue
            if not r.ok:
                print(f"[rfp_intel] SAM {r.status_code} for '{term}'")
                continue

            for opp in (r.json().get("opportunitiesData") or []):
                title = opp.get("title") or ""
                if not title:
                    continue
                pop = opp.get("placeOfPerformance") or {}
                city = (pop.get("city") or {}).get("name") or ""
                state = (pop.get("state") or {}).get("code") or ""
                agency = ""
                hier = opp.get("organizationHierarchy") or []
                if hier:
                    agency = hier[0].get("name") or ""
                agency = agency or opp.get("departmentName") or ""
                results.append({
                    "id": opp.get("noticeId") or "",
                    "title": title.strip(),
                    "agency": agency.strip(),
                    "city": city.strip(),
                    "state": state.strip().upper()[:2],
                    "category": _classify(title, opp.get("description") or ""),
                    "estimated_value": _val(
                        opp.get("baseAndAllOptionsValue") or opp.get("awardAmount")
                    ),
                    "posted_date": opp.get("postedDate") or "",
                    "due_date": opp.get("responseDeadLine") or "",
                    "url": opp.get("uiLink") or
                           f"https://sam.gov/opp/{opp.get('noticeId','')}/view",
                    "source": "SAM.gov",
                    "record_type": "solicitation",
                    "description": (opp.get("description") or "")[:300],
                })
            time.sleep(0.5)
        except Exception as e:
            print(f"[rfp_intel] SAM error for '{term}': {e}")

    # deduplicate by id
    seen: set = set()
    deduped = []
    for r in results:
        key = r["id"] or (r["title"][:80] + r["agency"])
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    print(f"[rfp_intel] SAM solicitations (deduped): {len(deduped)}")
    return deduped


# ── USASpending recent contract awards ────────────────────────────────────────

def _fetch_usaspending() -> List[Dict[str, Any]]:
    """Recent fire-related contract awards from USASpending (no auth required)."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    start = (datetime.now(timezone.utc) - timedelta(days=180)).strftime("%Y-%m-%d")
    results = []
    try:
        body = {
            "filters": {
                "naics_codes": FIRE_NAICS,
                "award_type_codes": ["A", "B", "C", "D"],
                "time_period": [{"start_date": start, "end_date": today}],
                "keywords": ["fire department", "fire protection", "fire service",
                             "fire station", "firefighter"],
            },
            "fields": ["Award ID", "Recipient Name", "Award Amount", "Description",
                       "Awarding Agency", "Start Date",
                       "Place of Performance State Code",
                       "Place of Performance City Name",
                       "recipient_location_state_code"],
            "sort": "Award Amount",
            "order": "desc",
            "limit": 100,
        }
        r = requests.post(USASPENDING_URL, json=body,
                          headers={**HEADERS, "Content-Type": "application/json"},
                          timeout=TIMEOUT)
        r.raise_for_status()
        raw = r.json().get("results") or []
        for a in raw:
            title = a.get("Description") or ""
            # Filter to only clearly fire-related
            text = title.lower()
            fire_terms = ["fire", "firefighter", "suppression", "rescue",
                          "hazmat", "haz mat", "ems", "emergency", "dispatch",
                          "apparatus", "station", "scba", "foam"]
            if not any(t in text for t in fire_terms):
                continue
            results.append({
                "id": a.get("Award ID") or "",
                "title": title[:120].strip() or "(Fire Contract)",
                "agency": a.get("Awarding Agency") or "",
                "city": a.get("Place of Performance City Name") or "",
                "state": a.get("Place of Performance State Code") or "",
                "category": _classify(title),
                "estimated_value": _val(a.get("Award Amount")),
                "posted_date": a.get("Start Date") or "",
                "due_date": "",
                "url": "https://usaspending.gov",
                "source": "USASpending.gov",
                "record_type": "award",
                "description": "",
            })
        print(f"[rfp_intel] USASpending fire awards: {len(results)}")
    except Exception as e:
        print(f"[rfp_intel] USASpending error: {e}")
    return results


# ── Grants.gov open AFG/SAFER opportunities ───────────────────────────────────

# Strict fire-relevance terms for Grants.gov title matching
_FIRE_TITLE_TERMS = [
    "fire department", "firefighter", "fire protection", "fire station",
    "fire service", "fire suppression", "fire apparatus", "afg grant",
    "safer grant", "assistance to firefighters", "staffing for adequate fire",
    "hazmat response", "wildfire", "wildland fire",
]


def _fetch_grants_gov() -> List[Dict[str, Any]]:
    """Open AFG/SAFER and fire-specific grant opps from Grants.gov v1.

    Uses strict title matching to avoid false positives; if AFG/SAFER cycles
    are not active the result set will be empty.
    """
    results = []
    # Only query fire-specific terms to minimise noise
    fire_queries = ["firefighter", "fire department", "wildland fire",
                    "fire apparatus", "fire protection"]
    seen: set = set()
    for kw in fire_queries:
        try:
            r = requests.post(
                GRANTS_GOV_URL,
                json={"rows": 50, "oppStatuses": "posted", "keyword": kw,
                      "sortBy": "openDate|desc"},
                headers={**HEADERS, "Content-Type": "application/json"},
                timeout=TIMEOUT,
            )
            if not r.ok:
                continue
            for opp in (r.json().get("oppHits") or []):
                title = opp.get("title") or ""
                key = opp.get("id") or title
                if key in seen:
                    continue
                seen.add(key)
                # Must pass strict fire-relevance check
                text = title.lower()
                if not any(t in text for t in _FIRE_TITLE_TERMS):
                    continue
                results.append({
                    "id": str(opp.get("id") or ""),
                    "title": title.strip(),
                    "agency": opp.get("agency") or "",
                    "city": "",
                    "state": "",
                    "category": _classify(title),
                    "estimated_value": None,
                    "posted_date": opp.get("openDate") or "",
                    "due_date": opp.get("closeDate") or "",
                    "url": (f"https://grants.gov/search-grants?cfda="
                            f"{','.join(opp.get('cfdaList') or [])}"),
                    "source": "Grants.gov",
                    "record_type": "grant_opportunity",
                    "description": "",
                })
            time.sleep(0.3)
        except Exception as e:
            print(f"[rfp_intel] Grants.gov error for '{kw}': {e}")
    print(f"[rfp_intel] Grants.gov fire opps (strict filter): {len(results)}")
    return results


# ── Main ───────────────────────────────────────────────────────────────────────

FIRE_SAM_TERMS = [
    "fire department",
    "fire station",
    "fire protection",
    "firefighter",
    "emergency services",
    "hazmat",
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "rfp_intel.json"

    sam_items = _fetch_sam(FIRE_SAM_TERMS)
    award_items = _fetch_usaspending()
    grant_items = _fetch_grants_gov()

    # Solicitations = SAM live + Grants.gov open opps
    solicitations = sam_items + [g for g in grant_items
                                  if g["record_type"] == "grant_opportunity"]

    # Summary stats across solicitations + awards combined for KPI strip
    all_items = solicitations + award_items
    total_value = sum(s["estimated_value"] or 0 for s in all_items)
    states = sorted({s["state"] for s in all_items if s["state"]})
    cat_counts: Dict[str, int] = {}
    for s in all_items:
        cat_counts[s["category"]] = cat_counts.get(s["category"], 0) + 1

    out = {
        "generated_at": _now(),
        "solicitations": solicitations,
        "recent_awards": award_items[:50],
        "summary": {
            "solicitations_count": len(solicitations),
            "awards_count": len(award_items),
            "total_estimated_value": round(total_value, 2),
            "states_count": len(states),
            "states": states,
            "categories": cat_counts,
            "sam_api_active": bool(SAM_API_KEY),
        },
    }

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[rfp_intel] wrote {len(solicitations)} solicitations + "
          f"{len(award_items)} awards → {out_path}")

    # Supabase — non-fatal
    try:
        from .supabase_writer import write_procurement_awards
        from .grants_intel import main as _grants_noop
        # Load grants_intel output to upsert alongside rfp awards
        import json as _json
        grants_path = OUT_DIR / "grants_intel.json"
        grants_data = _json.loads(grants_path.read_text()) if grants_path.exists() else {}
        write_procurement_awards(out, grants_data)
    except Exception as e:
        print(f"[rfp_intel] Supabase write skipped: {e}")


if __name__ == "__main__":
    main()
