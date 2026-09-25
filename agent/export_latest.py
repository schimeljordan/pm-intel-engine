"""
export_latest.py — Fire Intel Agent
Exports unprocessed pages from the scraper DB to dashboard/latest.json.

Deduplication layers (in order):
  1. URL primary key in DB (handled by scraper INSERT ON CONFLICT)
  2. Exact title dedup — same title from different domains → keep highest-scored
  3. Content fingerprint dedup — SHA256 of first 500 chars of text
  4. Near-title dedup — titles with >85% token overlap treated as same story
  5. Domain flood control — cap at MAX_PER_DOMAIN cards per domain per run
     so one prolific source can't dominate the VOC count
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import yaml

from agent.db_migrations import ensure_schema

MAX_PER_DOMAIN     = 12   # cap per domain to prevent source flooding
MIN_TEXT_LEN       = 60   # skip near-empty pages
TITLE_OVERLAP_THRESH = 0.85  # token Jaccard threshold for near-dupe titles
CONTENT_FP_CHARS   = 600   # chars used for content fingerprint


def _domain(url: str) -> str:
    try:
        return url.split("//", 1)[1].split("/", 1)[0].lower().lstrip("www.")
    except Exception:
        return url[:40]


def _title_tokens(title: str) -> frozenset:
    stopwords = {"the","a","an","of","in","on","at","to","for","and","or","is","are",
                 "was","were","it","its","by","with","from","that","this","as","be"}
    return frozenset(
        w for w in re.findall(r"[a-z0-9]{2,}", title.lower())
        if w not in stopwords
    )


def _jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _content_fp(text: str) -> str:
    return hashlib.sha256(text[:CONTENT_FP_CHARS].encode("utf-8","ignore")).hexdigest()[:16]


def main() -> None:
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    cfg      = yaml.safe_load(open(cfg_path, "r", encoding="utf-8"))
    db_path  = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")
    dash     = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
    dash.mkdir(exist_ok=True)
    latest_path = dash / "latest.json"

    ensure_schema(db_path)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    rows = cur.execute(
        """SELECT url, source, title, text, fetched_at, published_at
           FROM pages
           WHERE processed = 0
             AND (error IS NULL OR error = '')
             AND length(coalesce(title,'')) > 5
           ORDER BY fetched_at DESC"""
    ).fetchall()
    con.close()

    print(f"Rows from DB (unprocessed): {len(rows)}")

    # ── Layer 1: minimum text length ─────────────────────────────────────────
    rows = [r for r in rows if len((r["text"] or "").strip()) >= MIN_TEXT_LEN]
    print(f"After min-text filter: {len(rows)}")

    # ── Layer 2: exact title dedup (keep first/best per exact title) ──────────
    seen_titles: Dict[str, bool] = {}
    deduped: List = []
    for r in rows:
        t = (r["title"] or "").strip().lower()
        if t and t in seen_titles:
            continue
        seen_titles[t] = True
        deduped.append(r)
    print(f"After exact-title dedup: {len(deduped)}")

    # ── Layer 3: content fingerprint dedup ────────────────────────────────────
    seen_fps: Dict[str, bool] = {}
    fp_deduped: List = []
    for r in deduped:
        fp = _content_fp(r["text"] or "")
        if fp in seen_fps:
            continue
        seen_fps[fp] = True
        fp_deduped.append(r)
    print(f"After content-fingerprint dedup: {len(fp_deduped)}")

    # ── Layer 4: near-title dedup (Jaccard token overlap) ────────────────────
    seen_token_sets: List[Tuple[frozenset, str]] = []
    near_deduped: List = []
    for r in fp_deduped:
        tokens = _title_tokens(r["title"] or "")
        is_near_dupe = any(
            _jaccard(tokens, s) >= TITLE_OVERLAP_THRESH
            for s, _ in seen_token_sets
        )
        if is_near_dupe:
            continue
        seen_token_sets.append((tokens, r["url"]))
        near_deduped.append(r)
    print(f"After near-title dedup (Jaccard {TITLE_OVERLAP_THRESH}): {len(near_deduped)}")

    # ── Layer 5: domain flood control ────────────────────────────────────────
    domain_counts: Dict[str, int] = defaultdict(int)
    flood_deduped: List = []
    flood_skipped = 0
    for r in near_deduped:
        d = _domain(r["url"])
        if domain_counts[d] >= MAX_PER_DOMAIN:
            flood_skipped += 1
            continue
        domain_counts[d] += 1
        flood_deduped.append(r)
    print(f"After domain flood control (max {MAX_PER_DOMAIN}/domain): "
          f"{len(flood_deduped)} ({flood_skipped} dropped)")

    final_rows = flood_deduped

    # ── Mark as processed in DB ───────────────────────────────────────────────
    if final_rows:
        con2 = sqlite3.connect(db_path)
        con2.execute(
            "UPDATE pages SET processed = 1 "
            "WHERE processed = 0 AND (error IS NULL OR error = '')"
        )
        con2.commit()
        con2.close()

    # ── Build items list ──────────────────────────────────────────────────────
    items = []
    for r in final_rows:
        items.append({
            "url":    r["url"],
            "source": r["source"],
            "title":  (r["title"] or "").strip(),
            "text":   (r["text"] or "").strip(),
            "date":   r["published_at"] or r["fetched_at"] or "",
            # summary field intentionally left to summariser.py (gpt-4o)
            # to avoid double LLM calls — this is just the raw text passthrough
        })

    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump({"items": items, "dedup_stats": {
            "db_rows": len(rows),
            "after_title_dedup": len(deduped),
            "after_content_fp": len(fp_deduped),
            "after_near_title": len(near_deduped),
            "after_domain_flood": len(flood_deduped),
            "domain_distribution": dict(sorted(domain_counts.items(), key=lambda x: -x[1])[:20]),
        }}, f, ensure_ascii=False, indent=2)

    print(f"Exported {len(items)} deduplicated items → {latest_path}")
    if domain_counts:
        top = sorted(domain_counts.items(), key=lambda x: -x[1])[:8]
        print("Top domains: " + ", ".join(f"{d}:{n}" for d,n in top))


if __name__ == "__main__":
    main()
