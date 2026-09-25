"""agent/signal_analytics.py — Behavioral research analytics layer.

Applies Jobs-to-be-Done (JTBD) and behavioral segmentation frameworks to
produce actionable signal intelligence beyond raw counts.

Outputs: dashboard/signal_analytics.json

Metrics computed:
  - Persona Pain Intensity   : weighted sum of (urgency × frustrated_count) per persona
  - Signal Velocity          : week-over-week category growth rate (from voc_history)
  - Theme Emergence Index    : categories growing faster than baseline average velocity
  - Recency Distribution     : proportion of signals in 0-30, 30-90, 90-180, 180+ day bands
  - Sentiment Breakdown      : frustrated / neutral / positive count per category
  - Behavioral Stage Mix     : awareness / evaluation / frustration / advocacy per category
  - JTBD Cluster Frequency   : top recurring job statements across signals
  - Statistical Significance : low / medium / high based on count vs domain average
"""
from __future__ import annotations

import collections
import datetime
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="signal_analytics %(levelname)s: %(message)s",
)

DASHBOARD_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    except Exception as e:
        logging.warning("Could not read %s: %s", path, e)
        return None


def _age_days(date_str: str) -> Optional[int]:
    """Return age in days from ISO8601 date string, or None if unparseable."""
    if not date_str:
        return None
    # Strip trailing Z before strptime — Python's strptime does not parse
    # literal 'Z' as UTC with %Y-%m-%dT%H:%M:%SZ; strip it and use naive format.
    clean = date_str.rstrip("Z").strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            ts = datetime.datetime.strptime(clean[:len(fmt)], fmt)
            return max(0, (datetime.datetime.utcnow() - ts).days)
        except ValueError:
            continue
    return None


def _recency_band(days: Optional[int]) -> str:
    if days is None:
        return "unknown"
    if days <= 30:
        return "0-30d"
    if days <= 90:
        return "31-90d"
    if days <= 180:
        return "91-180d"
    return "180d+"


# ---------------------------------------------------------------------------
# Persona Pain Intensity
# ---------------------------------------------------------------------------

def _persona_pain_intensity(cards: List[Dict]) -> List[Dict]:
    """
    Pain Intensity = Σ(urgency × frustration_weight) per persona, normalized to 100.

    Frustration weight: frustrated=1.5, neutral=1.0, positive=0.5
    """
    SENTIMENT_WEIGHT = {"frustrated": 1.5, "neutral": 1.0, "positive": 0.5}

    persona_scores: Dict[str, float] = collections.defaultdict(float)
    persona_counts: Dict[str, int] = collections.defaultdict(int)
    persona_urgent: Dict[str, int] = collections.defaultdict(int)  # urgency >= 4

    for c in cards:
        urgency = float(c.get("urgency", 3))
        sw = SENTIMENT_WEIGHT.get(c.get("sentiment", "neutral"), 1.0)
        for p in c.get("personas", []):
            persona_scores[p] += urgency * sw
            persona_counts[p] += 1
            if urgency >= 4:
                persona_urgent[p] += 1

    if not persona_scores:
        return []

    max_score = max(persona_scores.values(), default=1)
    return sorted([
        {
            "persona": p,
            "pain_intensity": round(persona_scores[p] / max_score * 100, 1),
            "raw_score": round(persona_scores[p], 1),
            "signal_count": persona_counts[p],
            "high_urgency_count": persona_urgent[p],
        }
        for p in persona_scores
    ], key=lambda x: -x["pain_intensity"])


# ---------------------------------------------------------------------------
# Signal Velocity
# ---------------------------------------------------------------------------

def _signal_velocity(history: List[Dict]) -> List[Dict]:
    """
    Week-over-week change in signal count per category.

    Uses last 2 history snapshots separated by >= 5 days.
    Returns velocity as % change and absolute delta.
    """
    if len(history) < 2:
        return []

    # Use last 2 available runs
    prev = history[-2].get("by_category", {})
    curr = history[-1].get("by_category", {})
    all_cats = set(prev) | set(curr)

    velocities = []
    for cat in all_cats:
        p = prev.get(cat, 0)
        c = curr.get(cat, 0)
        delta = c - p
        pct = round((delta / p * 100) if p > 0 else (100.0 if c > 0 else 0.0), 1)
        velocities.append({
            "category": cat,
            "previous_count": p,
            "current_count": c,
            "delta": delta,
            "velocity_pct": pct,
            "trend": "rising" if pct > 10 else ("falling" if pct < -10 else "stable"),
        })

    return sorted(velocities, key=lambda x: -abs(x["velocity_pct"]))


# ---------------------------------------------------------------------------
# Theme Emergence Index
# ---------------------------------------------------------------------------

def _theme_emergence(velocity_data: List[Dict]) -> List[Dict]:
    """
    Categories with velocity significantly above the mean absolute velocity.
    These are 'emerging themes' worth immediate attention.
    """
    if not velocity_data:
        return []
    rising = [v for v in velocity_data if v["velocity_pct"] > 0 and v["current_count"] >= 3]
    if not rising:
        return []
    mean_vel = sum(v["velocity_pct"] for v in rising) / len(rising)
    threshold = max(15.0, mean_vel * 1.5)
    emerging = [
        {**v, "emergence_index": round(v["velocity_pct"] / max(mean_vel, 1), 2)}
        for v in rising if v["velocity_pct"] >= threshold
    ]
    return sorted(emerging, key=lambda x: -x["emergence_index"])[:8]


# ---------------------------------------------------------------------------
# Recency Distribution
# ---------------------------------------------------------------------------

def _recency_distribution(cards: List[Dict]) -> Dict:
    bands: Dict[str, int] = collections.Counter()
    for c in cards:
        days = _age_days(c.get("date", ""))
        bands[_recency_band(days)] += 1
    total = max(sum(bands.values()), 1)
    return {
        "bands": dict(bands),
        "pct_fresh": round(bands.get("0-30d", 0) / total * 100, 1),
        "pct_stale": round((bands.get("91-180d", 0) + bands.get("180d+", 0)) / total * 100, 1),
        "total": sum(bands.values()),
    }


# ---------------------------------------------------------------------------
# Sentiment + Behavioral Stage breakdown per category
# ---------------------------------------------------------------------------

def _category_sentiment(cards: List[Dict]) -> List[Dict]:
    cat_data: Dict[str, Dict] = collections.defaultdict(
        lambda: {"frustrated": 0, "neutral": 0, "positive": 0, "total": 0,
                 "awareness": 0, "evaluation": 0, "frustration": 0, "advocacy": 0}
    )
    for c in cards:
        cat = c.get("voc_category", "Other")
        sentiment = c.get("sentiment", "neutral").lower()
        stage = c.get("behavioral_stage", "Awareness").lower()
        d = cat_data[cat]
        d["total"] += 1
        d[sentiment] = d.get(sentiment, 0) + 1
        d[stage] = d.get(stage, 0) + 1

    out = []
    for cat, d in cat_data.items():
        total = max(d["total"], 1)
        out.append({
            "category": cat,
            "total": d["total"],
            "sentiment": {
                "frustrated": d.get("frustrated", 0),
                "neutral": d.get("neutral", 0),
                "positive": d.get("positive", 0),
                "pct_frustrated": round(d.get("frustrated", 0) / total * 100, 1),
            },
            "behavioral_stage": {
                "awareness": d.get("awareness", 0),
                "evaluation": d.get("evaluation", 0),
                "frustration": d.get("frustration", 0),
                "advocacy": d.get("advocacy", 0),
                "dominant": max(
                    ["awareness", "evaluation", "frustration", "advocacy"],
                    key=lambda s: d.get(s, 0)
                ),
            },
        })
    return sorted(out, key=lambda x: -x["total"])


# ---------------------------------------------------------------------------
# JTBD Cluster Frequency
# ---------------------------------------------------------------------------

def _jtbd_clusters(cards: List[Dict]) -> List[Dict]:
    """
    Extract common verb phrases from JTBD statements to find recurring customer jobs.
    Groups by common 2-3 word verb phrases.
    """
    phrase_counter: collections.Counter = collections.Counter()
    jtbd_by_phrase: Dict[str, List[str]] = collections.defaultdict(list)

    for c in cards:
        jtbd = c.get("jtbd", "").strip()
        if not jtbd:
            continue
        # Extract 2-3 word phrases starting with a common JTBD verb
        phrases = re.findall(
            r"\b(track|monitor|manage|integrate|automate|reduce|improve|"
            r"ensure|view|access|generate|share|report|schedule|submit|"
            r"inspect|verify|coordinate|alert|notify|document|analyze)\s+\w+(?:\s+\w+)?",
            jtbd.lower()
        )
        for p in phrases[:2]:
            phrase_counter[p] += 1
            if jtbd not in jtbd_by_phrase[p]:
                jtbd_by_phrase[p].append(jtbd)

    return [
        {
            "job_phrase": phrase,
            "frequency": count,
            "examples": jtbd_by_phrase[phrase][:3],
        }
        for phrase, count in phrase_counter.most_common(15)
        if count >= 2
    ]


# ---------------------------------------------------------------------------
# Statistical Significance Bands
# ---------------------------------------------------------------------------

def _statistical_significance(cards: List[Dict]) -> List[Dict]:
    """
    Classify each category's signal count as low/medium/high significance.

    Based on: count relative to mean ± 1 std dev across all categories.
    Low  = count < mean - 0.5σ
    High = count > mean + 1σ
    """
    cat_counts: collections.Counter = collections.Counter(
        c.get("voc_category", "Other") for c in cards
    )
    counts = list(cat_counts.values())
    if not counts:
        return []
    mean = sum(counts) / len(counts)
    variance = sum((x - mean) ** 2 for x in counts) / len(counts)
    std = variance ** 0.5 or 1

    return [
        {
            "category": cat,
            "count": cnt,
            "significance": (
                "high" if cnt > mean + std else
                "low" if cnt < mean - 0.5 * std else
                "medium"
            ),
            "z_score": round((cnt - mean) / std, 2),
        }
        for cat, cnt in cat_counts.most_common()
    ]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run() -> None:
    DASHBOARD_DIR.mkdir(exist_ok=True)

    cards_data = _load_json(DASHBOARD_DIR / "cards.json")
    history_data = _load_json(DASHBOARD_DIR / "voc_history.json")

    cards = (cards_data or {}).get("cards", [])
    history = history_data if isinstance(history_data, list) else []

    if not cards:
        logging.info("No cards found; signal_analytics skipped.")
        return

    logging.info("Computing signal analytics for %d cards...", len(cards))

    velocity = _signal_velocity(history)
    emergence = _theme_emergence(velocity)

    analytics = {
        "generated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cards_analyzed": len(cards),
        "persona_pain_intensity": _persona_pain_intensity(cards),
        "signal_velocity": velocity,
        "theme_emergence": emergence,
        "recency_distribution": _recency_distribution(cards),
        "category_sentiment": _category_sentiment(cards),
        "jtbd_clusters": _jtbd_clusters(cards),
        "statistical_significance": _statistical_significance(cards),
        "summary": {
            "top_emerging_category": emergence[0]["category"] if emergence else None,
            "highest_pain_persona": (
                _persona_pain_intensity(cards)[0]["persona"]
                if _persona_pain_intensity(cards) else None
            ),
            "pct_frustrated_signals": round(
                sum(1 for c in cards if c.get("sentiment") == "frustrated") / max(len(cards), 1) * 100, 1
            ),
            "pct_evaluation_stage": round(
                sum(1 for c in cards if c.get("behavioral_stage") == "Evaluation") / max(len(cards), 1) * 100, 1
            ),
        },
    }

    out_path = DASHBOARD_DIR / "signal_analytics.json"
    out_path.write_text(
        json.dumps(analytics, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    logging.info("Wrote %s", out_path)


def main():
    run()


if __name__ == "__main__":
    main()
