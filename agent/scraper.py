"""
scraper.py — Fire Intel Agent
Concurrent scraper: fetches all sources in parallel using ThreadPoolExecutor.
Hard limits prevent timeout:
  - max_articles_per_site: 20 (from config, default 20)
  - timeout_seconds: 10 (per-request, from config)
  - max_workers: 12 concurrent fetches
  - per-source wall-clock limit: 25 seconds
"""
from __future__ import annotations

import os
import pathlib
import sqlite3
import time
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout, as_completed
import json
from typing import Any, Dict, List, Optional

import feedparser
import yaml

from agent.common import canonical_url, extract_text, fetch, sha256_bytes
from agent.db_migrations import ensure_schema

logging.basicConfig(level=os.environ.get("LOGLEVEL", "INFO"),
                    format="scraper %(levelname)s: %(message)s")

ROOT = pathlib.Path(__file__).resolve().parents[1]
MAX_WORKERS        = 12    # concurrent source fetches
SOURCE_TIMEOUT_S   = 25    # wall-clock seconds per source
ARTICLE_TIMEOUT_S  = 10    # per-article HTTP timeout (overridden by config)
MAX_ARTICLES       = 20    # per-source article cap (overridden by config)


def _scrape_rss(feed_url: str, ua: str, timeout: int, max_items: int) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    try:
        fp = feedparser.parse(feed_url)
    except Exception as e:
        logging.warning(f"feedparser failed {feed_url}: {e}")
        return out
    for e in fp.entries[:max_items]:
        link = canonical_url(getattr(e, "link", "") or "")
        title = getattr(e, "title", "") or ""
        if not link:
            continue
        published_at: Optional[str] = None
        for attr in ("published_parsed", "updated_parsed"):
            val = getattr(e, attr, None)
            if val:
                published_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", val)
                break
        try:
            html = fetch(link, ua, timeout)
            title2, text = extract_text(html)
            out.append({"url": link, "source": feed_url, "title": title2 or title,
                        "sha256": sha256_bytes(html), "content": html.decode("utf-8","ignore"),
                        "text": text, "published_at": published_at, "error": None})
        except Exception as ex:
            out.append({"url": link, "source": feed_url, "title": title,
                        "sha256": "", "content": "", "text": "",
                        "published_at": published_at, "error": str(ex)})
    return out


def _scrape_page(url: str, ua: str, timeout: int) -> Dict[str, Any]:
    html = fetch(url, ua, timeout)
    title, text = extract_text(html)
    return {"url": url, "source": url, "title": title,
            "sha256": sha256_bytes(html), "content": html.decode("utf-8","ignore"),
            "text": text, "published_at": None, "error": None}


def _scrape_source(src: Dict[str, Any], ua: str, timeout: int, max_items: int) -> List[Dict[str, Any]]:
    url   = src.get("url") or (src.get("pages") or [None])[0]
    stype = src.get("type", "page")
    if not url:
        return []
    try:
        if stype in ("rss", "atom"):
            return _scrape_rss(url, ua, timeout, max_items)
        else:
            return [_scrape_page(url, ua, timeout)]
    except Exception as e:
        logging.warning(f"Source failed {url}: {e}")
        return [{"url": url, "source": url, "title": "", "sha256": "",
                 "content": "", "text": "", "published_at": None, "error": str(e)}]


def main():
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    cfg      = yaml.safe_load(open(cfg_path, "r", encoding="utf-8"))
    ua       = cfg.get("crawler", {}).get("user_agent", "FireIntelAgent/1.0")
    timeout  = int(cfg.get("crawler", {}).get("timeout_seconds", ARTICLE_TIMEOUT_S))
    max_items = int(cfg.get("crawler", {}).get("max_articles_per_site", MAX_ARTICLES))
    db_path  = cfg.get("storage", {}).get("db_path", "data/scraper.db")

    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    ensure_schema(db_path)
    con = sqlite3.connect(db_path, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # Collect all sources
    sources: List[Dict[str, Any]] = []
    for section in ["industry_sites", "magazines_rss", "blogs_and_chief_voices",
                    "crr_sources", "wildland_sources", "procurement_sources",
                    "standards_sources"]:
        for s in cfg.get("sources", {}).get(section, []) or []:
            sources.append(s)
    extra_file = cfg.get("sources", {}).get("extra_file")
    if extra_file and os.path.exists(extra_file):
        try:
            for s in (yaml.safe_load(open(extra_file, "r", encoding="utf-8")) or []):
                sources.append(s)
        except Exception as e:
            logging.warning(f"Extra file failed: {e}")

    logging.info(f"Scraping {len(sources)} sources with {MAX_WORKERS} workers "
                 f"(max {max_items} articles/source, {timeout}s timeout)")

    all_items: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_scrape_source, src, ua, timeout, max_items): src
                   for src in sources}
        for future in as_completed(futures, timeout=580):  # 9.5 min hard wall
            src = futures[future]
            try:
                items = future.result(timeout=SOURCE_TIMEOUT_S)
                all_items.extend(items)
                url_hint = src.get("url","")[:60]
                logging.info(f"  {url_hint}: {len(items)} items")
            except FutureTimeout:
                logging.warning(f"  TIMEOUT: {src.get('url','')[:60]}")
            except Exception as e:
                logging.warning(f"  ERROR {src.get('url','')[:60]}: {e}")

    # Write to DB
    count = 0
    for it in all_items:
        try:
            cur.execute(
                """INSERT INTO pages(url, source, title, fetched_at, published_at,
                   sha256, content, text, processed, error)
                   VALUES(?,?,?,?,?,?,?,?,0,?)
                   ON CONFLICT(url) DO UPDATE SET
                     source=excluded.source, title=excluded.title,
                     fetched_at=excluded.fetched_at,
                     published_at=COALESCE(excluded.published_at, pages.published_at),
                     sha256=excluded.sha256, content=excluded.content,
                     text=excluded.text,
                     processed=CASE WHEN excluded.sha256 != pages.sha256 THEN 0
                                    ELSE pages.processed END,
                     error=excluded.error""",
                (it["url"], it["source"], it["title"], now, it.get("published_at"),
                 it["sha256"], it["content"], it["text"], it["error"]),
            )
            count += 1
        except Exception as e:
            logging.warning(f"DB insert failed {it.get('url','')}: {e}")

    con.commit()
    con.close()
    logging.info(f"Scrape complete: {count} entries written from {len(sources)} sources")

    # Write latest.json so the summariser always sees fresh articles each run.
    # Without this, the summariser reads a static seed file and cards never grow.
    out_dir = pathlib.Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
    out_dir.mkdir(exist_ok=True)
    latest_items = [
        {
            "url": it["url"],
            "source": it["source"],
            "title": it["title"],
            "summary": it.get("text") or "",
            "date": it.get("published_at") or now,
        }
        for it in all_items
        if it.get("url") and it.get("title")
    ]
    latest_path = out_dir / "latest.json"
    latest_path.write_text(
        json.dumps({"items": latest_items}, ensure_ascii=False),
        encoding="utf-8",
    )
    logging.info(f"Wrote {len(latest_items)} items to {latest_path}")
    print(f"Scraped entries: {count}")


if __name__ == "__main__":
    main()
