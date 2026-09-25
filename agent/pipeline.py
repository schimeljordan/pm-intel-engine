from __future__ import annotations
import subprocess, sys, logging, os

logging.basicConfig(level=os.environ.get("LOGLEVEL","INFO"),
                    format="pipeline %(levelname)s: %(message)s")

# Steps: (module, enabled, critical)
# critical=True → pipeline exits non-zero if step fails, surfacing CI failure.
# critical=False → step failure is logged but execution continues.
STEPS = [
    ("agent.scraper",              True,  False),  # FIX 1.1: RSS/page ingest (was never called)
    ("agent.reddit_ingest",        True,  False),  # self-skips if env missing
    ("agent.web_search",           True,  False),  # self-skips gracefully on network error
    ("agent.gdelt_intel",          True,  False),  # NEW: GDELT trade-press monitoring (feeds pages table)
    ("agent.fema_intel",           True,  False),  # NEW: FEMA disaster declarations + grants
    ("agent.sec_intel",            True,  False),  # NEW: SEC EDGAR competitor filings
    ("agent.patent_intel",         True,  False),  # NEW: PatentsView fire-safety patents
    ("agent.wildfire_intel",       True,  False),  # NEW: NOAA red-flag warnings + NIFC fires
    ("agent.grants_intel",         True,  False),  # NEW: Grants.gov + USASpending AFG/SAFER
    ("agent.app_store_intel",      True,  False),  # NEW: Apple iTunes competitor app reviews
    ("agent.ecfr_intel",           True,  False),  # NEW: eCFR OSHA/FEMA amendment monitoring
    ("agent.nfirs_intel",          True,  False),  # NEW: NFIRS 2022-2024 annual data (self-skips if current)
    ("agent.agentic_ai_intel",     True,  False),  # NEW: agentic-AI landscape (HF/ArXiv/GitHub/GDELT/RSS)
    ("agent.export_latest",        True,  True),   # required: downstream depends on latest.json
    ("agent.summariser",           True,  True),   # required: produces cards.json / voc_overview.json
    ("agent.signal_analytics",     True,  False),  # behavioral research layer (advisory)
    ("agent.export_competitors",   True,  False),  # competitive battlecard refresh
    ("agent.export_competitor_news", True, False), # competitor news digest
    ("agent.ai_publications",      True,  False),  # industry pubs feed (cutting_edge.json)
    ("agent.export_pm_hub",        True,  False),  # PM hub: regulatory radar, gap map, M&A, PRD seeds
    ("agent.build_dashboard",      True,  True),   # required: produces domain.json / sources_config.json
    ("agent.notify",               True,  False),  # webhook push (advisory)
    ("agent.self_improve",         True,  False),  # agentic: discover new sources/queries
]

def _run(mod: str, env: dict | None = None) -> None:
    logging.info("==> Running: python -m %s", mod)
    run_env = {**os.environ, **(env or {})}
    subprocess.run([sys.executable, "-m", mod], check=True, env=run_env)

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Fire Intel pipeline runner")
    parser.add_argument("--domain", default="",
        help="Path to a domain config YAML (e.g. configs/cmms-market.yaml). "
             "When set, sets FIRE_INTEL_CONFIG env var for every step so "
             "domain-aware modules use the correct config.")
    args, _ = parser.parse_known_args()

    domain_env: dict = {}
    if args.domain:
        logging.info("Domain config override: %s", args.domain)
        domain_env["FIRE_INTEL_CONFIG"] = args.domain
    elif os.environ.get("FIRE_INTEL_CONFIG"):
        domain_env["FIRE_INTEL_CONFIG"] = os.environ["FIRE_INTEL_CONFIG"]
        logging.info("Domain config from env: %s", domain_env["FIRE_INTEL_CONFIG"])

    critical_failures: list[str] = []

    for mod, enabled, critical in STEPS:
        if not enabled:
            continue
        try:
            _run(mod, env=domain_env if domain_env else None)
        except subprocess.CalledProcessError:
            if critical:
                logging.error("CRITICAL step failed: %s — downstream steps may produce stale data", mod)
                critical_failures.append(mod)
            else:
                logging.warning("Non-critical step failed: %s (continuing)", mod)

    if critical_failures:
        logging.error("Pipeline completed with %d critical failure(s): %s",
                      len(critical_failures), ", ".join(critical_failures))
        sys.exit(1)

if __name__ == "__main__":
    main()
