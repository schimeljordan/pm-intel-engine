"""agent/export_pm_hub.py — PM Hub: Regulatory Radar, Feature Gap Map,
Technology Signals, M&A Targets, Strategic Horizons, PRD Seeds.

Reads pre-computed dashboard JSON and competitors.yaml, then exports
dashboard/pm_hub.json for the PM Hub tab.

No LLM calls in this module — all synthesis is deterministic from existing
pipeline outputs. LLM enrichment already happened in summariser.py.
"""
from __future__ import annotations

import collections
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="export_pm_hub %(levelname)s: %(message)s",
)

DASHBOARD_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
DATA_DIR      = Path("data")

# Regulatory / standards keywords → standard name mapping
REGULATORY_KEYWORDS: Dict[str, str] = {
    "nfpa 72": "NFPA 72",
    "nfpa 13": "NFPA 13",
    "nfpa 25": "NFPA 25",
    "nfpa 10": "NFPA 10",
    "nfpa 101": "NFPA 101",
    "nfpa 1": "NFPA 1",
    "nfpa 1300": "NFPA 1300",
    "ifc": "IFC",
    "ibc": "IBC",
    "en 54": "EN 54",
    "en54": "EN 54",
    "bs 5839": "BS 5839",
    "bs5839": "BS 5839",
    "as 1851": "AS 1851",
}

# Technology levers → horizon estimate
LEVER_HORIZONS = {
    "Integration/API":              "near",
    "Workflow Automation":          "near",
    "Decision Support / Analytics": "mid",
    "LLM / Knowledge":              "mid",
    "Computer Vision / Sensing":    "long",
}

# Category → capabilities a vendor in this space likely provides
CATEGORY_CAPABILITY_HINTS: Dict[str, List[str]] = {
    "Inspections & Compliance":      ["inspection", "itm", "deficiency", "compliance", "permit"],
    "Data & System Integration":     ["api", "integration", "webhook", "cad", "rms", "sync"],
    "Communication & Coordination":  ["dispatch", "incident command", "radio", "notification"],
    "Operations & Training":         ["training", "eLearning", "drill", "curriculum"],
    "Facilities / Built Environment":["alarm", "sprinkler", "fire panel", "device"],
    "Community Risk Reduction":      ["crr", "public education", "risk reduction", "smoke alarm"],
    "Wildland/WUI":                  ["wildland", "wildfire", "wui", "evacuation"],
    "Standards & Codes (NFPA/ICC)":  ["nfpa", "code", "standard", "compliance"],
    "Procurement / Grants / Funding":["grant", "procurement", "rfp", "funding"],
}


def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logging.warning("Could not load %s: %s", path, e)
        return None


def _load_yaml(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        logging.warning("Could not load %s: %s", path, e)
        return None


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _detect_standards(text: str) -> List[str]:
    t = text.lower()
    return sorted({label for kw, label in REGULATORY_KEYWORDS.items() if kw in t})


# ---------------------------------------------------------------------------
# Regulatory Radar
# ---------------------------------------------------------------------------

def build_regulatory_radar(cards: List[Dict]) -> List[Dict]:
    """Extract signals about standards/code changes and map to product opportunities."""
    regulatory_cards = [
        c for c in cards
        if c.get("voc_category") in (
            "Standards & Codes (NFPA/ICC)",
            "Standards & Codes",
        ) or _detect_standards(f"{c.get('title','')} {c.get('one_liner','')}")
    ]

    # Dedupe by URL
    seen: set = set()
    items: List[Dict] = []
    for c in sorted(regulatory_cards, key=lambda x: -x.get("opportunity_score", 0)):
        if c["url"] in seen:
            continue
        seen.add(c["url"])
        standards = _detect_standards(f"{c.get('title','')} {c.get('summary','')} {c.get('one_liner','')}")
        items.append({
            "title":               c["title"],
            "url":                 c["url"],
            "date":                c.get("date", ""),
            "domain":              c.get("domain", ""),
            "standards":           standards,
            "summary":             c.get("one_liner") or c.get("summary", ""),
            "why":                 c.get("why", ""),
            "urgency":             c.get("urgency", 3),
            "jtbd":                c.get("jtbd", ""),
            "inference_level":     c.get("inference_level", "inferred"),
            "confidence":          c.get("confidence", 50),
            "opportunity_score":   c.get("opportunity_score", 50),
            # Infer geographic scope from domain/keywords
            "region": (
                "eu"  if any(kw in c.get("domain","").lower() for kw in ["uk","eu","ifsec","cfpa","ife"])
                else "apac" if any(kw in c.get("domain","").lower() for kw in ["afac","scdf","asia"])
                else "us"
            ),
        })
    return items[:40]


# ---------------------------------------------------------------------------
# Feature Gap Map
# ---------------------------------------------------------------------------

def build_feature_gap_map(cards: List[Dict], overview: Dict, competitors_yaml: Dict) -> Dict:
    """Matrix of VOC pain categories × competitors showing coverage and demand."""
    # Top 8 pain categories by signal count
    cat_counts: Dict[str, int] = collections.Counter(c.get("voc_category", "") for c in cards)
    top_cats = [cat for cat, _ in cat_counts.most_common(8) if cat and cat != "Other / Not Relevant"]

    comps = competitors_yaml.get("competitors") or {}
    # Limit to top 12 competitors by mention count
    comp_names = list(comps.keys())[:20]

    matrix: Dict[str, Dict[str, Any]] = {}
    for cat in top_cats:
        hints = CATEGORY_CAPABILITY_HINTS.get(cat, [])
        matrix[cat] = {}
        for name in comp_names:
            comp = comps.get(name) or {}
            # Build searchable text from competitor profile
            blob = " ".join([
                str(comp.get("core_competency", "")),
                str(comp.get("primary_value", "")),
                " ".join(str(p) for p in (comp.get("positives") or [])),
                str(comp.get("fire_inspector") or comp.get("fire_marshal") or ""),
            ]).lower()
            # Signal: does the competitor's profile mention this category's capabilities?
            coverage_hits = sum(1 for h in hints if h in blob)
            has_signal = coverage_hits >= 1
            matrix[cat][name] = {
                "coverage":   "strong" if coverage_hits >= 2 else ("weak" if has_signal else "none"),
                "voc_demand": cat_counts.get(cat, 0),
            }

    # Gap score per category: high demand + few competitors with strong coverage = big gap
    gaps: List[Dict] = []
    for cat in top_cats:
        covered_strong = sum(
            1 for name in comp_names
            if matrix[cat].get(name, {}).get("coverage") == "strong"
        )
        demand = cat_counts.get(cat, 0)
        gap_score = round(demand * max(0, (len(comp_names) - covered_strong) / max(len(comp_names), 1)), 1)
        gaps.append({
            "category":        cat,
            "voc_demand":      demand,
            "strong_coverage": covered_strong,
            "gap_score":       gap_score,
        })
    gaps.sort(key=lambda g: -g["gap_score"])

    return {
        "categories":  top_cats,
        "competitors": comp_names,
        "matrix":      matrix,
        "gaps":        gaps,
        "note":        "Coverage reflects competitor profile text — signals suggest coverage, not confirmed capability.",
    }


# ---------------------------------------------------------------------------
# Technology Signals
# ---------------------------------------------------------------------------

def build_technology_signals(cards: List[Dict]) -> List[Dict]:
    """Surface cards with strong AI/tech levers, grouped by horizon."""
    tech_cards = [
        c for c in cards
        if c.get("ai_lever") and c.get("ai_lever") != "Other / None"
        and c.get("data_quality") != "insufficient"
    ]
    tech_cards.sort(key=lambda c: (-c.get("urgency", 3), -c.get("opportunity_score", 0)))

    seen: set = set()
    items: List[Dict] = []
    for c in tech_cards:
        if c["url"] in seen:
            continue
        seen.add(c["url"])
        lever = c.get("ai_lever", "Other / None")
        items.append({
            "title":           c["title"],
            "url":             c["url"],
            "date":            c.get("date", ""),
            "ai_lever":        lever,
            "horizon":         LEVER_HORIZONS.get(lever, "mid"),
            "summary":         c.get("one_liner") or c.get("summary", ""),
            "why":             c.get("why", ""),
            "urgency":         c.get("urgency", 3),
            "personas":        c.get("personas", []),
            "jtbd":            c.get("jtbd", ""),
            "inference_level": c.get("inference_level", "inferred"),
            "confidence":      c.get("confidence", 50),
        })
    return items[:30]


# ---------------------------------------------------------------------------
# M&A Targets
# ---------------------------------------------------------------------------

def build_ma_targets(competitors_yaml: Dict, pending_data: Optional[Dict],
                     cards: List[Dict]) -> List[Dict]:
    """Identify potential M&A / acquisition targets: startups with high signal velocity
    but minimal profile (unknown pricing, empty key_customer fields)."""
    comps = competitors_yaml.get("competitors") or {}

    # Count mentions per competitor in cards
    mention_counts: Dict[str, int] = collections.Counter()
    for c in cards:
        blob = f"{c.get('title','')} {c.get('one_liner','')} {c.get('summary','')}".lower()
        for name in comps:
            if name.lower() in blob:
                mention_counts[name] += 1

    targets: List[Dict] = []
    for name, data in comps.items():
        pricing = str(data.get("pricing", "") or "").strip()
        key_customer = str(data.get("key_customer", "") or "").strip()
        notes = str(data.get("notes", "") or "").strip()
        is_auto = "auto-discovered" in notes.lower() or "auto-approved" in notes.lower()
        mentions = mention_counts.get(name, 0)

        # Target profile: unknown/minimal profile + appearing in signals
        if (not pricing or "unknown" in pricing.lower() or "needs research" in pricing.lower()) \
                and mentions >= 1:
            ma_score = mentions * 10
            if is_auto:
                ma_score += 5  # recency signal
            targets.append({
                "name":         name,
                "url":          data.get("url", ""),
                "signal_count": mentions,
                "ma_score":     ma_score,
                "pricing":      pricing or "Unknown",
                "primary_value": data.get("primary_value", ""),
                "notes":        notes,
                "signals": [
                    {
                        "title": c["title"],
                        "url":   c["url"],
                        "date":  c.get("date",""),
                    }
                    for c in cards
                    if name.lower() in f"{c.get('title','')} {c.get('one_liner','')}".lower()
                ][:5],
            })

    # Also surface pending competitor suggestions as M&A prospects
    if pending_data:
        for item in (pending_data.get("items") or []):
            if item.get("category") == "competitor":
                n = item.get("name", "")
                if n and n not in comps:
                    targets.append({
                        "name":         n,
                        "url":          item.get("url", ""),
                        "signal_count": 0,
                        "ma_score":     item.get("confidence", 50),
                        "pricing":      "Unknown",
                        "primary_value": item.get("reasoning", "Emerging from signals"),
                        "notes":        f"AI-suggested on {item.get('suggested_at','')[:10]}",
                        "signals":      [],
                    })

    targets.sort(key=lambda t: -t["ma_score"])
    return targets[:20]


# ---------------------------------------------------------------------------
# Strategic Horizons
# ---------------------------------------------------------------------------

def build_strategic_horizons(cards: List[Dict], overview: Dict,
                              strategic_summary: Optional[Dict]) -> Dict:
    """Build quarterly and 3-year strategic horizon views from signal data."""

    # Quarterly: top pain categories with urgency ≥ 4
    high_urgency = [c for c in cards if c.get("urgency", 3) >= 4]
    quarterly_cats: Dict[str, int] = collections.Counter(
        c.get("voc_category", "") for c in high_urgency if c.get("voc_category")
    )
    quarterly_focus = [
        {
            "category":  cat,
            "count":     count,
            "urgency_label": "Critical" if count > 10 else "High",
            "top_jtbd":  next(
                (c.get("jtbd","") for c in high_urgency
                 if c.get("voc_category") == cat and c.get("jtbd")), ""
            ),
        }
        for cat, count in quarterly_cats.most_common(5)
    ]

    # 3-year: emerging themes (low velocity now, but novel AI lever)
    emerging_levers: Dict[str, int] = collections.Counter(
        c.get("ai_lever","") for c in cards
        if c.get("ai_lever") in ("LLM / Knowledge", "Computer Vision / Sensing")
    )
    three_year_bets = [
        {"ai_lever": lever, "signal_count": count}
        for lever, count in emerging_levers.most_common(5)
    ]

    # Tech shifts: categories growing in new signals vs overall
    cutoff_ts = time.time() - 30 * 24 * 3600
    recent_cats: Dict[str, int] = collections.Counter()
    for c in cards:
        date_str = c.get("date", "")
        if date_str:
            try:
                import datetime
                for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
                    try:
                        ts = datetime.datetime.strptime(date_str[:len(fmt)], fmt)
                        if ts.timestamp() > cutoff_ts:
                            recent_cats[c.get("voc_category","")] += 1
                        break
                    except ValueError:
                        continue
            except Exception:
                pass

    tech_shifts = [
        {"category": cat, "recent_30d": count}
        for cat, count in recent_cats.most_common(3)
        if cat and cat != "Other / Not Relevant"
    ]

    # Pull top insights from strategic_summary if available
    strategic_insights = []
    if strategic_summary and strategic_summary.get("available"):
        strategic_insights = strategic_summary.get("top_insights", [])

    return {
        "quarterly_focus": quarterly_focus,
        "three_year_bets": three_year_bets,
        "tech_shifts_30d": tech_shifts,
        "strategic_insights": strategic_insights,
        "contradictions": (strategic_summary or {}).get("contradictions", []),
        "watch_signals": (strategic_summary or {}).get("watch_signals", ""),
        "confidence": (strategic_summary or {}).get("confidence", 0),
        "note": "Signals suggest these trends — based on signal patterns, not confirmed market data.",
    }


# ---------------------------------------------------------------------------
# PRD Seeds
# ---------------------------------------------------------------------------

def build_prd_seeds(cards: List[Dict]) -> List[Dict]:
    """Per-persona grouped job statements for PRD drafting."""
    persona_cards: Dict[str, List[Dict]] = collections.defaultdict(list)
    for c in cards:
        if c.get("data_quality") == "insufficient":
            continue
        for p in (c.get("personas") or []):
            persona_cards[p].append(c)

    seeds: List[Dict] = []
    for persona, pcards in sorted(persona_cards.items(), key=lambda x: -len(x[1])):
        if len(pcards) < 3:
            continue

        # Top JTBDs
        jtbd_counts: Dict[str, int] = collections.Counter(
            c.get("jtbd", "") for c in pcards if c.get("jtbd")
        )
        top_jtbds = [j for j, _ in jtbd_counts.most_common(3)]

        # Top pains (why fields)
        top_pains = [
            c.get("why", "")
            for c in sorted(pcards, key=lambda x: -x.get("urgency", 3))
            if c.get("why") and c.get("why") not in ("Heuristic fallback", "Heuristic (no OpenAI key)")
        ][:5]

        # Urgency distribution
        urgencies = [c.get("urgency", 3) for c in pcards]
        avg_urgency = round(sum(urgencies) / len(urgencies), 1)

        # Top parity caps (capabilities competitors have)
        all_caps: List[str] = []
        for c in pcards:
            all_caps.extend(c.get("parity_caps", []))
        top_caps = [cap for cap, _ in collections.Counter(all_caps).most_common(5)]

        # Top signals
        top_signals = [
            {"title": c["title"], "url": c["url"], "jtbd": c.get("jtbd",""), "urgency": c.get("urgency",3)}
            for c in sorted(pcards, key=lambda x: -x.get("opportunity_score", 0))[:5]
        ]

        seeds.append({
            "persona":              persona,
            "signal_count":         len(pcards),
            "avg_urgency":          avg_urgency,
            "top_jtbds":            top_jtbds,
            "top_pains":            top_pains,
            "parity_capabilities":  top_caps,
            "top_signals":          top_signals,
            "note": (
                "Draft PRD sections from these seeds — top_jtbds become user stories, "
                "top_pains become problem statements, parity_capabilities become acceptance criteria seeds."
            ),
        })

    seeds.sort(key=lambda s: (-s["avg_urgency"], -s["signal_count"]))
    return seeds[:10]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run() -> None:
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    _cfg = _load_yaml(Path(cfg_path)) or {}
    competitors_path = _cfg.get("competitors_path", str(DATA_DIR / "competitors.yaml"))
    cards_data  = _load_json(DASHBOARD_DIR / "cards.json")
    overview    = _load_json(DASHBOARD_DIR / "voc_overview.json") or {}
    comps_yaml  = _load_yaml(Path(competitors_path)) or {}
    strategic   = _load_json(DASHBOARD_DIR / "strategic_summary.json")
    pending     = _load_json(DASHBOARD_DIR / "pending_suggestions.json")

    cards: List[Dict] = (cards_data or {}).get("cards") or []
    if not cards:
        logging.info("No cards found — writing empty pm_hub.json")
        (DASHBOARD_DIR / "pm_hub.json").write_text(
            json.dumps({"generated_at": _now(), "available": False, "note": "No VOC signals yet."}, indent=2),
            encoding="utf-8",
        )
        return

    logging.info("Building PM Hub from %d cards...", len(cards))

    hub = {
        "generated_at":       _now(),
        "available":          True,
        "signal_count":       len(cards),
        "regulatory_radar":   build_regulatory_radar(cards),
        "feature_gap_map":    build_feature_gap_map(cards, overview, comps_yaml),
        "technology_signals": build_technology_signals(cards),
        "ma_targets":         build_ma_targets(comps_yaml, pending, cards),
        "strategic_horizons": build_strategic_horizons(cards, overview, strategic),
        "prd_seeds":          build_prd_seeds(cards),
    }

    out = DASHBOARD_DIR / "pm_hub.json"
    out.write_text(json.dumps(hub, ensure_ascii=False, indent=2), encoding="utf-8")
    logging.info(
        "Wrote pm_hub.json: %d regulatory, %d tech signals, %d M&A targets, %d PRD seeds",
        len(hub["regulatory_radar"]),
        len(hub["technology_signals"]),
        len(hub["ma_targets"]),
        len(hub["prd_seeds"]),
    )


def main() -> None:
    run()


if __name__ == "__main__":
    main()
