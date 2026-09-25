"""agent/web_search.py — Free multi-engine web search replacing SerpAPI.

Engines used (all free, no API key required):
  1. Google News RSS  — excellent news/industry coverage
  2. Bing News RSS    — broader coverage, recent articles
  3. DuckDuckGo       — general web search via duckduckgo-search library

Applies the same filtering pipeline as the old serpapi_search.py:
  domain blocklist → allowlist → per-domain cap → fetch → title block →
  relevance check → insert into pages table.

Config section in config.yaml:
  web_search:
    queries: [...]
    results_per_query: 100      # per engine
    recency_days: 365           # used as hint where engines support it
    engines: [google_news_rss, bing_news_rss, duckduckgo]
    site_limit_per_domain: 50
    block_domains: [...]
"""
from __future__ import annotations

import collections
import hashlib
import logging
import os
import sqlite3
import time
from typing import Dict, List
from urllib.parse import quote, urlparse

import feedparser  # type: ignore
import requests
import yaml

from agent.common import canonical_url, fetch, extract_text
from agent.db_migrations import ensure_schema

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="web_search %(levelname)s: %(message)s",
)

DEFAULT_SITE_LIMIT = 50
DEFAULT_RESULTS_PER_QUERY = 50
GNEWS_REDIRECT_TIMEOUT = 8


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _endswith_any(host: str, suffixes: List[str]) -> bool:
    host = (host or "").lower()
    for s in (suffixes or []):
        s = (s or "").lower().strip()
        if not s:
            continue
        if host == s or host.endswith("." + s):
            return True
    return False


def _is_relevant(text: str, terms: List[str]) -> bool:
    lt = (text or "").lower()
    return any(t in lt for t in terms)


def _strip_quotes(s: str) -> str:
    s = (s or "").strip()
    if len(s) > 1 and s[0] in ('"', "'") and s[-1] == s[0]:
        return s[1:-1].strip()
    return s


def _resolve_gnews_url(redirect_url: str) -> str:
    """Follow Google News redirect to get the real article URL."""
    try:
        r = requests.head(redirect_url, allow_redirects=True, timeout=GNEWS_REDIRECT_TIMEOUT)
        return r.url or redirect_url
    except Exception:
        return redirect_url


def _resolve_bing_url(redirect_url: str) -> str:
    """Follow Bing News redirect to get the real article URL."""
    if "bing.com" not in redirect_url:
        return redirect_url
    try:
        r = requests.head(redirect_url, allow_redirects=True, timeout=GNEWS_REDIRECT_TIMEOUT)
        return r.url or redirect_url
    except Exception:
        return redirect_url


# ---------------------------------------------------------------------------
# Search engines
# ---------------------------------------------------------------------------

def _google_news_rss(query: str, max_results: int) -> List[Dict]:
    """Search via Google News RSS feed — completely free, no auth."""
    out: List[Dict] = []
    url = (
        f"https://news.google.com/rss/search?q={quote(query)}"
        f"&hl=en-US&gl=US&ceid=US:en"
    )
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[:max_results]:
            raw_url = getattr(entry, "link", "") or ""
            if not raw_url:
                continue
            # GNews links are redirect wrappers — resolve to real URL
            real_url = _resolve_gnews_url(raw_url)
            published = getattr(entry, "published", "") or ""
            out.append({"title": getattr(entry, "title", ""), "url": real_url, "date": published})
    except Exception as e:
        logging.warning("Google News RSS failed for '%s': %s", query[:60], e)
    return out


def _bing_news_rss(query: str, max_results: int) -> List[Dict]:
    """Search via Bing News RSS feed — completely free, no auth."""
    out: List[Dict] = []
    url = f"https://www.bing.com/news/search?q={quote(query)}&format=RSS"
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[:max_results]:
            link = getattr(entry, "link", "") or ""
            if not link:
                continue
            link = _resolve_bing_url(link)
            published = getattr(entry, "published", "") or ""
            out.append({"title": getattr(entry, "title", ""), "url": link, "date": published})
    except Exception as e:
        logging.warning("Bing News RSS failed for '%s': %s", query[:60], e)
    return out


def _duckduckgo_search(query: str, max_results: int) -> List[Dict]:
    """Search via DuckDuckGo — requires duckduckgo-search library."""
    out: List[Dict] = []
    try:
        try:
            from ddgs import DDGS  # type: ignore  # new package name (ddgs>=9.0)
        except ImportError:
            from duckduckgo_search import DDGS  # type: ignore  # legacy fallback
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results):
                url = r.get("href") or r.get("url") or ""
                if url:
                    out.append({"title": r.get("title", ""), "url": url, "date": ""})
    except ImportError:
        logging.warning("duckduckgo-search not installed; skipping DDG engine. Run: pip install duckduckgo-search")
    except Exception as e:
        logging.warning("DuckDuckGo search failed for '%s': %s", query[:60], e)
    return out


def _search_engine(engine: str, query: str, max_results: int) -> List[Dict]:
    """Dispatch to the correct search engine."""
    if engine == "google_news_rss":
        return _google_news_rss(query, max_results)
    if engine == "bing_news_rss":
        return _bing_news_rss(query, max_results)
    if engine == "duckduckgo":
        return _duckduckgo_search(query, max_results)
    logging.warning("Unknown engine '%s' — skipping", engine)
    return []


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

def _make_ingest_fn(cur, now, ua, timeout, path_block_terms, title_block_terms,
                    allow_domains, block_domains, relevance_terms, site_limit,
                    dom_count, stats):
    """Return a closure that filters + inserts a single URL."""

    def ingest_url(link: str, source: str, title_hint: str = "") -> bool:
        link = canonical_url(link)
        if not link:
            return False

        parsed = urlparse(link)
        dom = parsed.netloc.lower()
        path_l = parsed.path.lower()
        title_l = (title_hint or "").lower()

        # path / title early rejection
        if any(t in path_l for t in path_block_terms):
            stats["drop_path_block"] += 1
            return False
        if any(t in title_l for t in title_block_terms):
            stats["drop_title_block"] += 1
            return False

        # domain block / allow
        if _endswith_any(dom, block_domains):
            stats["drop_blocked"] += 1
            return False
        if allow_domains and not _endswith_any(dom, allow_domains):
            stats["drop_allowlist"] += 1
            return False

        # per-domain cap (before fetching to save bandwidth)
        if site_limit > 0 and dom_count[dom] >= site_limit:
            stats["drop_domain_cap"] += 1
            return False

        try:
            html = fetch(link, ua, timeout)
            title2, text = extract_text(html)
            blob = f"{title2 or title_hint} {text}"
            blob_l = blob.lower()

            # post-fetch title/block check
            if any(t in blob_l for t in title_block_terms):
                stats["drop_title_block"] += 1
                return False
            if not _is_relevant(blob, relevance_terms):
                stats["drop_irrelevant"] += 1
                return False

            dom_count[dom] += 1
            blob_hash = hashlib.sha256(blob.encode("utf-8", "ignore")).hexdigest()
            cur.execute(
                """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                   VALUES(?,?,?,?,?,?,?,0,NULL)
                   ON CONFLICT(url) DO UPDATE SET
                     source=excluded.source, title=excluded.title,
                     fetched_at=excluded.fetched_at, sha256=excluded.sha256,
                     content=excluded.content, text=excluded.text,
                     processed=CASE WHEN excluded.sha256 != pages.sha256 THEN 0 ELSE pages.processed END,
                     error=NULL""",
                (link, source, title2 or title_hint, now, blob_hash, "", blob),
            )
            stats["kept"] += 1
            return True

        except Exception as e:
            try:
                cur.execute(
                    """INSERT INTO pages(url, source, title, fetched_at, sha256, content, text, processed, error)
                       VALUES(?,?,?,?,?,?,?,0,?)
                       ON CONFLICT(url) DO NOTHING""",
                    (link, source, title_hint, now, "", "", "", str(e)[:500]),
                )
            except Exception:
                pass
            stats["drop_error"] += 1
            return False

    return ingest_url


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run() -> None:
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    cfg = yaml.safe_load(open(cfg_path, "r", encoding="utf-8")) or {}
    db_path = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")

    # Support both 'web_search:' (new) and 'serpapi:' (legacy) config keys
    ws_cfg = cfg.get("web_search") or cfg.get("serpapi") or {}

    queries = [_strip_quotes(q) for q in (ws_cfg.get("queries") or []) if q and _strip_quotes(q)]
    queries = list(dict.fromkeys(queries))  # dedupe, preserve order

    if not queries:
        logging.info("No web_search queries configured; skipping.")
        return

    max_results   = int(ws_cfg.get("results_per_query") or ws_cfg.get("num_results") or DEFAULT_RESULTS_PER_QUERY)
    site_limit    = int(ws_cfg.get("site_limit_per_domain") or DEFAULT_SITE_LIMIT)
    engines       = ws_cfg.get("engines") or ["google_news_rss", "bing_news_rss", "duckduckgo"]
    relevance_terms = [t.lower() for t in (ws_cfg.get("relevance_terms") or
                       cfg.get("fire_relevance_keywords") or
                       ["fire", "nfpa", "inspection", "permit", "preplan", "hydrant", "rms", "cad"])]

    path_block_terms  = [t.lower() for t in (cfg.get("path_block_terms") or [])]
    title_block_terms = [t.lower() for t in (cfg.get("title_block_terms") or [])]
    title_block_terms += ["career", "careers", "job", "jobs", "hiring"]  # always block

    # Web search is intentionally open to any domain — domain_allowlist is only used by the
    # RSS scraper. Only honor allow_domains if explicitly set under web_search: in config.
    allow_domains = [d.lower() for d in (ws_cfg.get("allow_domains") or [])]
    block_domains = [d.lower() for d in (ws_cfg.get("block_domains") or cfg.get("domain_blocklist") or [])]
    # Hard-code social media blocklist
    block_domains += ["pinterest.com", "facebook.com", "linkedin.com", "youtube.com",
                      "x.com", "twitter.com", "instagram.com", "tiktok.com"]
    block_domains = list(dict.fromkeys(block_domains))

    crawler = cfg.get("crawler") or {}
    ua      = crawler.get("user_agent", "IntelAgent/1.0 (+github actions)")
    timeout = int(crawler.get("timeout_seconds", 30))

    ensure_schema(db_path)
    con = sqlite3.connect(db_path, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=30000")
    cur = con.cursor()
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    dom_count: collections.Counter = collections.Counter()
    stats: collections.Counter = collections.Counter()
    by_engine: Dict[str, int] = {e: 0 for e in engines}

    ingest_url = _make_ingest_fn(
        cur, now, ua, timeout,
        path_block_terms, title_block_terms,
        allow_domains, block_domains,
        relevance_terms, site_limit,
        dom_count, stats,
    )

    # Track seen URLs across all engines to avoid redundant fetches
    seen_urls: set = set()

    logging.info("Starting web search: %d queries × %d engines", len(queries), len(engines))

    for qi, query in enumerate(queries, 1):
        logging.info("[%d/%d] Query: %s", qi, len(queries), query[:80])

        for engine in engines:
            results = _search_engine(engine, query, max_results)
            stats["fetched"] += len(results)

            for r in results:
                url = canonical_url(r.get("url") or "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                source = f"web_search:{engine}:{query[:60]}"
                kept = ingest_url(url, source, r.get("title") or "")
                if kept:
                    by_engine[engine] = by_engine.get(engine, 0) + 1

            # Brief delay between engines (reduced for CI performance)
            time.sleep(0.15)

        # Brief pause between query groups
        time.sleep(0.1)

    con.commit()
    con.close()

    logging.info(
        "Web search done. fetched=%d kept=%d | by_engine=%s | dropped: domain_cap=%d blocked=%d "
        "allowlist=%d irrelevant=%d error=%d title=%d path=%d",
        stats["fetched"], stats["kept"],
        {e: by_engine.get(e, 0) for e in engines},
        stats["drop_domain_cap"], stats["drop_blocked"], stats["drop_allowlist"],
        stats["drop_irrelevant"], stats["drop_error"],
        stats["drop_title_block"], stats["drop_path_block"],
    )
    print(
        f"web_search: kept={stats['kept']} / fetched={stats['fetched']} "
        f"across {len(engines)} engines × {len(queries)} queries"
    )


def main():
    run()


if __name__ == "__main__":
    main()
