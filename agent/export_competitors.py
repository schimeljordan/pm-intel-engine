"""Export competitor battlecard data to the dashboard.

Historically the dashboard loaded ``competitors.json`` which was generated
manually from ``data/competitors.yaml``.  The front‑end now also looks for a
``battlecard.json`` file, so we emit *both* filenames with identical content.
This allows the summarisation pipeline to update the competitive battle card in
one step while maintaining backwards compatibility for existing consumers.
"""
from __future__ import annotations

import json
import os
import time
from typing import Dict, Any, Iterable

import yaml

def _resolve_paths() -> tuple[str, list[str]]:
    cfg_path = os.environ.get("CONFIG_PATH", "config.yaml")
    try:
        cfg = yaml.safe_load(open(cfg_path, "r", encoding="utf-8")) or {}
    except Exception:
        cfg = {}
    src = cfg.get("competitors_path", os.path.join("data", "competitors.yaml"))
    dash = os.environ.get("DASHBOARD_PATH", "dashboard")
    return src, [os.path.join(dash, "competitors.json"), os.path.join(dash, "battlecard.json")]

# Keys expected in the battlecard output.  These are the fields rendered by the
# dashboard (pricing, value props, bullets, etc.).  Historically only the keys
# present in the YAML were emitted, which meant many vendors were missing
# fields and the front‑end would display ``undefined``.  We pre‑seed every
# competitor with these fields so the JSON always contains the complete schema
# the summariser/agent expects.
KNOWN_KEYS = {
    "url",
    "pricing",
    "positives",
    "negatives",
    "opportunities",
    "weaknesses",
    "primary_value",
    "key_customer",
    "payer",
    "notes",
    "category",        # competitor category grouping
    "core_competency", # their #1 differentiator
    "watch_out_for",   # their key strengths (replaces positives semantically)
    "opportunity",     # how to beat them (replaces opportunities semantically)
}

# Personas shown as separate columns in the battlecard table.
PERSONA_KEYS = [
    "fire_chief",
    "fire_marshal",
    "fire_inspector",
    "facility_manager",
    "ahj",
    "building_owner",   # used by Compliance Engine, IROL, Inspect Point, etc.
    "esd",              # used by First Due, Tablet Command
]

def main() -> None:
    SRC, OUT_FILES = _resolve_paths()
    if not os.path.exists(SRC):
        print(f"Missing {SRC}")
        return
    raw = yaml.safe_load(open(SRC, "r", encoding="utf-8")) or {}
    comps = []
    for name, info in (raw.get("competitors") or {}).items():
        if not isinstance(info, dict):
            continue

        # Start with a skeleton containing every expected field so the
        # downstream summariser/agent always has something to display.
        comp: Dict[str, Any] = {
            "name": name,
            **{k: "" for k in KNOWN_KEYS if k not in {"positives","negatives","opportunities","weaknesses","watch_out_for","opportunity"}},
            "positives": [],
            "negatives": [],
            "opportunities": [],
            "weaknesses": [],
            "watch_out_for": [],
            "opportunity": [],
            "personas": {k: "" for k in PERSONA_KEYS},
        }

        # Overlay any values supplied in the YAML.
        for k in KNOWN_KEYS:
            if k in info:
                comp[k] = info[k]

        # Remaining keys are persona annotations.
        for k, v in info.items():
            if k not in KNOWN_KEYS:
                comp["personas"][k] = v

        # Backward-compat: promote legacy field names to new schema names.
        if not comp["watch_out_for"] and comp["positives"]:
            comp["watch_out_for"] = comp["positives"]
        if not comp["opportunity"] and comp["opportunities"]:
            comp["opportunity"] = comp["opportunities"]

        comps.append(comp)
    out = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "competitors": comps,
    }

    # Write to each output path so the dashboard can load whichever filename it
    # prefers.  This keeps the schema uniform and ensures new vendors or field
    # updates are reflected everywhere without manual copying.
    for path in OUT_FILES:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"Wrote {path}")

if __name__ == "__main__":
    main()
