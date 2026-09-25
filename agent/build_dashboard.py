from __future__ import annotations

"""Generate static dashboard support files from config.yaml.

Runs as part of the daily CI pipeline to:
  1. Ensure index.html exists.
  2. Write version.txt with the build timestamp.
  3. Write domain.json so the frontend can read domain name/personas/categories
     without hardcoding them — enabling any field of work, not just fire safety.
  4. Write sources_config.json listing every configured source so the Sources
     tab can display what is being monitored.
"""

import json
import os
import time
from pathlib import Path

import yaml

DASHBOARD_DIR        = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
CONFIG_FILE          = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
EXTRA_SOURCES_FILE   = Path("data/extra_sources.yaml")
SOURCES_METADATA_FILE = Path("data/sources_metadata.json")
PENDING_FILE         = DASHBOARD_DIR / "pending_suggestions.json"

# Intel JSON files produced by the new backend modules. Registered here so the
# dashboard build can report which feeds are present and tally fresh-item counts.
INTEL_FILES = [
    "fema_intel.json",
    "sec_intel.json",
    "patent_intel.json",
    "wildfire_intel.json",
    "gdelt_intel.json",
    "grants_intel.json",
    "app_store_intel.json",
    "ecfr_intel.json",
    "nfirs_intel.json",
    "agentic_ai_intel.json",
]


def _load_config() -> dict:
    if CONFIG_FILE.exists():
        return yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    return {}


def _build_domain_json(cfg: dict) -> dict:
    dom = cfg.get("domain") or {}
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "name": dom.get("name", "Market Intelligence"),
        "short_name": dom.get("short_name", "Intel"),
        "description": dom.get("description", ""),
        "icon": dom.get("icon", "📊"),
        "personas": dom.get("personas", [
            {"key": "default", "label": "Default"}
        ]),
        "categories": dom.get("categories", []),
    }


def _load_sources_metadata() -> dict:
    """Load optional metadata overlay (personas, topics, region, reliability) keyed by URL."""
    if not SOURCES_METADATA_FILE.exists():
        return {}
    try:
        import json
        data = json.loads(SOURCES_METADATA_FILE.read_text(encoding="utf-8"))
        return data.get("sources") or {}
    except Exception:
        return {}


def _build_sources_config(cfg: dict) -> dict:
    metadata = _load_sources_metadata()
    sources = []
    src_cfg = cfg.get("sources") or {}

    def _apply_meta(entry: dict) -> dict:
        url = entry.get("url", "").rstrip("/")
        m = metadata.get(url) or metadata.get(url + "/") or {}
        if m:
            entry["personas"]    = m.get("personas", [])
            entry["topics"]      = m.get("topics", [])
            entry["region"]      = m.get("region", "")
            entry["reliability"] = m.get("reliability", 0)
            if m.get("label"):
                entry.setdefault("label", m["label"])
        return entry

    section_labels = {
        "industry_sites": "Industry Sites",
        "magazines_rss": "Magazines & RSS",
        "blogs_and_chief_voices": "Blogs & Chief Voices",
    }
    for section_key, section_label in section_labels.items():
        for s in src_cfg.get(section_key, []):
            sources.append(_apply_meta({
                "type": s.get("type", "page"),
                "url": s.get("url", ""),
                "section": section_label,
                "label": s.get("label", ""),
            }))

    # Extra sources file
    extra = []
    if EXTRA_SOURCES_FILE.exists():
        try:
            raw = yaml.safe_load(EXTRA_SOURCES_FILE.read_text(encoding="utf-8")) or []
            if isinstance(raw, list):
                extra = raw
        except Exception:
            pass
    for s in extra:
        if isinstance(s, dict):
            entry = {
                "type": s.get("type", "page"),
                "url": s.get("url", ""),
                "section": "Custom Sources",
                "label": s.get("label", ""),
                # Extra sources may already carry inline metadata
                "personas":    s.get("personas", []),
                "topics":      s.get("topics", []),
                "region":      s.get("region", ""),
                "reliability": s.get("reliability", 0),
            }
            sources.append(_apply_meta(entry))

    # Reddit subreddits
    reddit_cfg = cfg.get("reddit") or {}
    for sub in reddit_cfg.get("subreddits", []):
        sources.append({
            "type": "reddit",
            "url": f"https://reddit.com/r/{sub}",
            "section": "Reddit",
            "label": f"r/{sub}",
        })

    # Web search queries
    web_queries = (cfg.get("web_search") or cfg.get("serpapi") or {}).get("queries", [])
    if web_queries:
        sources.append({
            "type": "web_search",
            "url": "",
            "section": "Web Search",
            "label": f"{len(web_queries)} search queries",
            "queries": web_queries,
        })

    # Count pending suggestions for UI badge
    pending_count = 0
    if PENDING_FILE.exists():
        try:
            import json
            pdata = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
            pending_count = len(pdata.get("items") or [])
        except Exception:
            pass

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": sources,
        "pending_suggestions_count": pending_count,
    }


def _build_intel_status() -> dict:
    """Inspect each intel JSON file, reporting presence, errors, and item counts.

    `pending_count` is the total number of intel items across ALL sources, not
    just VOC cards — it drives the "new" badge on the Field/Market Intel tabs.
    """
    # Per file, the list/array keys whose lengths we sum into the item count.
    count_keys = {
        "fema_intel.json": ["disaster_declarations", "active_grants", "pa_projects"],
        "sec_intel.json": ["companies"],
        "patent_intel.json": ["patents"],
        "wildfire_intel.json": ["red_flag_warnings", "active_fires"],
        "gdelt_intel.json": ["articles"],
        "grants_intel.json": ["opportunities", "awards"],
        "app_store_intel.json": ["apps"],
        "ecfr_intel.json": ["titles"],
        # NFIRS is a static multi-year reference dataset (no flat item list); we
        # register it for presence/error reporting but contribute 0 to the
        # cross-source pending badge so it doesn't inflate "new signal" counts.
        "nfirs_intel.json": [],
        "agentic_ai_intel.json": [
            "trending_models", "recent_papers", "trending_repos",
            "news_articles", "company_releases",
        ],
    }
    feeds = []
    pending_count = 0
    for fname in INTEL_FILES:
        path = DASHBOARD_DIR / fname
        entry = {"file": fname, "present": path.exists(), "error": None, "count": 0}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("error"):
                    entry["error"] = str(data["error"])
                count = 0
                for key in count_keys.get(fname, []):
                    val = data.get(key) if isinstance(data, dict) else None
                    if isinstance(val, list):
                        count += len(val)
                entry["count"] = count
                pending_count += count
                entry["generated_at"] = (
                    data.get("generated_at") if isinstance(data, dict) else None
                )
            except Exception as e:
                entry["error"] = f"unreadable: {e}"
        feeds.append(entry)

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "feeds": feeds,
        "pending_count": pending_count,
    }


def main() -> None:
    DASHBOARD_DIR.mkdir(parents=True, exist_ok=True)

    # Ensure index.html exists (the real one is committed; this is a fallback)
    index_file = DASHBOARD_DIR / "index.html"
    if not index_file.exists():
        index_file.write_text(
            "<!doctype html><title>Intel Dashboard</title>",
            encoding="utf-8",
        )

    # Build timestamp
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (DASHBOARD_DIR / "version.txt").write_text(ts, encoding="utf-8")

    cfg = _load_config()

    # domain.json — loaded by frontend to set title, personas, categories
    domain_data = _build_domain_json(cfg)
    (DASHBOARD_DIR / "domain.json").write_text(
        json.dumps(domain_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote dashboard/domain.json ({domain_data['name']})")

    # sources_config.json — loaded by Sources tab
    sources_data = _build_sources_config(cfg)
    (DASHBOARD_DIR / "sources_config.json").write_text(
        json.dumps(sources_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote dashboard/sources_config.json ({len(sources_data['sources'])} sources)")

    # intel_status.json — presence/error/item-count for each intel feed + a
    # cross-source pending_count badge for the Field/Market Intel tabs.
    intel_status = _build_intel_status()
    (DASHBOARD_DIR / "intel_status.json").write_text(
        json.dumps(intel_status, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    present = sum(1 for f in intel_status["feeds"] if f["present"])
    print(
        f"Wrote dashboard/intel_status.json "
        f"({present}/{len(INTEL_FILES)} feeds, pending_count={intel_status['pending_count']})"
    )


if __name__ == "__main__":
    main()
