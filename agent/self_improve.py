"""agent/self_improve.py — Fully autonomous self-improvement agent.

Runs as the final step of the daily pipeline. Analyzes published dashboard
data, discovers new sources and competitors via LLM, validates them, then
auto-commits changes back to the repo (using GITHUB_TOKEN from CI).

Pipeline:
  Phase 1 — Analyze   : Read cards/analytics/history, find signal patterns
  Phase 2 — Discover  : LLM call → suggested sources, queries, competitors
  Phase 3 — Validate  : Test every suggestion (live HTTP/RSS check)
  Phase 4 — Update    : Write validated changes to config files
  Phase 5 — Charts    : Generate voc_trends.json, source_quality.json,
                        competitor_mentions.json for optional dashboard charts
  Phase 6 — Commit    : git commit + push via GITHUB_TOKEN
  Phase 7 — Log       : Write dashboard/self_improve_log.json

Config section (config.yaml):
  self_improve:
    enabled: true
    max_new_sources_per_run: 5
    max_new_queries_per_run: 3
    max_new_competitors_per_run: 3
    min_confidence_to_commit: 60
    dry_run: false          # true → generate log but don't write config files
"""
from __future__ import annotations

import collections
import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import feedparser  # type: ignore
import requests
import yaml

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="self_improve %(levelname)s: %(message)s",
)

DASHBOARD_DIR    = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
DATA_DIR         = Path("data")
CONFIG_FILE      = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
EXTRA_SOURCES    = DATA_DIR / "extra_sources.yaml"
COMPETITORS_F    = DATA_DIR / "competitors.yaml"
LOG_FILE         = DASHBOARD_DIR / "self_improve_log.json"
PENDING_FILE     = DASHBOARD_DIR / "pending_suggestions.json"
MAX_LOG_RUNS     = 30
MAX_PENDING_KEPT = 50  # max pending items before oldest are dropped


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except Exception as e:
        logging.warning("Could not load %s: %s", path, e)
        return None


def _load_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else None
    except Exception as e:
        logging.warning("Could not load %s: %s", path, e)
        return None


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().replace("www.", "")
    except Exception:
        return ""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# Phase 1: Analyze existing data
# ---------------------------------------------------------------------------

def _analyze(cards_data, analytics_data, history_data, cfg, extra_sources_raw) -> Dict:
    cards = (cards_data or {}).get("cards") or []
    by_domain: Dict[str, List[float]] = collections.defaultdict(list)
    for c in cards:
        d = _domain(c.get("url", ""))
        if d:
            by_domain[d].append(float(c.get("opportunity_score", 50)))

    high_signal_domains = sorted(
        [(d, sum(sc) / len(sc), len(sc)) for d, sc in by_domain.items() if len(sc) >= 2],
        key=lambda x: -x[1],
    )[:20]

    # Collect existing monitored domains
    existing_urls: set = set()
    ws_cfg = cfg.get("web_search") or cfg.get("serpapi") or {}
    sources_cfg = cfg.get("sources") or {}
    for section in ("industry_sites", "magazines_rss", "blogs_and_chief_voices"):
        for s in sources_cfg.get(section, []):
            existing_urls.add(_domain(s.get("url", "")))
    for s in (extra_sources_raw if isinstance(extra_sources_raw, list) else []):
        existing_urls.add(_domain(s.get("url", "")))

    # Domains generating high-quality signals NOT already monitored as sources
    unmonitored_high_signal = [
        {"domain": d, "avg_score": round(avg, 1), "card_count": cnt}
        for d, avg, cnt in high_signal_domains
        if d and d not in existing_urls
    ][:10]

    # Emerging categories: growing in last 3 history runs
    history = history_data if isinstance(history_data, list) else []
    emerging_categories: List[str] = []
    if len(history) >= 3:
        recent = history[-3:]
        for cat in set(k for run in recent for k in run.get("by_category", {})):
            counts = [run.get("by_category", {}).get(cat, 0) for run in recent]
            if counts[-1] > counts[0] * 1.2 and counts[-1] > 5:
                emerging_categories.append(cat)

    # Stale categories: zero signal for last 3 runs
    stale_categories: List[str] = []
    if len(history) >= 3:
        recent = history[-3:]
        all_cats = set(k for run in recent for k in run.get("by_category", {}))
        for cat in all_cats:
            if all(run.get("by_category", {}).get(cat, 0) == 0 for run in recent):
                stale_categories.append(cat)

    # Extract frequent terms from card titles that look like product/company names
    # (capitalised words not in common stop-words)
    STOPWORDS = {
        "the","and","for","with","from","that","this","into","your","have","will",
        "data","fire","new","how","what","why","when","where","which","their",
        "more","also","using","used","been","are","was","were","has","had",
        "not","but","our","can","may","its","via","use","per","all","an","a",
    }
    word_counter: collections.Counter = collections.Counter()
    for c in cards[:200]:
        for word in re.findall(r"\b[A-Z][A-Za-z]{2,}\b", c.get("title", "")):
            if word.lower() not in STOPWORDS:
                word_counter[word] += 1
    frequent_terms = [w for w, cnt in word_counter.most_common(30) if cnt >= 3]

    # Known competitor names
    comps_yaml = _load_yaml(COMPETITORS_F)
    known_competitors = set()
    if comps_yaml and isinstance(comps_yaml.get("competitors"), dict):
        known_competitors = set(comps_yaml["competitors"].keys())

    # Terms that look like companies not yet tracked
    unknown_terms = [t for t in frequent_terms if t not in known_competitors][:15]

    return {
        "unmonitored_high_signal": unmonitored_high_signal,
        "emerging_categories": emerging_categories[:8],
        "stale_categories": stale_categories[:5],
        "frequent_unknown_terms": unknown_terms,
        "total_cards": len(cards),
        "card_sample": [
            {"title": c.get("title", ""), "domain": _domain(c.get("url", "")),
             "category": c.get("voc_category", ""), "score": c.get("opportunity_score", 0)}
            for c in cards[:30]
        ],
    }


# ---------------------------------------------------------------------------
# Phase 2: LLM Discovery
# ---------------------------------------------------------------------------

def _llm_discover(analysis: Dict, domain_name: str, existing_queries: List[str],
                  client, model: str) -> Optional[Dict]:
    if not client:
        logging.info("No OpenAI client; skipping LLM discovery.")
        return None

    card_lines = "\n".join(
        f"- [{c['score']}] {c['title']} ({c['domain']}) — {c['category']}"
        for c in analysis["card_sample"]
    )
    unmonitored = "\n".join(
        f"  {r['domain']} (avg_score={r['avg_score']}, cards={r['card_count']})"
        for r in analysis["unmonitored_high_signal"][:8]
    ) or "  (none)"
    unknown_terms = ", ".join(analysis["frequent_unknown_terms"][:12]) or "(none)"
    emerging = ", ".join(analysis["emerging_categories"]) or "(none)"

    prompt = f"""You are a competitive intelligence analyst specializing in {domain_name}.

Top-scoring recent signals (title | domain | category | score):
{card_lines}

High-signal domains NOT yet monitored as sources:
{unmonitored}

Frequently mentioned terms that may be new companies/products:
{unknown_terms}

Emerging signal categories:
{emerging}

Task: Recommend intelligence sources and research improvements based on the data above.

Return ONLY strict JSON with this exact schema:
{{
  "new_rss_sources": [
    {{"url": "https://...", "type": "rss", "reason": "short reason"}}
  ],
  "new_web_pages": [
    {{"url": "https://...", "type": "page", "reason": "short reason"}}
  ],
  "new_search_queries": [
    "query string"
  ],
  "new_competitors": [
    {{"name": "Company Name", "url": "https://...", "why_mentioned": "seen N times in signals"}}
  ],
  "sources_to_remove": [],
  "reasoning": "1-2 sentence explanation",
  "confidence": 75
}}

Rules:
- new_rss_sources: max 5, must be real RSS/Atom feed URLs
- new_web_pages: max 5, must be real industry/news page URLs
- new_search_queries: max 3, concise Google-style queries
- new_competitors: max 3, only companies clearly referenced in the signals
- confidence: 0-100 integer
- Do NOT suggest domains already monitored
- Do NOT suggest social media, job boards, or generic news sites"""

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_completion_tokens=1200,
        )
        raw = resp.choices[0].message.content
        data = json.loads(raw)
        # Schema validation — coerce all list fields to lists, cap lengths
        def _to_list(v, max_len=10):
            if isinstance(v, list):
                return v[:max_len]
            if v is None:
                return []
            return []  # reject non-list values silently
        data["new_rss_sources"]     = _to_list(data.get("new_rss_sources"), 10)
        data["new_web_pages"]       = _to_list(data.get("new_web_pages"), 10)
        data["new_search_queries"]  = [str(q) for q in _to_list(data.get("new_search_queries"), 10)]
        data["new_competitors"]     = _to_list(data.get("new_competitors"), 10)
        data["confidence"]          = max(0, min(100, int(data.get("confidence") or 50)))
        data["reasoning"]           = str(data.get("reasoning") or "")[:500]
        return data
    except Exception as e:
        logging.warning("LLM discovery call failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Phase 3: Validate suggestions
# ---------------------------------------------------------------------------

_PRIVATE_PREFIXES = (
    "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
    "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
    "127.", "169.254.", "0.", "::1", "fc", "fd",
)

def _is_safe_url(url: str) -> bool:
    """Block non-https, localhost, private IPs, and metadata endpoints (SSRF guard)."""
    if not url or not url.startswith("https://"):
        return False
    host = urlparse(url).hostname or ""
    host_lower = host.lower()
    if host_lower in ("localhost", "metadata.google.internal"):
        return False
    # Block AWS/GCP/Azure metadata endpoints
    if host_lower in ("169.254.169.254", "100.100.100.200", "metadata.azure.com"):
        return False
    if any(host_lower.startswith(p) for p in _PRIVATE_PREFIXES):
        return False
    return True


def _validate_rss(url: str) -> bool:
    if not _is_safe_url(url):
        logging.info("  → rejected (SSRF guard: non-https or private address)")
        return False
    try:
        feed = feedparser.parse(url)
        return len(feed.entries) >= 2
    except Exception:
        return False


def _validate_url(url: str) -> bool:
    if not _is_safe_url(url):
        logging.info("  → rejected (SSRF guard: non-https or private address)")
        return False
    try:
        r = requests.head(url, allow_redirects=True, timeout=10,
                          headers={"User-Agent": "IntelAgent/1.0"})
        return r.status_code < 400
    except Exception:
        return False


def _validate_suggestions(suggestions: Dict, existing_source_urls: set) -> Dict:
    validated: Dict = {
        "new_rss_sources": [],
        "new_web_pages": [],
        "new_search_queries": suggestions.get("new_search_queries", [])[:3],
        "new_competitors": [],
        "confidence": suggestions.get("confidence", 50),
        "reasoning": suggestions.get("reasoning", ""),
    }

    for s in (suggestions.get("new_rss_sources") or []):
        url = (s.get("url") or "").strip()
        if not url or _domain(url) in existing_source_urls:
            continue
        logging.info("Validating RSS: %s", url)
        if _validate_rss(url):
            validated["new_rss_sources"].append(s)
            existing_source_urls.add(_domain(url))
        else:
            logging.info("  → rejected (RSS validation failed)")
        time.sleep(0.5)

    for s in (suggestions.get("new_web_pages") or []):
        url = (s.get("url") or "").strip()
        if not url or _domain(url) in existing_source_urls:
            continue
        logging.info("Validating page: %s", url)
        if _validate_url(url):
            validated["new_web_pages"].append(s)
            existing_source_urls.add(_domain(url))
        else:
            logging.info("  → rejected (HTTP validation failed)")
        time.sleep(0.3)

    for c in (suggestions.get("new_competitors") or []):
        url = (c.get("url") or "").strip()
        if not url:
            continue
        logging.info("Validating competitor: %s", c.get("name"))
        if _validate_url(url):
            validated["new_competitors"].append(c)
        time.sleep(0.3)

    return validated


# ---------------------------------------------------------------------------
# Phase 4: Update config files
# ---------------------------------------------------------------------------

def _current_extra_source_urls(extra_sources_raw) -> set:
    if not isinstance(extra_sources_raw, list):
        return set()
    return {(s.get("url") or "").strip().rstrip("/") for s in extra_sources_raw if isinstance(s, dict)}


def _update_extra_sources(validated: Dict, dry_run: bool) -> List[str]:
    added: List[str] = []
    if dry_run:
        for s in validated["new_rss_sources"] + validated["new_web_pages"]:
            added.append(s["url"])
            logging.info("[dry_run] Would add source: %s", s["url"])
        return added

    existing = []
    if EXTRA_SOURCES.exists():
        try:
            raw = yaml.safe_load(EXTRA_SOURCES.read_text(encoding="utf-8"))
            existing = raw if isinstance(raw, list) else []
        except Exception:
            existing = []

    existing_urls = {(s.get("url") or "").strip().rstrip("/") for s in existing if isinstance(s, dict)}

    new_entries = []
    for s in validated["new_rss_sources"]:
        url = s["url"].strip().rstrip("/")
        if url not in existing_urls:
            new_entries.append({"type": "rss", "url": url,
                                 "label": s.get("reason", "")[:60]})
            existing_urls.add(url)
            added.append(url)

    for s in validated["new_web_pages"]:
        url = s["url"].strip().rstrip("/")
        if url not in existing_urls:
            new_entries.append({"type": "page", "url": url,
                                 "label": s.get("reason", "")[:60]})
            existing_urls.add(url)
            added.append(url)

    if new_entries:
        updated = existing + new_entries
        EXTRA_SOURCES.write_text(
            yaml.dump(updated, allow_unicode=True, default_flow_style=False),
            encoding="utf-8",
        )
        logging.info("Added %d new sources to %s", len(new_entries), EXTRA_SOURCES)

    return added


def _update_search_queries(validated: Dict, cfg: Dict, dry_run: bool) -> List[str]:
    added: List[str] = []
    new_queries = [q for q in (validated.get("new_search_queries") or []) if q and isinstance(q, str)]
    if not new_queries:
        return added

    ws_cfg = cfg.get("web_search") or cfg.get("serpapi") or {}
    existing_queries = set(ws_cfg.get("queries") or [])

    to_add = [q for q in new_queries if q not in existing_queries]
    if not to_add:
        return added

    if dry_run:
        for q in to_add:
            logging.info("[dry_run] Would add query: %s", q)
            added.append(q)
        return added

    # Update the in-memory cfg and rewrite config.yaml
    cfg_text = CONFIG_FILE.read_text(encoding="utf-8")
    # Append queries at end of the queries list (safe YAML append)
    append_lines = "\n".join(f"    - '{q}'" for q in to_add)
    # Find the queries block and append; fall back to a comment marker
    pattern = r"(web_search:|serpapi:)(.*?queries:\s*\n)((?:\s+- .*\n)*)"

    def replacer(m):
        return m.group(1) + m.group(2) + m.group(3) + append_lines + "\n"

    new_cfg_text = re.sub(pattern, replacer, cfg_text, flags=re.DOTALL, count=1)

    if new_cfg_text != cfg_text:
        CONFIG_FILE.write_text(new_cfg_text, encoding="utf-8")
        added.extend(to_add)
        logging.info("Added %d new search queries to config.yaml", len(to_add))
    else:
        logging.warning("Could not locate queries block in config.yaml; queries not added")

    return added


def _update_competitors(validated: Dict, dry_run: bool) -> List[str]:
    added: List[str] = []
    new_comps = validated.get("new_competitors") or []
    if not new_comps:
        return added

    comps_yaml = _load_yaml(COMPETITORS_F) or {"competitors": {}}
    existing_comp_names = {n.lower() for n in (comps_yaml.get("competitors") or {}).keys()}

    for c in new_comps:
        name = (c.get("name") or "").strip()
        if not name or name.lower() in existing_comp_names:
            continue

        if dry_run:
            logging.info("[dry_run] Would add competitor: %s", name)
            added.append(name)
            continue

        # Add skeleton entry — humans can fill in details
        comps_yaml.setdefault("competitors", {})[name] = {
            "url": c.get("url", ""),
            "pricing": "Unknown — needs research",
            "primary_value": c.get("why_mentioned", "Mentioned in recent intelligence signals"),
            "key_customer": "",
            "payer": "",
            "positives": [],
            "negatives": [],
            "opportunities": ["Research needed"],
            "fire_chief": "",
            "fire_marshal": "",
            "fire_inspector": "",
            "facility_manager": "",
            "ahj": "",
            "notes": f"Auto-discovered by self_improve agent on {_now()}",
        }
        existing_comp_names.add(name.lower())
        added.append(name)

    if added and not dry_run:
        COMPETITORS_F.write_text(
            yaml.dump(comps_yaml, allow_unicode=True, default_flow_style=False),
            encoding="utf-8",
        )
        logging.info("Added %d competitor skeleton entries", len(added))

    return added


# ---------------------------------------------------------------------------
# Phase 5: Generate new chart data
# ---------------------------------------------------------------------------

def _generate_chart_data(cards_data, analytics_data, history_data, pages_db_path: str) -> List[str]:
    """Generate optional chart JSON files. Returns list of files written."""
    written: List[str] = []
    DASHBOARD_DIR.mkdir(exist_ok=True)

    # --- voc_trends.json: last 30 history snapshots for line chart ---
    history = history_data if isinstance(history_data, list) else []
    if history:
        trends_path = DASHBOARD_DIR / "voc_trends.json"
        trends_path.write_text(
            json.dumps({
                "generated_at": _now(),
                "description": "Category signal counts over last 30 pipeline runs",
                "series": history[-30:],   # key matches app.js reader
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append("voc_trends.json")

    # --- source_quality.json: per-source card counts + avg score ---
    cards = (cards_data or {}).get("cards") or []
    if cards:
        src_stats: Dict[str, Dict] = collections.defaultdict(
            lambda: {"count": 0, "total_score": 0, "domains": set()}
        )
        for c in cards:
            dom = _domain(c.get("url", ""))
            src_stats[dom]["count"] += 1
            src_stats[dom]["total_score"] += c.get("opportunity_score", 50)
            src_stats[dom]["domains"].add(dom)

        source_quality = [
            {
                "domain": dom,
                "card_count": s["count"],
                "avg_score": round(s["total_score"] / s["count"], 1) if s["count"] else 0,
            }
            for dom, s in src_stats.items()
            if dom
        ]
        source_quality.sort(key=lambda x: -x["avg_score"])

        sq_path = DASHBOARD_DIR / "source_quality.json"
        sq_path.write_text(
            json.dumps({
                "generated_at": _now(),
                "description": "Quality metrics per source domain",
                "sources": source_quality[:100],
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append("source_quality.json")

    # --- competitor_mentions.json: how often each competitor is referenced ---
    comps_yaml = _load_yaml(COMPETITORS_F)
    if comps_yaml and cards:
        competitor_names = list((comps_yaml.get("competitors") or {}).keys())
        mention_counts: Dict[str, int] = collections.Counter()
        for c in cards:
            blob = f"{c.get('title', '')} {c.get('one_liner', '')} {c.get('summary', '')}".lower()
            for name in competitor_names:
                if name.lower() in blob:
                    mention_counts[name] += 1

        cm_path = DASHBOARD_DIR / "competitor_mentions.json"
        cm_path.write_text(
            json.dumps({
                "generated_at": _now(),
                "description": "How often each tracked competitor appears in intelligence signals",
                "mentions": [
                    {"name": n, "count": mention_counts.get(n, 0)}
                    for n in sorted(competitor_names, key=lambda x: -mention_counts.get(x, 0))
                ],
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append("competitor_mentions.json")

    return written


# ---------------------------------------------------------------------------
# Phase 5b: Write pending suggestions (require_approval mode)
# ---------------------------------------------------------------------------

def _write_pending_suggestions(validated: Dict, confidence: int, reasoning: str) -> int:
    """Append validated suggestions to pending_suggestions.json for UI approval.

    Returns the count of new items added.
    """
    import uuid

    # Load existing pending items
    existing: List[Dict] = []
    if PENDING_FILE.exists():
        try:
            data = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
            existing = data.get("items") or []
        except Exception:
            existing = []

    # Build set of already-pending URLs / queries / names to avoid dupes
    existing_urls  = {i.get("url", "").rstrip("/") for i in existing}
    existing_queries = {i.get("query", "") for i in existing}
    existing_names = {i.get("name", "").lower() for i in existing}

    new_items: List[Dict] = []
    ts = _now()

    for s in validated.get("new_rss_sources", []) + validated.get("new_web_pages", []):
        url = (s.get("url") or "").strip().rstrip("/")
        if not url or url in existing_urls:
            continue
        new_items.append({
            "id": str(uuid.uuid4())[:8],
            "suggested_at": ts,
            "confidence": confidence,
            "reasoning": s.get("reason") or reasoning,
            "category": "source",
            "source_type": s.get("type", "page"),
            "url": url,
            "label": s.get("reason", "")[:100],
        })
        existing_urls.add(url)

    for q in validated.get("new_search_queries", []):
        q = (q or "").strip()
        if not q or q in existing_queries:
            continue
        new_items.append({
            "id": str(uuid.uuid4())[:8],
            "suggested_at": ts,
            "confidence": confidence,
            "reasoning": reasoning,
            "category": "query",
            "query": q,
        })
        existing_queries.add(q)

    for c in validated.get("new_competitors", []):
        name = (c.get("name") or "").strip()
        if not name or name.lower() in existing_names:
            continue
        new_items.append({
            "id": str(uuid.uuid4())[:8],
            "suggested_at": ts,
            "confidence": confidence,
            "reasoning": c.get("why_mentioned") or reasoning,
            "category": "competitor",
            "name": name,
            "url": (c.get("url") or "").strip(),
        })
        existing_names.add(name.lower())

    if not new_items:
        logging.info("No new pending suggestions to write.")
        return 0

    merged = existing + new_items
    # Drop oldest when over limit
    if len(merged) > MAX_PENDING_KEPT:
        merged = merged[-MAX_PENDING_KEPT:]

    DASHBOARD_DIR.mkdir(exist_ok=True)
    PENDING_FILE.write_text(
        json.dumps({
            "generated_at": ts,
            "description": "AI-discovered sources/queries/competitors awaiting approval via the Settings UI",
            "items": merged,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logging.info("Wrote %d new pending suggestions to %s", len(new_items), PENDING_FILE)
    return len(new_items)


# ---------------------------------------------------------------------------
# Phase 6: Git commit
# ---------------------------------------------------------------------------

def _git_commit(changed_files: List[str], n_sources: int, n_queries: int, n_competitors: int,
                dry_run: bool) -> bool:
    if dry_run:
        logging.info("[dry_run] Would commit: %s", changed_files)
        return True
    if not changed_files:
        logging.info("No files changed; skipping commit.")
        return True
    try:
        subprocess.run(["git", "config", "user.name", "intel-agent[bot]"], check=True)
        subprocess.run(["git", "config", "user.email", "agent@users.noreply.github.com"], check=True)
        subprocess.run(["git", "add"] + changed_files, check=True)
        msg = (
            f"agent: self-improve {_now()} "
            f"(+{n_sources} sources, +{n_queries} queries, +{n_competitors} competitors)"
        )
        result = subprocess.run(["git", "diff", "--cached", "--quiet"])
        if result.returncode == 0:
            logging.info("No staged changes to commit.")
            return True
        subprocess.run(["git", "commit", "-m", msg], check=True)
        subprocess.run(["git", "pull", "--rebase", "--autostash"], check=True)
        subprocess.run(["git", "push"], check=True)
        logging.info("Committed and pushed: %s", msg)
        return True
    except Exception as e:
        logging.error("Git commit failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Phase 7: Write log
# ---------------------------------------------------------------------------

def _write_log(log_entry: Dict) -> None:
    existing: List[Dict] = []
    if LOG_FILE.exists():
        try:
            data = json.loads(LOG_FILE.read_text(encoding="utf-8"))
            existing = data.get("runs") or []
        except Exception:
            existing = []
    existing.append(log_entry)
    DASHBOARD_DIR.mkdir(exist_ok=True)
    LOG_FILE.write_text(
        json.dumps({"runs": existing[-MAX_LOG_RUNS:]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logging.info("Wrote self_improve_log.json (%d total runs)", len(existing))


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run() -> None:
    cfg = _load_yaml(CONFIG_FILE) or {}
    si_cfg = cfg.get("self_improve") or {}

    if not si_cfg.get("enabled", True):
        logging.info("self_improve disabled in config; skipping.")
        return

    dry_run          = bool(si_cfg.get("dry_run", False))
    require_approval = bool(si_cfg.get("require_approval", False))
    max_sources      = int(si_cfg.get("max_new_sources_per_run", 5))
    max_queries      = int(si_cfg.get("max_new_queries_per_run", 3))
    max_comps        = int(si_cfg.get("max_new_competitors_per_run", 3))
    min_conf         = int(si_cfg.get("min_confidence_to_commit", 60))

    domain_name = (cfg.get("domain") or {}).get("name", "Market Intelligence")
    model = os.environ.get("OPENAI_SUMMARISER_MODEL", "gpt-4o-mini")
    db_path = (cfg.get("storage") or {}).get("db_path", "data/scraper.db")

    logging.info("=== self_improve START (dry_run=%s) ===", dry_run)

    # --- Load dashboard data ---
    cards_data    = _load_json(DASHBOARD_DIR / "cards.json")
    analytics     = _load_json(DASHBOARD_DIR / "analytics.json")
    history       = _load_json(DASHBOARD_DIR / "voc_history.json")
    extra_raw     = _load_yaml(EXTRA_SOURCES)
    ws_cfg        = cfg.get("web_search") or cfg.get("serpapi") or {}
    existing_queries = list(ws_cfg.get("queries") or [])

    cards = (cards_data or {}).get("cards") or []
    if not cards:
        logging.info("No cards found; skipping analysis.")
        _write_log({"date": _now(), "skipped": True, "reason": "no cards"})
        return

    # Phase 1: Analyze
    logging.info("Phase 1: Analyzing %d cards...", len(cards))
    analysis = _analyze(cards_data, analytics, history, cfg, extra_raw)

    # Phase 2: LLM Discovery
    logging.info("Phase 2: LLM discovery...")
    client = None
    try:
        from openai import OpenAI  # type: ignore
        api_key = (
            os.environ.get("OPENAI_SUMMARISER_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
        )
        if api_key:
            client = OpenAI(api_key=api_key)
    except Exception:
        pass

    suggestions = _llm_discover(analysis, domain_name, existing_queries, client, model)

    if not suggestions:
        logging.info("No LLM suggestions; generating charts only.")
        charts = _generate_chart_data(cards_data, analytics, history, db_path)
        _write_log({
            "date": _now(), "skipped_discovery": True,
            "charts_updated": charts, "cards_analyzed": len(cards),
        })
        _git_commit(
            [str(DASHBOARD_DIR / c) for c in charts],
            0, 0, 0, dry_run,
        )
        return

    confidence = int(suggestions.get("confidence", 50))
    logging.info("LLM confidence: %d (min required: %d)", confidence, min_conf)

    # Phase 3: Validate
    logging.info("Phase 3: Validating suggestions...")
    # Trim to configured max before validating (saves HTTP calls)
    suggestions["new_rss_sources"] = (suggestions.get("new_rss_sources") or [])[:max_sources]
    suggestions["new_web_pages"]   = (suggestions.get("new_web_pages")   or [])[:max_sources]
    suggestions["new_search_queries"] = (suggestions.get("new_search_queries") or [])[:max_queries]
    suggestions["new_competitors"] = (suggestions.get("new_competitors")  or [])[:max_comps]

    existing_source_domains: set = set()
    sources_cfg = cfg.get("sources") or {}
    for section in ("industry_sites", "magazines_rss", "blogs_and_chief_voices"):
        for s in sources_cfg.get(section, []):
            existing_source_domains.add(_domain(s.get("url", "")))
    for s in (extra_raw if isinstance(extra_raw, list) else []):
        existing_source_domains.add(_domain(s.get("url", "")))

    validated = _validate_suggestions(suggestions, existing_source_domains)

    # Phase 4: Update config files — or queue for approval
    sources_added     = []
    queries_added     = []
    competitors_added = []
    pending_added     = 0
    commit = (confidence >= min_conf)

    if require_approval:
        logging.info("Phase 4: require_approval=true — queuing %d suggestions for UI review...",
                     len(validated.get("new_rss_sources", [])) +
                     len(validated.get("new_web_pages", [])) +
                     len(validated.get("new_search_queries", [])) +
                     len(validated.get("new_competitors", [])))
        pending_added = _write_pending_suggestions(
            validated, confidence, validated.get("reasoning", ""),
        )
    elif commit or dry_run:
        logging.info("Phase 4: Updating config files...")
        sources_added     = _update_extra_sources(validated, dry_run)
        queries_added     = _update_search_queries(validated, cfg, dry_run)
        competitors_added = _update_competitors(validated, dry_run)
    else:
        logging.info("Confidence %d < min_confidence_to_commit %d; skipping config updates.", confidence, min_conf)

    # Phase 5: Generate chart data (always, regardless of confidence)
    logging.info("Phase 5: Generating chart data...")
    charts = _generate_chart_data(cards_data, analytics, history, db_path)

    # Phase 6: Commit
    logging.info("Phase 6: Committing changes...")
    changed_files: List[str] = []
    if sources_added:
        changed_files.append(str(EXTRA_SOURCES))
    if queries_added:
        changed_files.append(str(CONFIG_FILE))
    if competitors_added:
        changed_files.append(str(COMPETITORS_F))
    if pending_added:
        changed_files.append(str(PENDING_FILE))
    changed_files += [str(DASHBOARD_DIR / c) for c in charts]
    changed_files.append(str(LOG_FILE))  # log is always updated

    log_entry = {
        "date": _now(),
        "sources_added": sources_added,
        "queries_added": queries_added,
        "competitors_added": competitors_added,
        "pending_suggestions_added": pending_added if require_approval else 0,
        "require_approval": require_approval,
        "charts_updated": charts,
        "confidence": confidence,
        "reasoning": validated.get("reasoning", ""),
        "cards_analyzed": len(cards),
        "emerging_categories": analysis.get("emerging_categories", []),
        "dry_run": dry_run,
    }
    _write_log(log_entry)

    _git_commit(
        list(dict.fromkeys(changed_files)),  # dedupe
        len(sources_added), len(queries_added), len(competitors_added),
        dry_run,
    )

    logging.info(
        "=== self_improve DONE: +%d sources, +%d queries, +%d competitors, charts=%s ===",
        len(sources_added), len(queries_added), len(competitors_added), charts,
    )


def main():
    run()


if __name__ == "__main__":
    main()
