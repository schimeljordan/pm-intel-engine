"""agent/patent_intel.py — PatentsView fire-safety patent monitoring.

Tracks recent grants in CPC classes A62C (fire fighting), A62B (rescue),
G08B17 (fire/smoke alarms) and cross-references assignees against competitors.
No auth required.
"""
from __future__ import annotations

import collections
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
import yaml

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {
    "User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)",
    "Content-Type": "application/json",
}
TIMEOUT = 15
LOOKBACK_DAYS = 180
CPC_CODES = ["A62C", "A62B", "G08B17"]
# PatentsView API URLs — note: search.patentsview.org has DNS issues in GitHub Actions sandbox
# api.patentsview.org resolves but returns HTML (web interface, not JSON API)
# TODO: replace with USPTO Open Data Portal when API key becomes available
BASE_URLS = [
    "https://api.patentsview.org/api/v1/patent/",
    "https://api.patentsview.org/patents/query",
]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _from_date() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - LOOKBACK_DAYS * 86400))


def _competitor_names() -> List[str]:
    path = Path("data/competitors.yaml")
    if not path.exists():
        return []
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return list((data.get("competitors") or {}).keys())
    except Exception:
        return []


def _query_patentsview(from_date: str) -> List[Dict[str, Any]]:
    body = {
        "q": {"_and": [
            {"_gte": {"patent_date": from_date}},
            {"_or": [{"cpc_subgroup_id": c} for c in CPC_CODES]},
        ]},
        "f": ["patent_number", "patent_title", "patent_date",
              "assignee_organization", "cpc_subgroup_id"],
        "o": {"per_page": 100, "page": 1},
        "s": [{"patent_date": "desc"}],
    }
    last_err: Exception | None = None
    for url in BASE_URLS:
        try:
            r = requests.post(url, json=body, timeout=TIMEOUT, headers=HEADERS)
            if r.status_code == 404:
                last_err = Exception("404")
                continue
            r.raise_for_status()
            ct = r.headers.get("content-type", "")
            if "html" in ct or r.text.strip().startswith("<!"):
                last_err = Exception(f"PatentsView returned HTML at {url} (API broken/redirect)")
                continue
            return r.json().get("patents") or []
        except Exception as e:
            last_err = e
            continue
    if last_err:
        raise last_err
    return []


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "patent_intel.json"
    from_date = _from_date()
    to_date = time.strftime("%Y-%m-%d", time.gmtime())

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "date_range": {"from": from_date, "to": to_date},
        "total_patents": 0,
        "top_assignees": [],
        "patents": [],
        "competitor_patents": [],
    }

    try:
        raw = _query_patentsview(from_date)
    except Exception as e:
        out["error"] = str(e)
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[patent_intel] failed: {e} — wrote empty {out_path}")
        return

    competitors = _competitor_names()
    comp_lower = {c.lower(): c for c in competitors}

    patents: List[Dict[str, Any]] = []
    assignee_counts: collections.Counter = collections.Counter()
    comp_buckets: Dict[str, List[Dict[str, Any]]] = collections.defaultdict(list)

    for p in raw:
        assignees = p.get("assignees") or []
        org = ""
        if assignees and isinstance(assignees, list):
            org = assignees[0].get("assignee_organization") or ""
        cpcs = p.get("cpcs") or []
        cpc = ""
        if cpcs and isinstance(cpcs, list):
            cpc = cpcs[0].get("cpc_subgroup_id") or ""
        number = p.get("patent_number") or ""
        rec = {
            "number": number,
            "title": p.get("patent_title") or "",
            "date": p.get("patent_date") or "",
            "assignee": org,
            "cpc": cpc,
            "url": f"https://patents.google.com/patent/US{number}" if number else "",
        }
        patents.append(rec)
        if org:
            assignee_counts[org] += 1
        for cl, cname in comp_lower.items():
            if org and (cl in org.lower() or org.lower() in cl):
                comp_buckets[cname].append(rec)

    top_assignees = [
        {"name": name, "count": cnt,
         "is_competitor": any(name.lower() in cl or cl in name.lower() for cl in comp_lower)}
        for name, cnt in assignee_counts.most_common(10)
    ]

    out["total_patents"] = len(patents)
    out["patents"] = patents[:100]
    out["top_assignees"] = top_assignees
    out["competitor_patents"] = [
        {"competitor": c, "patents": pats} for c, pats in comp_buckets.items()
    ]

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[patent_intel] wrote {out_path} ({len(patents)} patents)")


if __name__ == "__main__":
    main()
