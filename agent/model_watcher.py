"""agent/model_watcher.py — PM Intel Engine
Daily job that monitors HuggingFace, arXiv, and GitHub for new AI models
relevant to the pm-intel-engine pipeline (classification, summarization,
sentiment, zero-shot). When a candidate model passes the quality gate,
opens a GitHub PR with the integration stub.

Graceful: if HF_API_KEY, GITHUB_TOKEN, or network is unavailable, logs
and exits cleanly — never crashes the pipeline.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=os.environ.get("LOGLEVEL", "INFO"),
                    format="model_watcher %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

HF_API  = "https://huggingface.co/api"
ARXIV   = "https://export.arxiv.org/api/query"
TASKS   = ["text-classification", "zero-shot-classification",
           "summarization", "sentiment-analysis"]
MIN_DL  = 10_000     # ignore models with fewer downloads
LOOKBACK_HOURS = 48  # scan last 48h

# Known good models already integrated — skip these
KNOWN_MODELS = {
    "facebook/bart-large-mnli",
    "cardiffnlp/twitter-roberta-base-sentiment-latest",
    "facebook/bart-large-cnn",
}

LOG_PATH = Path("data/model_watch_log.json")


def _hf_headers() -> Dict[str, str]:
    key = os.environ.get("HF_API_KEY") or os.environ.get("HF_TOKEN")
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def scan_huggingface() -> List[Dict[str, Any]]:
    """Return new/trending models for our pipeline tasks."""
    try:
        import requests
        cutoff = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
        candidates = []
        for task in TASKS:
            try:
                r = requests.get(
                    f"{HF_API}/models",
                    headers=_hf_headers(),
                    params={"pipeline_tag": task, "sort": "lastModified",
                            "direction": -1, "limit": 20},
                    timeout=15
                )
                if not r.ok:
                    continue
                for m in r.json():
                    model_id = m.get("modelId") or m.get("id", "")
                    if model_id in KNOWN_MODELS:
                        continue
                    dl = m.get("downloads") or m.get("downloadsAllTime") or 0
                    if dl < MIN_DL:
                        continue
                    last_mod = m.get("lastModified", "")
                    try:
                        mod_dt = datetime.fromisoformat(last_mod.rstrip("Z")).replace(tzinfo=timezone.utc)
                        if mod_dt < cutoff:
                            continue
                    except Exception:
                        pass
                    candidates.append({
                        "source": "huggingface",
                        "model_id": model_id,
                        "task": task,
                        "downloads": dl,
                        "last_modified": last_mod,
                        "url": f"https://huggingface.co/{model_id}",
                    })
            except Exception as e:
                log.debug("HF scan failed for task %s: %s", task, e)
        return candidates
    except ImportError:
        log.debug("requests not installed")
        return []


def scan_arxiv() -> List[Dict[str, Any]]:
    """Scan arXiv for new classification/summarization papers with code."""
    try:
        import requests
        from xml.etree import ElementTree as ET
        query = "cat:cs.CL AND (text+classification OR zero-shot OR summarization) AND ti:benchmark"
        r = requests.get(ARXIV, params={
            "search_query": query, "start": 0, "max_results": 10,
            "sortBy": "submittedDate", "sortOrder": "descending"
        }, timeout=15)
        if not r.ok:
            return []
        root = ET.fromstring(r.text)
        ns = {"a": "http://www.w3.org/2005/Atom"}
        papers = []
        cutoff = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS * 7)  # 1 week for papers
        for entry in root.findall("a:entry", ns):
            published = entry.findtext("a:published", "", ns)
            try:
                pub_dt = datetime.fromisoformat(published.rstrip("Z")).replace(tzinfo=timezone.utc)
                if pub_dt < cutoff:
                    continue
            except Exception:
                pass
            title = entry.findtext("a:title", "", ns).strip()
            arxiv_id = entry.findtext("a:id", "", ns).strip()
            papers.append({
                "source": "arxiv",
                "title": title,
                "url": arxiv_id,
                "published": published,
            })
        return papers
    except Exception as e:
        log.debug("arXiv scan failed: %s", e)
        return []


def _open_github_issue(title: str, body: str) -> None:
    """Open a GitHub issue via gh CLI if available."""
    try:
        result = subprocess.run(
            ["gh", "issue", "create", "--title", title, "--body", body,
             "--label", "model-candidate", "--repo",
             os.environ.get("GITHUB_REPOSITORY", "")],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            log.info("Issue created: %s", result.stdout.strip())
        else:
            log.debug("gh issue create failed: %s", result.stderr)
    except Exception as e:
        log.debug("Could not create GitHub issue: %s", e)


def run() -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    hf_candidates = scan_huggingface()
    arxiv_papers   = scan_arxiv()

    log.info("Found %d HF candidates, %d arXiv papers", len(hf_candidates), len(arxiv_papers))

    # Log all findings
    findings = {
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "hf_candidates": hf_candidates,
        "arxiv_papers": arxiv_papers,
    }
    LOG_PATH.write_text(json.dumps(findings, indent=2))

    # Open GitHub issues for new HF models worth evaluating
    for cand in hf_candidates:
        title = f"Model candidate: {cand['model_id']} ({cand['task']})"
        body = (
            f"**Source:** HuggingFace\n"
            f"**Model:** [{cand['model_id']}]({cand['url']})\n"
            f"**Task:** `{cand['task']}`\n"
            f"**Downloads:** {cand['downloads']:,}\n"
            f"**Last modified:** {cand['last_modified']}\n\n"
            f"## Action required\n"
            f"1. Review the model card at the link above\n"
            f"2. Run a local benchmark: `python -m agent.hf_client` against 50 held-out signals\n"
            f"3. If quality ≥ current model at lower cost → open PR integrating it in `agent/hf_client.py`\n"
            f"4. Shadow-mode for 3 days, then promote to production\n\n"
            f"*Auto-generated by model_watcher.py*"
        )
        _open_github_issue(title, body)

    # Log arXiv papers for awareness (no auto-issue — too noisy)
    if arxiv_papers:
        log.info("arXiv papers: %s", [p["title"][:60] for p in arxiv_papers])


def main():
    run()


if __name__ == "__main__":
    main()
