"""agent/app_store_intel.py — Apple App Store review monitoring via iTunes RSS.

Pulls recent customer reviews for competitor mobile apps from Apple's public
customer-reviews RSS feed (no auth). Apps are read from config.yaml
(`competitor_apps:`) when present, otherwise a built-in default list is used.

We page through reviews 1-3 and throttle 2s between requests.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
import yaml

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 15
MAX_PAGES = 3

# Fallback list when config has no competitor_apps. id = Apple numeric app id.
DEFAULT_APPS = [
    {"name": "First Due", "id": "1454681840"},
    {"name": "SafetyCulture (iAuditor)", "id": "499999532"},
    {"name": "Inspect Point", "id": "1097995517"},
]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load_apps() -> List[Dict[str, str]]:
    cfg_path = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
    if cfg_path.exists():
        try:
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            apps = cfg.get("competitor_apps") or []
            cleaned = [
                {"name": a.get("name") or "", "id": str(a.get("app_id") or a.get("id") or "")}
                for a in apps
                if isinstance(a, dict) and (a.get("app_id") or a.get("id"))
            ]
            if cleaned:
                return cleaned
        except Exception as e:
            print(f"[app_store_intel] could not read config competitor_apps: {e}")
    return DEFAULT_APPS


def _fetch_reviews(app_id: str) -> List[Dict[str, Any]]:
    reviews: List[Dict[str, Any]] = []
    for page in range(1, MAX_PAGES + 1):
        url = (
            f"https://itunes.apple.com/us/rss/customerreviews/"
            f"page={page}/id={app_id}/sortby=mostrecent/json"
        )
        r = requests.get(url, timeout=TIMEOUT, headers=HEADERS)
        r.raise_for_status()
        feed = (r.json() or {}).get("feed") or {}
        entries = feed.get("entry") or []
        # First entry on page 1 is app metadata, not a review.
        for e in entries:
            if not isinstance(e, dict):
                continue
            if "im:rating" not in e:
                continue
            try:
                rating = int((e.get("im:rating") or {}).get("label") or 0)
            except (TypeError, ValueError):
                rating = 0
            reviews.append({
                "title": (e.get("title") or {}).get("label") or "",
                "content": (e.get("content") or {}).get("label") or "",
                "rating": rating,
                "author": ((e.get("author") or {}).get("name") or {}).get("label") or "",
                "version": (e.get("im:version") or {}).get("label") or "",
                "updated": (e.get("updated") or {}).get("label") or "",
            })
        time.sleep(2.0)
    return reviews


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "app_store_intel.json"
    apps_cfg = _load_apps()

    apps_out: List[Dict[str, Any]] = []
    errors: List[str] = []

    for app in apps_cfg:
        app_id = app.get("id") or ""
        name = app.get("name") or app_id or "app"
        try:
            reviews = _fetch_reviews(app_id)
            ratings = [r["rating"] for r in reviews if r.get("rating")]
            avg = round(sum(ratings) / len(ratings), 2) if ratings else 0
            apps_out.append({
                "name": name,
                "app_id": app_id,
                "review_count": len(reviews),
                "avg_rating": avg,
                "reviews": reviews[:30],
            })
            print(f"[app_store_intel] {name}: {len(reviews)} reviews avg {avg}")
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"[app_store_intel] {name} failed: {e}")
            apps_out.append({
                "name": name, "app_id": app_id,
                "review_count": 0, "avg_rating": 0, "reviews": [],
            })

    out: Dict[str, Any] = {"generated_at": _now(), "apps": apps_out}
    if errors and not any(a["reviews"] for a in apps_out):
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[app_store_intel] wrote {out_path} ({len(apps_out)} apps)")


if __name__ == "__main__":
    main()
