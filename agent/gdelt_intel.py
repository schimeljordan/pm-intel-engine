"""agent/gdelt_intel.py — GDELT DOC 2.0 trade-press monitoring.

Runs a small set of fire/life-safety trade queries against the open GDELT DOC
2.0 API, writes a summary to dashboard/gdelt_intel.json, and also inserts the
discovered articles into the SQLite `pages` table (source="gdelt") so they flow
through the normal summariser/VOC pipeline.

No auth required. We throttle to 1s between queries to be polite.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
import yaml

from agent.db_migrations import ensure_schema

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 10  # Per-request timeout — fail fast, gdelt is flaky
GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc"

DEFAULT_QUERIES = [
    '"fire safety" inspection software',
    '"life safety" compliance platform',
    "NFPA code adoption",
    "fire alarm monitoring acquisition",
    "firefighter grant AFG SAFER",
    "wildfire mitigation technology",
    "fire department records management software",
    "sprinkler inspection compliance",
]
MAX_QUERIES = 8


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load_config() -> Dict[str, Any]:
    cfg_path = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
    if not cfg_path.exists():
        return {}
    try:
        return yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _queries(cfg: Dict[str, Any]) -> List[str]:
    section = cfg.get("gdelt_intel") or {}
    qs = section.get("queries") or DEFAULT_QUERIES
    return list(qs)[:MAX_QUERIES]


def _run_query(query: str) -> List[Dict[str, Any]]:
    params = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": 25,
        "sort": "DateDesc",
        "timespan": "7d",
    }
    r = requests.get(GDELT_DOC, params=params, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    # GDELT occasionally returns empty body or HTML on rate limiting.
    text = r.text.strip()
    if not text or not text.startswith("{"):
        return []
    data = json.loads(text)
    articles = data.get("articles") or []
    out: List[Dict[str, Any]] = []
    for a in articles:
        out.append({
            "title": a.get("title") or "",
            "url": a.get("url") or "",
            "domain": a.get("domain") or "",
            "published_at": a.get("seendate") or "",
            "language": a.get("language") or "",
            "query": query,
        })
    return out


def _normalize_seendate(s: str) -> str:
    """GDELT seendate looks like 20260601T120000Z → 2026-06-01T12:00:00Z."""
    s = (s or "").strip()
    if len(s) == 16 and "T" in s and s.endswith("Z"):
        d, t = s[:8], s[9:15]
        return f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}Z"
    return s


def _insert_pages(rows: List[Dict[str, Any]]) -> int:
    if not rows:
        return 0
    cfg = _load_config()
    db_path = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")
    try:
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        ensure_schema(db_path)
        con = sqlite3.connect(db_path)
        cur = con.cursor()
        now = _now()
        inserted = 0
        for row in rows:
            url = row.get("url") or ""
            if not url:
                continue
            title = row.get("title") or ""
            published = _normalize_seendate(row.get("published_at") or "")
            sha = hashlib.sha256((title + url).encode("utf-8")).hexdigest()
            cur.execute(
                """INSERT INTO pages(url, source, title, fetched_at, published_at, sha256, content, text, processed, error)
                   VALUES(?,?,?,?,?,?,?,?,0,?)
                   ON CONFLICT(url) DO UPDATE SET
                     title=excluded.title,
                     published_at=COALESCE(excluded.published_at, pages.published_at)""",
                (url, "gdelt", title, now, published, sha, "", title, ""),
            )
            inserted += 1
        con.commit()
        con.close()
        return inserted
    except Exception as e:
        print(f"[gdelt_intel] pages insert failed: {e}")
        return 0


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "gdelt_intel.json"
    cfg = _load_config()
    queries = _queries(cfg)

    all_rows: List[Dict[str, Any]] = []
    seen_urls = set()
    errors: List[str] = []
    per_query: List[Dict[str, Any]] = []

    for q in queries:
        try:
            rows = _run_query(q)
            new_rows = [r for r in rows if r.get("url") and r["url"] not in seen_urls]
            for r in new_rows:
                seen_urls.add(r["url"])
            all_rows.extend(new_rows)
            per_query.append({"query": q, "count": len(rows)})
            print(f"[gdelt_intel] {q!r}: {len(rows)} articles")
        except Exception as e:
            errors.append(f"{q}: {e}")
            print(f"[gdelt_intel] query failed {q!r}: {e}")
        time.sleep(1.0)

    inserted = _insert_pages(all_rows)
    print(f"[gdelt_intel] inserted {inserted} rows into pages")

    domains: Dict[str, int] = {}
    for r in all_rows:
        d = r.get("domain") or ""
        if d:
            domains[d] = domains.get(d, 0) + 1
    top_domains = sorted(
        ({"domain": k, "count": v} for k, v in domains.items()),
        key=lambda x: x["count"], reverse=True,
    )[:15]

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "queries_run": per_query,
        "total_articles": len(all_rows),
        "articles": all_rows[:100],
        "top_domains": top_domains,
    }
    if errors and not all_rows:
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[gdelt_intel] wrote {out_path} ({len(all_rows)} articles)")


if __name__ == "__main__":
    main()
