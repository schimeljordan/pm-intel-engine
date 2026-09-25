"""agent/agentic_ai_intel.py — Agentic AI / autonomous-AI landscape monitor.

Tracks the AI agent ecosystem (models, research, repos, company releases, trade
press) across five free, no-auth-required sources and writes a single summary to
dashboard/agentic_ai_intel.json for the dashboard "AI Intel" tab.

Sources:
  1. Hugging Face Models API   — newest text-generation models, filtered to agentic tags
  2. ArXiv API (Atom XML)      — recent agent/LLM-agent papers (last 30d)
  3. GitHub Search API         — top llm-agent/ai-agent repos + MCP repos
  4. GDELT DOC 2.0             — trade-press articles on agentic AI releases
  5. Company RSS feeds         — OpenAI / Anthropic / HF / LangChain blog posts (last 30d)

Each source is wrapped in its own try/except: a failed source logs a warning and
contributes an empty list, so one outage never sinks the whole run. Only if ALL
sources fail do we write an {"error": ...} payload.
"""
from __future__ import annotations

import json
import os
import re
import time
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

import requests

try:
    import feedparser  # already installed in the pipeline env
except Exception:  # pragma: no cover - defensive
    feedparser = None

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}
GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "FireIntelAgent/1.0",
}
TIMEOUT = 15

HF_API = "https://huggingface.co/api/models"
ARXIV_API = "http://export.arxiv.org/api/query"
GITHUB_SEARCH = "https://api.github.com/search/repositories"
GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc"

AGENTIC_TAGS = {"agent", "tool-use", "function-calling", "reasoning", "autonomous"}

COMPANY_FEEDS = [
    ("OpenAI", "https://openai.com/blog/rss.xml"),
    ("Anthropic", "https://www.anthropic.com/rss.xml"),
    ("HuggingFace", "https://huggingface.co/blog/feed.xml"),
    ("LangChain", "https://blog.langchain.dev/rss/"),
]

GDELT_QUERIES = [
    '"agentic AI" OR "AI agent" release announcement',
    '"model context protocol" OR "MCP" AI',
    '"OpenAI" OR "Anthropic" OR "Google DeepMind" agent release',
]

TITLE_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "via",
    "using", "based", "towards", "toward", "from", "by", "is", "are", "as", "at",
    "we", "our", "this", "that", "can", "be", "new", "via", "into", "than",
    "agent", "agents", "agentic", "llm", "llms", "model", "models", "language",
    "large", "ai", "learning", "framework", "system", "systems", "approach",
}

ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _cutoff_30d() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=30)


def _parse_dt(s: str) -> datetime | None:
    """Best-effort parse of common date formats into a tz-aware datetime."""
    if not s:
        return None
    s = s.strip()
    fmts = (
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
    )
    for f in fmts:
        try:
            dt = datetime.strptime(s, f)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- #
# Source 1 — Hugging Face Models
# --------------------------------------------------------------------------- #
def fetch_hf_models() -> List[Dict[str, Any]]:
    params = {
        "sort": "lastModified",
        "direction": "-1",
        "limit": "100",
        "filter": "text-generation",
    }
    r = requests.get(HF_API, params=params, headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    rows = r.json() or []
    out: List[Dict[str, Any]] = []
    for m in rows:
        tags = [str(t).lower() for t in (m.get("tags") or [])]
        is_agentic = any(
            any(at in t for at in AGENTIC_TAGS) for t in tags
        )
        if not is_agentic:
            continue
        model_id = m.get("modelId") or m.get("id") or ""
        author = m.get("author") or (model_id.split("/")[0] if "/" in model_id else "")
        out.append({
            "model_id": model_id,
            "author": author,
            "downloads": m.get("downloads") or 0,
            "likes": m.get("likes") or 0,
            "tags": [t for t in (m.get("tags") or [])][:12],
            "last_modified": m.get("lastModified") or "",
            "url": f"https://huggingface.co/{model_id}" if model_id else "",
            "is_agentic": True,
        })
    return out


# --------------------------------------------------------------------------- #
# Source 2 — ArXiv papers
# --------------------------------------------------------------------------- #
def fetch_arxiv_papers() -> List[Dict[str, Any]]:
    params = {
        "search_query": (
            "(ti:agent+OR+ti:agentic+OR+ti:autonomous+agent+OR+ti:LLM+agent)"
            "&cat=cs.AI+OR+cs.MA"
        ),
        "sortBy": "submittedDate",
        "sortOrder": "descending",
        "max_results": "50",
    }
    # ArXiv treats '+' as a literal space-join token in search_query/cat, so we
    # build the query string manually to preserve the documented syntax.
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    r = requests.get(f"{ARXIV_API}?{qs}", headers=HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    cutoff = _cutoff_30d()
    out: List[Dict[str, Any]] = []
    for entry in root.findall("atom:entry", ATOM_NS):
        published = (entry.findtext("atom:published", default="", namespaces=ATOM_NS) or "").strip()
        dt = _parse_dt(published)
        if dt and dt < cutoff:
            continue
        raw_id = (entry.findtext("atom:id", default="", namespaces=ATOM_NS) or "").strip()
        arxiv_id = raw_id.rsplit("/", 1)[-1] if raw_id else ""
        title = " ".join((entry.findtext("atom:title", default="", namespaces=ATOM_NS) or "").split())
        abstract = " ".join((entry.findtext("atom:summary", default="", namespaces=ATOM_NS) or "").split())
        authors = [
            (a.findtext("atom:name", default="", namespaces=ATOM_NS) or "").strip()
            for a in entry.findall("atom:author", ATOM_NS)
        ]
        cats = [
            c.get("term", "")
            for c in entry.findall("atom:category", ATOM_NS)
            if c.get("term")
        ]
        out.append({
            "title": title,
            "authors": [a for a in authors if a][:8],
            "abstract": abstract[:300],
            "arxiv_id": arxiv_id,
            "date": published[:10] if published else "",
            "categories": cats[:6],
            "url": raw_id or (f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else ""),
        })
    return out


# --------------------------------------------------------------------------- #
# Source 3 — GitHub trending repos
# --------------------------------------------------------------------------- #
def _github_search(query: str, sort: str, per_page: int) -> List[Dict[str, Any]]:
    params = {"q": query, "sort": sort, "order": "desc", "per_page": str(per_page)}
    r = requests.get(GITHUB_SEARCH, params=params, headers=GITHUB_HEADERS, timeout=TIMEOUT)
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    out: List[Dict[str, Any]] = []
    for it in items:
        out.append({
            "name": it.get("name") or "",
            "full_name": it.get("full_name") or "",
            "description": it.get("description") or "",
            "stars": it.get("stargazers_count") or 0,
            "forks": it.get("forks_count") or 0,
            "last_pushed": it.get("pushed_at") or "",
            "topics": (it.get("topics") or [])[:8],
            "url": it.get("html_url") or "",
        })
    return out


def fetch_github_repos() -> List[Dict[str, Any]]:
    seen: set[str] = set()
    out: List[Dict[str, Any]] = []
    # GitHub's search API rejects multiple `topic:` qualifiers joined by OR
    # (422 "only logical operators"), so each agent topic runs as its own query
    # and results are merged + de-duped. MCP repos use a combined-topic AND query.
    queries = [
        ("topic:llm-agent", "stars", 25),
        ("topic:ai-agent", "stars", 25),
        ("topic:autonomous-agent", "stars", 25),
        ("topic:mcp topic:model-context-protocol", "updated", 15),
    ]
    for q, sort, per_page in queries:
        try:
            for repo in _github_search(q, sort, per_page):
                key = repo.get("full_name") or repo.get("url")
                if not key or key in seen:
                    continue
                seen.add(key)
                out.append(repo)
        except Exception as e:
            print(f"[agentic_ai_intel] github query failed {q!r}: {e}")
    out.sort(key=lambda r: r.get("stars", 0), reverse=True)
    return out


# --------------------------------------------------------------------------- #
# Source 4 — GDELT trade press
# --------------------------------------------------------------------------- #
def fetch_gdelt_news() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for i, q in enumerate(GDELT_QUERIES):
        try:
            params = {
                "query": q,
                "mode": "artlist",
                "format": "json",
                "maxrecords": 25,
                "sort": "DateDesc",
            }
            r = requests.get(GDELT_DOC, params=params, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            text = r.text.strip()
            if not text or not text.startswith("{"):
                continue
            articles = (json.loads(text) or {}).get("articles") or []
            for a in articles:
                url = a.get("url") or ""
                if not url or url in seen:
                    continue
                seen.add(url)
                out.append({
                    "title": a.get("title") or "",
                    "source": a.get("domain") or "",
                    "url": url,
                    "date": a.get("seendate") or "",
                    "tone": 0.0,
                })
            print(f"[agentic_ai_intel] gdelt {q!r}: {len(articles)} articles")
        except Exception as e:
            print(f"[agentic_ai_intel] gdelt query failed {q!r}: {e}")
        if i < len(GDELT_QUERIES) - 1:
            time.sleep(1.5)
    return out


# --------------------------------------------------------------------------- #
# Source 5 — Company RSS feeds
# --------------------------------------------------------------------------- #
def fetch_company_releases() -> List[Dict[str, Any]]:
    if feedparser is None:
        print("[agentic_ai_intel] feedparser unavailable; skipping company feeds")
        return []
    cutoff = _cutoff_30d()
    out: List[Dict[str, Any]] = []
    for company, url in COMPANY_FEEDS:
        try:
            parsed = feedparser.parse(url)
            for e in parsed.entries:
                published = (
                    e.get("published")
                    or e.get("updated")
                    or e.get("pubDate")
                    or ""
                )
                dt = _parse_dt(published)
                if dt is None and getattr(e, "published_parsed", None):
                    try:
                        dt = datetime(*e.published_parsed[:6], tzinfo=timezone.utc)
                    except Exception:
                        dt = None
                if dt and dt < cutoff:
                    continue
                summary = re.sub(r"<[^>]+>", "", e.get("summary", "") or "").strip()
                out.append({
                    "company": company,
                    "title": (e.get("title") or "").strip(),
                    "date": published,
                    "url": e.get("link") or "",
                    "summary": summary[:200],
                })
            print(f"[agentic_ai_intel] feed {company}: {len(parsed.entries)} entries")
        except Exception as e:
            print(f"[agentic_ai_intel] feed failed {company}: {e}")
    return out


# --------------------------------------------------------------------------- #
# Summary computation
# --------------------------------------------------------------------------- #
def _build_summary(
    models: List[Dict[str, Any]],
    papers: List[Dict[str, Any]],
    repos: List[Dict[str, Any]],
    releases: List[Dict[str, Any]],
) -> Dict[str, Any]:
    top_repo = repos[0]["name"] if repos else ""
    company_counts = Counter(r.get("company", "Other") for r in releases)
    most_discussed = company_counts.most_common(1)[0][0] if company_counts else ""
    return {
        "new_models_30d": len(models),
        "new_papers_30d": len(papers),
        "top_trending_repo": top_repo,
        "most_discussed_company": most_discussed,
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "agentic_ai_intel.json"

    sources = {
        "trending_models": fetch_hf_models,
        "recent_papers": fetch_arxiv_papers,
        "trending_repos": fetch_github_repos,
        "news_articles": fetch_gdelt_news,
        "company_releases": fetch_company_releases,
    }

    results: Dict[str, List[Dict[str, Any]]] = {}
    failures: List[str] = []
    for key, fn in sources.items():
        try:
            data = fn()
            results[key] = data
            print(f"[agentic_ai_intel] {key}: {len(data)} items")
        except Exception as e:
            results[key] = []
            failures.append(f"{key}: {e}")
            print(f"[agentic_ai_intel] source failed {key}: {e}")

    if len(failures) == len(sources):
        out = {"error": "; ".join(failures), "generated_at": _now()}
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[agentic_ai_intel] ALL sources failed; wrote error payload to {out_path}")
        return

    out: Dict[str, Any] = {
        "generated_at": _now(),
        "trending_models": results["trending_models"],
        "recent_papers": results["recent_papers"],
        "trending_repos": results["trending_repos"],
        "news_articles": results["news_articles"],
        "company_releases": results["company_releases"],
        "summary": _build_summary(
            results["trending_models"],
            results["recent_papers"],
            results["trending_repos"],
            results["company_releases"],
        ),
    }
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"[agentic_ai_intel] wrote {out_path} "
        f"(models={len(out['trending_models'])}, papers={len(out['recent_papers'])}, "
        f"repos={len(out['trending_repos'])}, news={len(out['news_articles'])}, "
        f"releases={len(out['company_releases'])})"
    )


if __name__ == "__main__":
    main()
