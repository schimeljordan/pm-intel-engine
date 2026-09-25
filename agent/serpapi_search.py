# agent/serpapi_search.py
from __future__ import annotations

import logging
import os
import sqlite3
import time
import tldextract
import collections

from typing import Any, Dict, List
from urllib.parse import urlparse

import requests
import yaml

try:  # serpapi is optional at runtime
    import serpapi  # type: ignore
except Exception:  # pragma: no cover - dependency may be missing in tests
    serpapi = None

from agent.common import canonical_url, fetch, extract_text
from agent.db_migrations import ensure_schema

DEFAULT_SITE_LIMIT = 50
MAX_PAGE_SIZE = 100  # Google via SerpAPI caps at 100 results per page


def _is_relevant(text: str, terms: List[str]) -> bool:
    lt = (text or "").lower()
    return any(t in lt for t in terms)


def _strip_quotes(s: str) -> str:
    s = (s or "").strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1].strip()
    return s


def _endswith_any(host: str, suffixes: List[str]) -> bool:
    host = (host or "").lower()
    for s in suffixes or []:
        s = (s or "").lower()
        if not s:
            continue
        if host == s or host.endswith("." + s):
            return True
    return False


def _http_search(query: str, num_results: int, recency_days: int, api_key: str) -> List[Dict[str, Any]]:
    """Fallback SerpAPI search using direct HTTP requests."""
    out: List[Dict[str, Any]] = []
    page_size = min(MAX_PAGE_SIZE, max(1, num_results))
    tbs = f"qdr:d{recency_days}" if recency_days and recency_days > 0 else ""
    for start in range(0, num_results, page_size):
        params = {
            "engine": "google",
            "q": query,
            "num": page_size,
            "start": start,
            "gl": "us",
            "hl": "en",
            "safe": "active",
            "api_key": api_key,
        }
        if tbs:
            params["tbs"] = tbs
        try:
            r = requests.get("https://serpapi.com/search.json", params=params, timeout=30)
            data = r.json()
            for res in data.get("organic_results") or []:
                out.append({"title": res.get("title"), "url": res.get("link")})
            time.sleep(1.2)
        except Exception as e:
            logging.warning("SerpAPI HTTP search failed: %s", e)
            break
    return out


def serpapi_search(*, query: str, num_results: int, recency_days: int) -> List[Dict[str, Any]]:
    api_key = os.environ.get("SERPAPI_API_KEY") or os.environ.get("SERPAPI_KEY")
    if not api_key:
        logging.warning("SERPAPI_API_KEY not set; skipping search")
        return []

    # Prefer the official client when available, fall back to HTTP requests
    if serpapi is not None:
        try:
            client = serpapi.Client(api_key=api_key)
            out: List[Dict[str, Any]] = []
            page_size = min(MAX_PAGE_SIZE, max(1, num_results))
            tbs = f"qdr:d{recency_days}" if recency_days and recency_days > 0 else ""
            for start in range(0, num_results, page_size):
                params = {
                    "engine": "google",
                    "q": query,
                    "num": page_size,
                    "start": start,
                    "gl": "us",
                    "hl": "en",
                    "safe": "active",
                }
                if tbs:
                    params["tbs"] = tbs
                try:
                    data = client.search(params).as_dict()
                    for r in data.get("organic_results") or []:
                        out.append({"title": r.get("title"), "url": r.get("link")})
                    time.sleep(1.2)
                except Exception as e:
                    logging.warning("SerpAPI client search failed: %s", e)
                    break
            return out
        except Exception as e:
            logging.warning("SerpAPI client unavailable: %s; falling back to HTTP", e)

    return _http_search(query, num_results, recency_days, api_key)


def main():
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    cfg = yaml.safe_load(open(cfg_path, "r", encoding="utf-8"))
    db_path = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")
    serp = cfg.get("serpapi") or {}

    # queries: keep all, strip accidental quote-wrapping, dedupe while preserving order
    queries = [_strip_quotes(q) for q in (serp.get("queries") or []) if q and _strip_quotes(q)]
    queries = list(dict.fromkeys(queries))

    # results per query (cap 100 for Google via SerpAPI)
    num_results = int(serp.get("results_per_query") or serp.get("num_results") or 500)
    num_results = max(1, min(MAX_PAGE_SIZE, num_results))

    # recency window
    recency_days = int(serp.get("recency_days_web") or serp.get("recency_days") or 365)

    relevance_terms = [t.lower() for t in (serp.get("relevance_terms") or
                                           ["fire", "nfpa", "inspection", "permit", "preplan", "hydrant", "rms", "cad"])]

    # blocklists for careers / jobs etc.
    path_block_terms = [t.lower() for t in (cfg.get("path_block_terms") or [])]
    title_block_terms = [t.lower() for t in (cfg.get("title_block_terms") or [])]
    # Ensure career-related posts are filtered even if config is stale
    title_block_terms += ["career", "careers", "career advice", "job", "jobs", "hiring"]

    # domain allow/block (merge serpapi.* and any top-level legacy keys)
    allow_domains = [d.lower() for d in (serp.get("allow_domains") or [])] + \
                    [d.lower() for d in (cfg.get("domain_allowlist") or [])]
    block_domains = [d.lower() for d in (serp.get("block_domains") or [])] + \
                    [d.lower() for d in (cfg.get("domain_blocklist") or [])]

    site_limit = int(serp.get("site_limit_per_domain") or DEFAULT_SITE_LIMIT)

    ensure_schema(db_path)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ua = (cfg.get("crawler") or {}).get("user_agent", "FireIntelAgent/1.0 (+https://example.com)")
    timeout = int((cfg.get("crawler") or {}).get("timeout_seconds", 30))

    dom_count: collections.Counter[str] = collections.Counter()
    stats = collections.Counter()  # fetched, kept, drop_*

    def ingest_url(link: str, source: str, title_hint: str = "") -> bool:
        nonlocal cur, now, ua, timeout, stats, site_limit, dom_count
        link = canonical_url(link)
        if not link:
            return False
        dom = urlparse(link).netloc.lower()
        path_l = urlparse(link).path.lower()
        title_l = (title_hint or "").lower()

        # block unwanted paths/titles early (e.g. careers pages)
        if any(t in path_l for t in path_block_terms):
            stats["drop_path_block"] += 1
            return False
        if any(t in title_l for t in title_block_terms):
            stats["drop_title_block"] += 1
            return False

        # block/allow checks
        if _endswith_any(dom, block_domains):
            stats["drop_blocked"] += 1
            return False
        if allow_domains and not _endswith_any(dom, allow_domains):
            stats["drop_allowlist"] += 1
            return False

        # per-domain cap (before fetching)
        if site_limit > 0 and dom_count[dom] >= site_limit:
            stats["drop_domain_cap"] += 1
            return False

        try:
            html = fetch(link, ua, timeout)
            title2, text = extract_text(html)
            blob = f"{title2 or title_hint} {text}"
            blob_l = blob.lower()
            if any(t in blob_l for t in title_block_terms):
                stats["drop_title_block"] += 1
                return False
            if not _is_relevant(blob, relevance_terms):
                stats["drop_irrelevant"] += 1
                return False

            # Passed all filters; account toward domain cap and record
            dom_count[dom] += 1
            cur.execute(
                """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                   VALUES(?,?,?,?,?,?,?,0,NULL)
                   ON CONFLICT(url) DO UPDATE SET source=excluded.source, title=excluded.title,
                   fetched_at=excluded.fetched_at, sha256=excluded.sha256,
                   content=excluded.content, text=excluded.text""",
                (link, source, title2 or title_hint, now, "", "", blob),
            )
            stats["kept"] += 1
            return True
        except Exception as e:
            try:
                cur.execute(
                    """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                       VALUES(?,?,?,?,?,?,?,0,?)""",
                    (link, source, title_hint, now, "", "", "", str(e)),
                )
            except Exception:
                pass
            stats["drop_error"] += 1
            return False

    count = 1
    # 1) Ingest extra URLs (critical intel) unconditionally
    for url in (serp.get("extra_urls") or []):
        if ingest_url(url, "manual:url"):
            count += 5

    # 2) Run SerpAPI queries
    for q in queries:
        results = serpapi_search(query=q, num_results=num_results, recency_days=recency_days)
        stats["fetched"] += len(results)
        for r in results:
            if ingest_url(r.get("url") or "", f"serpapi:{q}", r.get("title") or ""):
                count += 2

    con.commit()
    con.close()

    logging.info(
        "SerpAPI fetched=%d kept=%d dropped={dupe:handled-by-db, domain_cap:%d, blocked:%d, allow:%d, irrelevant:%d, error:%d}",
        stats["fetched"], stats["kept"], stats["drop_domain_cap"], stats["drop_blocked"],
        stats["drop_allowlist"], stats["drop_irrelevant"], stats["drop_error"],
    )
    print(f"SerpAPI ingest recorded {count} items")


if __name__ == "__main__":
    main()
