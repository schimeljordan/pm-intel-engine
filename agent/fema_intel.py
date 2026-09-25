"""agent/fema_intel.py — OpenFEMA fire disaster declarations + Grants.gov opportunities.

All APIs are open (no auth). On any failure we still write a JSON file with an
`error` field so the frontend can degrade gracefully.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 15

# NOTE: OData $filter with spaces must be passed as a separate param, not embedded in URL
OPENFEMA_BASE = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"
OPENFEMA_PARAMS = {
    "$filter": "incidentType eq 'Fire'",
    "$orderby": "declarationDate desc",
    "$top": "100",
}
OPENFEMA_PA_PROJECTS = (
    "https://www.fema.gov/api/open/v2/PublicAssistanceFundedProjectsDetails"
    "?$filter=projectType ne 'NA'&$top=500"
)
GRANTS_SEARCH = "https://api.grants.gov/v1/api/search2"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _fetch_declarations() -> List[Dict[str, Any]]:
    r = requests.get(OPENFEMA_BASE, params=OPENFEMA_PARAMS, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    rows = r.json().get("DisasterDeclarationsSummaries", []) or []
    out: List[Dict[str, Any]] = []
    for d in rows:
        programs = [
            k.replace("Program", "")
            for k in ("ihProgramDeclared", "iaProgramDeclared", "paProgramDeclared", "hmProgramDeclared")
            if d.get(k)
        ]
        out.append({
            "id": str(d.get("disasterNumber") or d.get("femaDeclarationString") or ""),
            "state": d.get("state") or "",
            "county": d.get("designatedArea") or "",
            "declaration_date": d.get("declarationDate") or "",
            "incident_type": d.get("incidentType") or "Fire",
            "title": d.get("declarationTitle") or "",
            "programs_declared": programs,
        })
    return out


def _fetch_pa_projects() -> List[Dict[str, Any]]:
    r = requests.get(OPENFEMA_PA_PROJECTS, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    rows = r.json().get("PublicAssistanceFundedProjectsDetails", []) or []
    out: List[Dict[str, Any]] = []
    for p in rows[:500]:
        out.append({
            "state": p.get("stateCode") or p.get("state") or "",
            "county": p.get("county") or "",
            "project_amount": p.get("projectAmount") or 0,
            "project_type": p.get("projectType") or "",
            "damage_category": p.get("damageCategory") or p.get("damageCategoryCode") or "",
        })
    return out


def _fetch_grants() -> List[Dict[str, Any]]:
    body = {"keyword": "firefighter fire safety AFG SAFER", "rows": 25}
    r = requests.post(GRANTS_SEARCH, json=body, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    data = r.json() or {}
    hits = (((data.get("data") or {}).get("oppHits")) or data.get("oppHits") or [])
    out: List[Dict[str, Any]] = []
    for g in hits:
        out.append({
            "opportunity_id": str(g.get("id") or g.get("number") or ""),
            "title": g.get("title") or "",
            "agency": g.get("agencyName") or g.get("agency") or "",
            "open_date": g.get("openDate") or "",
            "close_date": g.get("closeDate") or "",
            "award_ceiling": g.get("awardCeiling") or "",
            "synopsis": g.get("description") or g.get("synopsis") or "",
        })
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "fema_intel.json"

    declarations: List[Dict[str, Any]] = []
    grants: List[Dict[str, Any]] = []
    pa_projects: List[Dict[str, Any]] = []
    errors: List[str] = []

    try:
        declarations = _fetch_declarations()
        print(f"[fema_intel] fire declarations: {len(declarations)}")
    except Exception as e:
        errors.append(f"declarations: {e}")
        print(f"[fema_intel] declarations failed: {e}")

    try:
        pa_projects = _fetch_pa_projects()
        print(f"[fema_intel] PA projects: {len(pa_projects)}")
    except Exception as e:
        errors.append(f"pa_projects: {e}")
        print(f"[fema_intel] PA projects failed: {e}")

    try:
        grants = _fetch_grants()
        print(f"[fema_intel] grant opportunities: {len(grants)}")
    except Exception as e:
        errors.append(f"grants: {e}")
        print(f"[fema_intel] grants failed: {e}")

    states = sorted({d["state"] for d in declarations if d.get("state")})
    total_ceiling = 0
    for g in grants:
        try:
            total_ceiling += int(float(str(g.get("award_ceiling") or 0).replace(",", "") or 0))
        except (ValueError, TypeError):
            pass

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "disaster_declarations": declarations,
        "active_grants": grants,
        "pa_projects": pa_projects,
        "summary": {
            "total_fire_declarations_ytd": len(declarations),
            "states_with_declarations": states,
            "active_grant_count": len(grants),
            "total_grant_ceiling": total_ceiling,
        },
    }
    if errors and not (declarations or grants or pa_projects):
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[fema_intel] wrote {out_path}")


if __name__ == "__main__":
    main()
