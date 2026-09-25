"""agent/bls_intel.py — BLS occupational employment + wage data for fire/EMS workforce.

Sources (all public, no auth):
  BLS OES series OES332011 — Firefighters (employment, wages)
  BLS OES series OES292041 — EMTs and Paramedics
  BLS Occupational Outlook — projected growth
  USASpending — AFG/SAFER grant awards by state (labor capacity proxy)
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/2.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 20

BLS_API = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
USASPENDING = "https://api.usaspending.gov/api/v2/search/spending_by_award/"

# OES series IDs (national)
SERIES = {
    "firefighters":     "OEUN000000000000033201100008",   # total employment
    "firefighters_wage":"OEUN000000000000033201100004",   # annual mean wage
    "ems_paramedics":   "OEUN000000000000029204100008",
    "ems_wage":         "OEUN000000000000029204100004",
    "fire_inspectors":  "OEUN000000000000033902400008",
}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _fetch_bls_series(series_ids: List[str], start_year: str = "2020", end_year: str = "2024") -> Dict[str, List]:
    """Fetch multiple BLS time series in one call."""
    try:
        r = requests.post(BLS_API, json={
            "seriesid": series_ids,
            "startyear": start_year,
            "endyear": end_year,
        }, headers={**HEADERS, "Content-Type": "application/json"}, timeout=TIMEOUT)
        r.raise_for_status()
        results = {}
        for series in r.json().get("Results", {}).get("series", []):
            sid = series.get("seriesID")
            data = sorted(series.get("data", []), key=lambda x: x.get("year", ""), reverse=True)
            results[sid] = data
        return results
    except Exception as e:
        print(f"[bls_intel] BLS fetch failed: {e}")
        return {}


def _fetch_afg_grants_by_state() -> List[Dict[str, Any]]:
    """AFG + SAFER grants by state from USASpending — workforce capacity proxy."""
    today = time.strftime("%Y-%m-%d", time.gmtime())
    try:
        r = requests.post(USASPENDING, json={
            "filters": {
                "program_numbers": ["97.044", "97.083"],
                "award_type_codes": ["02", "03", "04", "05"],
                "time_period": [{"start_date": "2023-01-01", "end_date": today}],
            },
            "fields": ["Award ID", "Recipient Name", "Award Amount",
                       "Place of Performance State Code", "Start Date", "Description"],
            "sort": "Award Amount", "order": "desc", "limit": 100, "page": 1,
        }, headers={**HEADERS, "Content-Type": "application/json"}, timeout=TIMEOUT)
        r.raise_for_status()
        rows = r.json().get("results", [])

        # Aggregate by state
        by_state: Dict[str, Dict] = {}
        for a in rows:
            state = a.get("Place of Performance State Code") or "XX"
            if state not in by_state:
                by_state[state] = {"state": state, "total_awards": 0, "total_amount": 0, "recipients": []}
            by_state[state]["total_awards"] += 1
            by_state[state]["total_amount"] += a.get("Award Amount") or 0
            by_state[state]["recipients"].append({
                "name": a.get("Recipient Name") or "",
                "amount": a.get("Award Amount") or 0,
                "date": (a.get("Start Date") or "")[:10],
            })

        out = sorted(by_state.values(), key=lambda x: -x["total_amount"])
        print(f"[bls_intel] AFG/SAFER grants: {len(rows)} awards across {len(out)} states")
        return out
    except Exception as e:
        print(f"[bls_intel] USASpending fetch failed: {e}")
        return []


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)

    # Fetch BLS series
    series_ids = list(SERIES.values())
    bls_data = _fetch_bls_series(series_ids)

    # Map series IDs back to readable names
    id_to_name = {v: k for k, v in SERIES.items()}
    workforce = {}
    for sid, data in bls_data.items():
        name = id_to_name.get(sid, sid)
        if data:
            latest = data[0]
            workforce[name] = {
                "latest_year": latest.get("year"),
                "latest_value": latest.get("value"),
                "unit": "employment" if "wage" not in name else "annual_mean_wage_usd",
                "history": [{"year": d.get("year"), "value": d.get("value")} for d in data[:5]],
            }
    print(f"[bls_intel] BLS workforce series: {list(workforce.keys())}")

    # AFG grants by state
    grants_by_state = _fetch_afg_grants_by_state()

    out = {
        "generated_at": _now(),
        "description": "BLS occupational employment/wage data for fire/EMS workforce + AFG/SAFER federal grant awards",
        "workforce": workforce,
        "afg_safer_grants_by_state": grants_by_state,
        "totals": {
            "firefighter_employment": workforce.get("firefighters", {}).get("latest_value"),
            "firefighter_mean_wage_usd": workforce.get("firefighters_wage", {}).get("latest_value"),
            "ems_employment": workforce.get("ems_paramedics", {}).get("latest_value"),
            "afg_states_funded": len(grants_by_state),
            "afg_total_amount": sum(s["total_amount"] for s in grants_by_state),
        },
    }

    path = OUT_DIR / "bls_intel.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[bls_intel] → {path}")


if __name__ == "__main__":
    main()
