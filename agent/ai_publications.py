from __future__ import annotations

import json
import os
import pathlib

import feedparser

# Fire industry RSS feeds (replacing generic arxiv AI feeds)
FEEDS = [
    ("NFPA News",        "https://www.nfpa.org/News-and-Research/Publications-and-media/NFPA-Journal/rss"),
    ("Fire Engineering", "https://www.fireengineering.com/rss"),
    ("FireRescue1",      "https://www.firerescue1.com/rss.xml"),
    ("IAFC",             "https://www.iafc.org/rss"),
    ("Firehouse",        "https://www.firehouse.com/rss/all"),
]


def main():
    items = []
    for source_name, url in FEEDS:
        try:
            feed = feedparser.parse(url)
            for e in feed.entries[:5]:
                items.append(
                    {
                        "title":   getattr(e, "title",   ""),
                        "url":     getattr(e, "link",    ""),
                        "summary": getattr(e, "summary", ""),
                        "date":    getattr(e, "published", ""),
                        "source":  source_name,
                    }
                )
        except Exception as exc:
            print(f"Warning: could not fetch {source_name}: {exc}")

    root = pathlib.Path(__file__).resolve().parents[1]
    dash = pathlib.Path(os.environ.get("DASHBOARD_PATH", str(root / "dashboard")))
    dash.mkdir(exist_ok=True)
    out = dash / "cutting_edge.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=2)
    print(f"Wrote {out.relative_to(root)} ({len(items)} items)")


if __name__ == "__main__":
    main()
