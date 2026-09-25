"""agent/ecfr_intel.py — eCFR regulation change monitoring (OSHA + FEMA).

Uses the open eCFR versioner API to detect recent amendments to Title 29
(Labor / OSHA — includes 1910 life-safety & fire protection subparts) and
Title 44 (Emergency Management / FEMA). We cache the last-seen state in
data/ecfr_state.json so we can flag genuinely new amendment dates each run.

No auth required. Writes dashboard/ecfr_intel.json.
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
LOOKBACK_DAYS = 90
STATE_PATH = Path("data/ecfr_state.json")

TITLES = {
    "29": "Labor (OSHA)",
    "44": "Emergency Management (FEMA)",
}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _cutoff() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - LOOKBACK_DAYS * 86400))


def _load_state() -> Dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}
    return {}


def _save_state(state: Dict[str, Any]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[ecfr_intel] could not write state: {e}")


def _fetch_title_changes(title: str, cutoff: str) -> List[Dict[str, Any]]:
    """Return amendment dates for a title since cutoff via the versioner API."""
    url = f"https://www.ecfr.gov/api/versioner/v1/versions/title-{title}.json"
    r = requests.get(url, params={"issue_date[gte]": cutoff}, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    data = r.json() or {}
    versions = data.get("content_versions") or []
    out: List[Dict[str, Any]] = []
    for v in versions:
        amend = v.get("amendment_date") or v.get("issue_date") or ""
        if amend and amend < cutoff:
            continue
        out.append({
            "title": title,
            "part": v.get("part") or "",
            "subpart": v.get("subpart") or "",
            "section": v.get("identifier") or "",
            "name": v.get("name") or "",
            "amendment_date": amend,
            "issue_date": v.get("issue_date") or "",
        })
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "ecfr_intel.json"
    cutoff = _cutoff()
    state = _load_state()
    seen_dates: Dict[str, List[str]] = state.get("seen_amendment_dates") or {}

    titles_out: List[Dict[str, Any]] = []
    errors: List[str] = []
    new_state_dates: Dict[str, List[str]] = {}

    for title, label in TITLES.items():
        try:
            changes = _fetch_title_changes(title, cutoff)
            prev = set(seen_dates.get(title) or [])
            cur_dates = sorted({c["amendment_date"] for c in changes if c["amendment_date"]})
            for c in changes:
                c["is_new"] = bool(c["amendment_date"]) and c["amendment_date"] not in prev
            new_state_dates[title] = cur_dates
            new_count = sum(1 for c in changes if c.get("is_new"))
            titles_out.append({
                "title": title,
                "label": label,
                "change_count": len(changes),
                "new_change_count": new_count,
                "changes": changes[:100],
            })
            print(f"[ecfr_intel] title {title} ({label}): {len(changes)} changes, {new_count} new")
        except Exception as e:
            errors.append(f"title {title}: {e}")
            print(f"[ecfr_intel] title {title} failed: {e}")
            titles_out.append({
                "title": title, "label": label,
                "change_count": 0, "new_change_count": 0, "changes": [],
            })

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "cutoff_date": cutoff,
        "titles": titles_out,
        "summary": {
            "total_changes": sum(t["change_count"] for t in titles_out),
            "total_new_changes": sum(t["new_change_count"] for t in titles_out),
        },
    }
    if errors and not any(t["changes"] for t in titles_out):
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    # Only persist state when we actually fetched something, so a transient
    # failure doesn't wipe our baseline and re-flag everything as new.
    if new_state_dates:
        merged = dict(seen_dates)
        merged.update(new_state_dates)
        _save_state({"updated_at": _now(), "seen_amendment_dates": merged})
    print(f"[ecfr_intel] wrote {out_path}")


if __name__ == "__main__":
    main()
