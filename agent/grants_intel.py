"""agent/grants_intel.py — Grants.gov opportunities + USASpending AFG/SAFER awards.

Tracks open federal grant opportunities relevant to fire/life safety and recent
awards under the AFG (97.044) and SAFER (97.083) CFDA programs via USASpending.

All APIs are open (no auth). On any failure we still write JSON with an `error`
field so the frontend degrades gracefully.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {
    "User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)",
    "Content-Type": "application/json",
}
TIMEOUT = 20

GRANTS_GOV_SEARCH = "https://api.grants.gov/v2/api/opportunities/search"
USASPENDING_AWARDS = "https://api.usaspending.gov/api/v2/search/spending_by_award/"
PROGRAM_NUMBERS = ["97.044", "97.083"]  # AFG, SAFER

# Keywords that must appear in the opportunity title/agency for it to be included
FIRE_KEYWORDS = [
    "fire", "firefighter", "AFG", "SAFER", "hazmat", "haz-mat", "emergency response",
    "wildfire", "arson", "rescue", "EMS", "emergency medical", "homeland security",
    "FEMA", "first responder", "public safety", "fire department", "fire station",
    "fire prevention", "life safety", "structural fire",
]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _is_fire_relevant(title: str, agency: str, description: str = "") -> bool:
    text = f"{title} {agency} {description}".lower()
    return any(kw.lower() in text for kw in FIRE_KEYWORDS)


def _fetch_opportunities() -> List[Dict[str, Any]]:
    """Fetch open fire-related grant opportunities from Grants.gov v2 API."""
    # Try Grants.gov v2 first (returns true open opportunities with ceiling)
    try:
        body = {
            "keyword": "fire department firefighter AFG SAFER wildfire rescue EMS",
            "opportunityStatuses": ["posted", "forecasted"],
            "rows": 50,
            "startRecordNum": 0,
        }
        r = requests.post(GRANTS_GOV_SEARCH, json=body, timeout=TIMEOUT, headers=HEADERS)
        if r.status_code == 200:
            data = r.json()
            opps = data.get("data", {}).get("hits", data.get("opportunities", data.get("oppHits", [])))
            out: List[Dict[str, Any]] = []
            for o in opps:
                # Grants.gov v2 nested structure
                opp = o.get("_source", o)
                title = opp.get("oppTitle") or opp.get("title") or ""
                agency = opp.get("agencyName") or opp.get("agency") or ""
                desc = opp.get("synopsis") or opp.get("description") or ""
                if not _is_fire_relevant(title, agency, desc):
                    continue
                ceiling = opp.get("awardCeiling") or opp.get("award_ceiling")
                floor = opp.get("awardFloor") or opp.get("award_floor")
                out.append({
                    "opportunity_id": opp.get("oppNumber") or opp.get("id") or "",
                    "title": title,
                    "agency": agency,
                    "description": desc[:200] if desc else "",
                    "award_ceiling": float(ceiling) if ceiling else None,
                    "award_floor": float(floor) if floor else None,
                    "open_date": opp.get("openDate") or opp.get("postDate") or "",
                    "close_date": opp.get("closeDate") or opp.get("dueDate") or "",
                    "status": (opp.get("oppStatus") or opp.get("status") or "posted").lower(),
                    "cfda": opp.get("cfdaNumbers") or [],
                })
            if out:
                print(f"[grants_intel] Grants.gov v2: {len(out)} fire-relevant opportunities")
                return out
    except Exception as e:
        print(f"[grants_intel] Grants.gov v2 failed: {e}")

    # Fallback: USASpending keyword search (awarded grants, not open opportunities)
    print("[grants_intel] Falling back to USASpending keyword search")
    today = time.strftime("%Y-%m-%d", time.gmtime())
    start_fy = "2024-10-01"  # FY2025 start
    body = {
        "filters": {
            "keywords": ["Assistance to Firefighters", "SAFER", "AFG fire department"],
            "award_type_codes": ["02", "03", "04", "05"],
            "time_period": [{"start_date": start_fy, "end_date": today}],
        },
        "fields": ["Award ID", "Recipient Name", "Award Amount", "Description",
                   "Awarding Agency", "Start Date", "Place of Performance State Code",
                   "Place of Performance City Name"],
        "sort": "Award Amount",
        "order": "desc",
        "limit": 50,
        "page": 1,
    }
    try:
        r = requests.post(USASPENDING_AWARDS, json=body, timeout=TIMEOUT, headers=HEADERS)
        r.raise_for_status()
        rows = (r.json() or {}).get("results") or []
        out = []
        for a in rows:
            title = a.get("Description") or ""
            agency = a.get("Awarding Agency") or ""
            if not _is_fire_relevant(title, agency):
                continue
            out.append({
                "opportunity_id": a.get("Award ID") or "",
                "title": title[:120] if title else "(Fire Grant)",
                "agency": agency,
                "award_ceiling": a.get("Award Amount") or 0,
                "award_floor": None,
                "open_date": a.get("Start Date") or "",
                "close_date": "",
                "status": "awarded",
                "cfda": [],
                "state": a.get("Place of Performance State Code") or "",
            })
        print(f"[grants_intel] USASpending fallback: {len(out)} fire-relevant awards")
        return out
    except Exception as e:
        print(f"[grants_intel] USASpending fallback failed: {e}")
        return []


def _fetch_awards() -> List[Dict[str, Any]]:
    """Fetch recent AFG/SAFER awards by CFDA program number."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    start = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 365 * 86400))
    body = {
        "filters": {
            "program_numbers": PROGRAM_NUMBERS,
            "time_period": [{"start_date": start, "end_date": today}],
            "award_type_codes": ["02", "03", "04", "05"],
        },
        "fields": [
            "Award ID", "Recipient Name", "Award Amount",
            "Awarding Agency", "Start Date", "Place of Performance State Code",
        ],
        "sort": "Award Amount",
        "order": "desc",
        "limit": 50,
        "page": 1,
    }
    r = requests.post(USASPENDING_AWARDS, json=body, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    rows = (r.json() or {}).get("results") or []
    out: List[Dict[str, Any]] = []
    for a in rows:
        amount = a.get("Award Amount") or 0
        if not amount:
            continue
        out.append({
            "award_id": a.get("Award ID") or "",
            "recipient": a.get("Recipient Name") or "",
            "amount": float(amount),
            "agency": a.get("Awarding Agency") or "",
            "start_date": a.get("Start Date") or "",
            "state": a.get("Place of Performance State Code") or "",
        })
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "grants_intel.json"

    opportunities: List[Dict[str, Any]] = []
    awards: List[Dict[str, Any]] = []
    errors: List[str] = []

    try:
        opportunities = _fetch_opportunities()
        print(f"[grants_intel] opportunities: {len(opportunities)}")
    except Exception as e:
        errors.append(f"opportunities: {e}")
        print(f"[grants_intel] opportunities failed: {e}")

    try:
        awards = _fetch_awards()
        print(f"[grants_intel] awards: {len(awards)}")
    except Exception as e:
        errors.append(f"awards: {e}")
        print(f"[grants_intel] awards failed: {e}")

    total_awarded = sum(float(a.get("amount") or 0) for a in awards)
    states = sorted({a["state"] for a in awards if a.get("state")})

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "opportunities": opportunities,
        "awards": awards[:100],
        "summary": {
            "open_opportunity_count": len(opportunities),
            "award_count": len(awards),
            "total_awarded": round(total_awarded, 2),
            "states_with_awards": states,
        },
    }
    if errors and not (opportunities or awards):
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[grants_intel] wrote {out_path}")


if __name__ == "__main__":
    main()
