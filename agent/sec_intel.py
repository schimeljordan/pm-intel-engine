"""agent/sec_intel.py — SEC EDGAR filings (8-K, 10-Q, 10-K, S-1) for fire-safety competitors.

SEC's data.sec.gov is open but requires a descriptive User-Agent and <=10 req/sec.
We sleep 0.15s between requests to stay well within the limit.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests
import yaml

OUT_DIR = Path(os.environ.get("DASHBOARD_PATH", "dashboard"))
HEADERS = {"User-Agent": "FireIntelAgent/1.0 (jordan.schimel@gmail.com)"}
TIMEOUT = 15

COMPETITOR_CIKS = {
    "Johnson Controls": "0000833444",
    "Carrier Global (Kidde)": "0001783398",
    "MSA Safety": "0000066570",
    "Napco Security": "0000069633",
    "Alarm.com": "0001618463",
}

FORM_TYPES = {"8-K", "10-Q", "10-K", "S-1"}
MA_ITEMS = {"1.01", "2.01", "8.01"}  # material agreements / acquisitions / other events
LOOKBACK_DAYS = 90


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _load_competitor_ciks() -> Dict[str, str]:
    """Merge hardcoded CIKs with any cik fields found in config/competitors files."""
    ciks: Dict[str, str] = dict(COMPETITOR_CIKS)
    # data/competitors.yaml uses a dict keyed by competitor name.
    comp_path = Path("data/competitors.yaml")
    if comp_path.exists():
        try:
            data = yaml.safe_load(comp_path.read_text(encoding="utf-8")) or {}
            for name, info in (data.get("competitors") or {}).items():
                if isinstance(info, dict) and info.get("cik"):
                    ciks[name] = str(info["cik"]).zfill(10)
        except Exception as e:
            print(f"[sec_intel] could not read competitors.yaml: {e}")
    # config.yaml may define sec_edgar_competitors as a list.
    cfg_path = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
    if cfg_path.exists():
        try:
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            for entry in cfg.get("sec_edgar_competitors") or []:
                if isinstance(entry, dict) and entry.get("cik") and entry.get("name"):
                    ciks[entry["name"]] = str(entry["cik"]).zfill(10)
        except Exception as e:
            print(f"[sec_intel] could not read config sec_edgar_competitors: {e}")
    return ciks


def _cutoff_date() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - LOOKBACK_DAYS * 86400))


def _fetch_company(name: str, cik: str, cutoff: str) -> Dict[str, Any]:
    cik = str(cik).zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    r = requests.get(url, timeout=TIMEOUT, headers=HEADERS)
    r.raise_for_status()
    data = r.json() or {}
    recent = ((data.get("filings") or {}).get("recent")) or {}
    forms = recent.get("form") or []
    dates = recent.get("filingDate") or []
    accessions = recent.get("accessionNumber") or []
    primary_docs = recent.get("primaryDocument") or []
    primary_desc = recent.get("primaryDocDescription") or []
    items_col = recent.get("items") or []

    filings: List[Dict[str, Any]] = []
    for i, form in enumerate(forms):
        if form not in FORM_TYPES:
            continue
        fdate = dates[i] if i < len(dates) else ""
        if fdate and fdate < cutoff:
            continue
        acc = (accessions[i] if i < len(accessions) else "").replace("-", "")
        doc = primary_docs[i] if i < len(primary_docs) else ""
        items = items_col[i] if i < len(items_col) else ""
        item_list = [s.strip() for s in str(items).split(",") if s.strip()]
        is_ma = any(it in MA_ITEMS for it in item_list)
        filing_url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/{doc}"
            if acc and doc else f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}"
        )
        filings.append({
            "form": form,
            "date": fdate,
            "description": (primary_desc[i] if i < len(primary_desc) else "") or form,
            "url": filing_url,
            "items": item_list,
            "is_ma_signal": is_ma,
        })

    return {
        "name": name,
        "cik": cik,
        "recent_filings": filings,
        "latest_10k_revenue": None,
        "filing_count_90d": len(filings),
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "sec_intel.json"
    cutoff = _cutoff_date()
    ciks = _load_competitor_ciks()

    companies: List[Dict[str, Any]] = []
    errors: List[str] = []
    for name, cik in ciks.items():
        try:
            companies.append(_fetch_company(name, cik, cutoff))
            print(f"[sec_intel] {name}: ok")
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"[sec_intel] {name} failed: {e}")
            companies.append({
                "name": name, "cik": str(cik).zfill(10),
                "recent_filings": [], "latest_10k_revenue": None, "filing_count_90d": 0,
            })
        time.sleep(0.15)

    out: Dict[str, Any] = {"generated_at": _now(), "companies": companies}
    if errors and not any(c["recent_filings"] for c in companies):
        out["error"] = "; ".join(errors)

    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[sec_intel] wrote {out_path} ({len(companies)} companies)")


if __name__ == "__main__":
    main()
