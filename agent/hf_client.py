"""agent/hf_client.py
HuggingFace Inference API client for free-tier model calls.

Used as a pre-filter BEFORE spending OpenAI tokens:
  - Zero-shot category classification: facebook/bart-large-mnli
  - Sentiment detection: cardiffnlp/twitter-roberta-base-sentiment-latest
  - Extractive summarization: facebook/bart-large-cnn

All calls are graceful: if HF_API_KEY is missing, network fails, or the
model returns garbage, we return None and the caller falls through to the
normal OpenAI path. Nothing breaks.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _hf_key() -> Optional[str]:
    return (
        os.environ.get("HF_API_KEY")
        or os.environ.get("HUGGINGFACE_API_KEY")
        or os.environ.get("HF_TOKEN")
    )

def _headers() -> Dict[str, str]:
    key = _hf_key()
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h

def _available() -> bool:
    return bool(_hf_key())

# ---------------------------------------------------------------------------
# Raw inference call with retry
# ---------------------------------------------------------------------------
_BASE = "https://api-inference.huggingface.co/models"

def _call(model: str, payload: Dict[str, Any], *, retries: int = 2) -> Optional[Any]:
    if not _available():
        return None
    try:
        import requests  # type: ignore
        url = f"{_BASE}/{model}"
        for attempt in range(retries + 1):
            try:
                r = requests.post(url, headers=_headers(), json=payload, timeout=15)
                if r.status_code == 503:
                    # Model loading — wait and retry
                    wait = min(30, 8 * (attempt + 1))
                    log.debug("[hf] model %s loading, waiting %ds", model, wait)
                    time.sleep(wait)
                    continue
                if r.status_code == 429:
                    log.debug("[hf] rate limited on %s, skipping", model)
                    return None
                if not r.ok:
                    log.debug("[hf] %s returned %d: %s", model, r.status_code, r.text[:200])
                    return None
                return r.json()
            except Exception as e:
                log.debug("[hf] attempt %d failed for %s: %s", attempt, model, e)
                if attempt < retries:
                    time.sleep(3)
        return None
    except ImportError:
        log.debug("[hf] requests not installed, skipping HF call")
        return None

# ---------------------------------------------------------------------------
# Zero-shot category classification
# ---------------------------------------------------------------------------
# Maps HF candidate label → our internal CATEGORIES
_CANDIDATE_MAP = {
    "fire inspection and compliance":          "Inspections & Compliance",
    "data and system integration":             "Data & System Integration",
    "incident command and emergency response": "Incident Command & Response",
    "fire department communication and dispatch": "Communication & Coordination",
    "operations training and tactics":         "Operations & Training",
    "facilities and built environment":        "Facilities / Built Environment",
    "community risk reduction":                "Community Risk Reduction",
    "wildland fire and WUI":                   "Wildland/WUI",
    "fire safety standards and codes":         "Standards & Codes (NFPA/ICC)",
    "procurement grants and funding":          "Procurement / Grants / Funding",
}
_CANDIDATES = list(_CANDIDATE_MAP.keys())
_MODEL_ZSC   = "facebook/bart-large-mnli"
_CONF_THRESHOLD = 0.55  # only trust HF if it's confident


def classify_category(text: str) -> Optional[str]:
    """
    Returns a CATEGORIES string if HF is confident, else None (→ fall through to OpenAI).
    """
    if not _available():
        return None
    snippet = (text or "")[:600]
    result = _call(_MODEL_ZSC, {
        "inputs": snippet,
        "parameters": {"candidate_labels": _CANDIDATES, "multi_label": False}
    })
    if not result or not isinstance(result, dict):
        return None
    labels = result.get("labels", [])
    scores = result.get("scores", [])
    if not labels or not scores:
        return None
    top_label = labels[0]
    top_score = scores[0]
    if top_score < _CONF_THRESHOLD:
        log.debug("[hf] zsc low confidence %.2f for '%s'", top_score, top_label)
        return None
    mapped = _CANDIDATE_MAP.get(top_label)
    log.debug("[hf] zsc → %s (%.2f)", mapped, top_score)
    return mapped


# ---------------------------------------------------------------------------
# Sentiment detection
# ---------------------------------------------------------------------------
_MODEL_SENT = "cardiffnlp/twitter-roberta-base-sentiment-latest"
_SENT_MAP   = {"positive": "positive", "negative": "frustrated", "neutral": "neutral"}


def classify_sentiment(text: str) -> Optional[str]:
    """Returns 'frustrated' | 'neutral' | 'positive' or None."""
    if not _available():
        return None
    snippet = (text or "")[:512]
    result = _call(_MODEL_SENT, {"inputs": snippet})
    if not result:
        return None
    # HF returns list of [{label, score}] or [[{label, score}]]
    items = result
    if isinstance(items, list) and items and isinstance(items[0], list):
        items = items[0]
    if not isinstance(items, list):
        return None
    best = max(items, key=lambda x: x.get("score", 0), default=None)
    if not best:
        return None
    label = best.get("label", "").lower()
    return _SENT_MAP.get(label)


# ---------------------------------------------------------------------------
# Extractive summary (bart-large-cnn)
# ---------------------------------------------------------------------------
_MODEL_SUM = "facebook/bart-large-cnn"


def extractive_summary(text: str, max_length: int = 60, min_length: int = 20) -> Optional[str]:
    """
    Returns a tight 1-2 sentence extractive summary, or None.
    Much more concrete than GPT generative summaries on source text.
    """
    if not _available():
        return None
    snippet = (text or "")[:1024]
    if len(snippet) < 100:
        return None
    result = _call(_MODEL_SUM, {
        "inputs": snippet,
        "parameters": {"max_length": max_length, "min_length": min_length, "do_sample": False}
    })
    if not result:
        return None
    if isinstance(result, list) and result:
        return result[0].get("summary_text")
    if isinstance(result, dict):
        return result.get("summary_text")
    return None
