"""agent/wildfire_intel.py — Active wildfire intelligence from NIFC WFIGS + NWS alerts.

Primary sources (all public, no auth):
  ESRI Current Incidents: live active fires with acres, % contained, structures
  NIFC WFIGS Perimeters:  current-year polygon perimeters for the map
  NWS Alerts:             fire weather watches/warnings by state
  OpenFEMA:               recent fire disaster declarations
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/2.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 20

# ESRI current incidents (active fires only, point layer with structures/fatalities)
ESRI_CURRENT = (
    "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/"
    "USA_Wildfires_v1/FeatureServer/0/query"
)
# NIFC WFIGS polygon perimeters (current)
NIFC_PERIMETERS = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)
# NWS fire weather alerts (correct endpoint)
NWS_URL = "https://api.weather.gov/alerts"
# OpenFEMA fire disaster declarations
FEMA_DECLARATIONS = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"

FIRE_ALERT_EVENTS = {
    "Red Flag Warning", "Fire Weather Watch", "Extreme Fire Danger",
    "Fire Warning", "High Wind Warning", "High Wind Watch",
    "Extreme Heat Warning", "Wind Advisory", "Dust Storm Warning",
}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _get(url: str, params: dict = None) -> Optional[dict]:
    try:
        r = requests.get(url, params=params or {}, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[wildfire_intel] WARN: {url[:60]}... → {e}")
        return None


def _fetch_active_incidents() -> List[Dict[str, Any]]:
    """Fetch active wildfire incidents from ESRI Current_Incidents layer."""
    FIELDS = ("IncidentName,IncidentTypeCategory,DailyAcres,CalculatedAcres,"
              "PercentContained,POOState,POOCounty,FireDiscoveryDateTime,"
              "FireCauseGeneral,TotalIncidentPersonnel,FireMgmtComplexity,"
              "ResidencesDestroyed,OtherStructuresDestroyed,Injuries,Fatalities,"
              "PredominantFuelGroup,ContainmentDateTime,GACC")
    data = _get(ESRI_CURRENT, {
        "where": "1=1",
        "outFields": FIELDS,
        "outSR": "4326",
        "f": "json",
        "resultRecordCount": 200,
        "orderByFields": "DailyAcres DESC",
    })
    if not data:
        return []
    out = []
    for feat in data.get("features", []):
        a = feat.get("attributes", {})
        ts = a.get("FireDiscoveryDateTime")
        disc_date = (datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                     if ts else None)
        acres = a.get("DailyAcres") or a.get("CalculatedAcres") or 0
        out.append({
            "name": a.get("IncidentName") or "Unknown",
            "state": (a.get("POOState") or "").replace("US-", ""),
            "county": a.get("POOCounty") or "",
            "acres": round(acres),
            "contained_pct": a.get("PercentContained"),
            "discovered": disc_date,
            "cause": a.get("FireCauseGeneral") or "",
            "complexity": a.get("FireMgmtComplexity") or "",
            "personnel": a.get("TotalIncidentPersonnel") or 0,
            "residences_destroyed": a.get("ResidencesDestroyed") or 0,
            "structures_destroyed": a.get("OtherStructuresDestroyed") or 0,
            "injuries": a.get("Injuries") or 0,
            "fatalities": a.get("Fatalities") or 0,
            "fuel_group": a.get("PredominantFuelGroup") or "",
            "gacc": a.get("GACC") or "",
        })
    print(f"[wildfire_intel] Active incidents: {len(out)}")
    return out


def _fetch_fire_weather_alerts() -> List[Dict[str, Any]]:
    """Fetch active fire weather alerts from NWS."""
    data = _get(NWS_URL, {"active": "true", "limit": 500})
    if not data:
        return []
    out = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        if p.get("event") not in FIRE_ALERT_EVENTS:
            continue
        out.append({
            "event": p.get("event"),
            "headline": p.get("headline") or p.get("areaDesc") or "",
            "area": p.get("areaDesc") or "",
            "severity": p.get("severity") or "",
            "urgency": p.get("urgency") or "",
            "sent": p.get("sent") or "",
            "expires": p.get("expires") or "",
            "zones": p.get("affectedZones", [])[:5],
        })
    print(f"[wildfire_intel] Fire weather alerts: {len(out)}")
    return out


def _fetch_fema_fire_declarations() -> List[Dict[str, Any]]:
    """Fetch recent FEMA fire disaster declarations (last 2 years)."""
    data = _get(FEMA_DECLARATIONS, {
        "$filter": "incidentType eq 'Fire'",
        "$top": 50,
        "$orderby": "declarationDate desc",
        "$select": ("disasterNumber,state,declarationTitle,declarationDate,"
                    "incidentBeginDate,incidentEndDate,designatedArea,fyDeclared"),
    })
    if not data:
        return []
    out = []
    for d in data.get("DisasterDeclarationsSummaries", []):
        out.append({
            "disaster_number": f"DR-{d.get('disasterNumber')}",
            "state": d.get("state") or "",
            "title": d.get("declarationTitle") or "",
            "declaration_date": (d.get("declarationDate") or "")[:10],
            "incident_begin": (d.get("incidentBeginDate") or "")[:10],
            "incident_end": (d.get("incidentEndDate") or "")[:10],
            "area": d.get("designatedArea") or "",
            "fy": d.get("fyDeclared"),
        })
    print(f"[wildfire_intel] FEMA fire declarations: {len(out)}")
    return out


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    generated_at = _now()

    incidents = _fetch_active_incidents()
    alerts = _fetch_fire_weather_alerts()
    declarations = _fetch_fema_fire_declarations()

    # Summary stats
    total_acres = sum(i.get("acres", 0) for i in incidents)
    total_structures = sum(i.get("residences_destroyed", 0) + i.get("structures_destroyed", 0)
                          for i in incidents)
    large_fires = [i for i in incidents if i.get("acres", 0) >= 1000]

    out = {
        "generated_at": generated_at,
        "summary": {
            "active_incidents": len(incidents),
            "large_fires_over_1000ac": len(large_fires),
            "total_acres_burning": total_acres,
            "total_structures_destroyed": total_structures,
            "active_weather_alerts": len(alerts),
            "fema_declarations_recent": len(declarations),
        },
        "incidents": incidents,
        "weather_alerts": alerts,
        "fema_declarations": declarations,
    }

    path = OUT_DIR / "wildfire_intel.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[wildfire_intel] → {path} ({len(incidents)} incidents, {len(alerts)} alerts, {len(declarations)} declarations)")

    # Supabase — non-fatal
    try:
        from .supabase_writer import write_wildfire_incidents
        write_wildfire_incidents(out)
    except Exception as e:
        print(f"[wildfire_intel] Supabase write skipped: {e}")


if __name__ == "__main__":
    main()
