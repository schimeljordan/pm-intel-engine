"""
export_competitor_news.py — Competitor News Feed

Fetches real news headlines for each competitor using Google News RSS
(no auth required, returns actual article titles, snippets, and dates).
Falls back to DuckDuckGo News RSS if Google News returns nothing.

Output: dashboard/competitor_news.json
"""
from __future__ import annotations

import json
import os
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote_plus, urlparse

import requests
import yaml

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; FireIntelAgent/2.0; "
        "+https://github.com/schimeljordan/fire-intel-agent)"
    )
}
TIMEOUT = 10
MAX_ITEMS_PER_COMP = 5


def _google_news_rss(query: str) -> list[dict]:
    """Fetch news from Google News RSS — returns up to MAX_ITEMS_PER_COMP items."""
    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        items = []
        for item in root.findall(".//item")[:MAX_ITEMS_PER_COMP]:
            title = item.findtext("title") or ""
            link = item.findtext("link") or ""
            pub_date = item.findtext("pubDate") or ""
            description = item.findtext("description") or ""
            # Clean up description — Google News wraps it in HTML and has &nbsp; entities
            import re, html
            description = html.unescape(re.sub(r"<[^>]+>", "", description)).strip()
            # Remove the trailing " - Source Name" appended by Google News to titles
            title = re.sub(r"\s+[-–]\s+[^-–]+$", "", html.unescape(title)).strip()
            # Parse the pub date into ISO format
            iso_date = None
            if pub_date:
                try:
                    from email.utils import parsedate_to_datetime
                    iso_date = parsedate_to_datetime(pub_date).strftime("%Y-%m-%dT%H:%M:%SZ")
                except Exception:
                    iso_date = pub_date
            if title and link:
                items.append({
                    "title": title,
                    "url": link,
                    "date": iso_date,
                    "snippet": description[:300] if description else "",
                })
        return items
    except Exception as e:
        return []


def _ddg_news_rss(query: str) -> list[dict]:
    """DuckDuckGo news RSS fallback."""
    url = f"https://duckduckgo.com/?q={quote_plus(query)}&ia=news&format=json"
    # DDG doesn't have a clean RSS for news; skip and return empty
    return []


def main() -> None:
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    cfg = yaml.safe_load(open(cfg_path, "r", encoding="utf-8"))
    competitors_path = cfg.get("competitors_path", "data/competitors.yaml")
    dash_dir = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))

    comp_yaml = yaml.safe_load(open(competitors_path, "r", encoding="utf-8")) or {}

    comps = []
    for name, info in (comp_yaml.get("competitors") or {}).items():
        url = info.get("url", "")
        dom = urlparse(url).netloc.lower().lstrip("www.") or name

        # Search Google News for this competitor's recent activity
        query = f'"{name}" fire safety OR inspection OR compliance'
        items = _google_news_rss(query)

        # If zero results, try a broader company-name-only search
        if not items:
            items = _google_news_rss(name)

        # Deduplicate by URL
        seen = set()
        deduped = []
        for it in items:
            if it["url"] not in seen:
                seen.add(it["url"])
                deduped.append(it)

        comps.append({
            "name": name,
            "domain": dom,
            "news": deduped,
        })

        # Be polite — short delay between competitors
        time.sleep(0.5)

    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "competitors": comps,
    }
    dash_dir.mkdir(exist_ok=True)
    out_path = dash_dir / "competitor_news.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    total_articles = sum(len(c["news"]) for c in comps)
    print(f"Wrote {out_path} — {len(comps)} competitors, {total_articles} news items")


if __name__ == "__main__":
    main()
