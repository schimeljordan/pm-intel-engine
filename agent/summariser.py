"""
summariser.py — PM Intel Engine
Domain-agnostic VOC classification and JTBD summarisation.
All domain-specific values (categories, personas, value chain roles) are
loaded from domain.yaml via _load_domain_config().
Deep JTBD / value-chain signal classifier + persona analyst
Models: gpt-4o (per-card classification), gpt-4o-mini (persona summaries, theme labels),
        gpt-4o (strategic summary)
"""
from __future__ import annotations

import collections
import csv
import datetime
import hashlib
import json
import os
import re
import sqlite3
import time
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
from urllib.parse import urlparse

from .voc_stagegate import stagegate
try:
    from . import hf_client as _hf
except Exception:
    _hf = None  # graceful: HF unavailable

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="summariser %(levelname)s: %(message)s"
)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

# ── Config ────────────────────────────────────────────────────────────────────
OUT_DIR     = os.environ.get("DASHBOARD_PATH", "dashboard")
DEFAULT_DB  = "data/scraper.db"
MAX_CHARS   = 14000

# Model selection — gpt-4o for deep reasoning, gpt-4o-mini for high-volume cheap calls
# gpt-4o-mini for per-card classification — 306 cards × gpt-4o saturates RPM
# instantly (gpt-4o tier-1 limit: 500 RPM / 30k TPM). gpt-4o-mini has 5× the
# throughput and the structured JSON output quality is equivalent for this task.
MODEL_CLASSIFY = "gpt-4o-mini"   # per-card JTBD classification (high volume)
MODEL_SUMMARY  = "gpt-4o"        # strategic executive summary (1 call)
MODEL_MINI     = "gpt-4o-mini"   # persona summaries, theme labels (high volume)

# ── Canonical URL ─────────────────────────────────────────────────────────────
def canonical_url(u: str) -> str:
    if not u:
        return u
    u = u.strip()
    if u.startswith("http://"):
        u = "https://" + u[len("http://"):]
    try:
        from urllib.parse import parse_qsl, urlencode
        p = urlparse(u)
        path = p.path.rstrip("/")
        tracking = {"utm_source","utm_medium","utm_campaign","utm_term","utm_content",
                    "gclid","fbclid","yclid","msclkid","mc_eid"}
        qs = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
              if k.lower() not in tracking]
        query = urlencode(qs, doseq=True)
        clean = f"{p.scheme}://{p.netloc}{path}"
        if query:
            clean = f"{clean}?{query}"
        return clean
    except Exception:
        return u

def _now_utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def _domain(url: str) -> str:
    try:
        return canonical_url(url).split("//", 1)[1].split("/", 1)[0].lower()
    except Exception:
        return ""

def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]

def _truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n - 1] + "…"

def _truncate_words(s: str, n: int) -> str:
    words = (s or "").strip().split()
    return " ".join(words) if len(words) <= n else " ".join(words[:n])

# ── Schema constants ──────────────────────────────────────────────────────────
# CATEGORIES, PERSONAS, and VALUE_CHAIN_ROLES are populated at runtime
# from domain.yaml via _load_domain_config(). Do not hardcode here.
# Defaults below are used only if domain.yaml has no categories section.
_DEFAULT_CATEGORIES = [
    "Product & Feature Gaps",
    "Data & Integration",
    "User Experience",
    "Pricing & Packaging",
    "Operations & Workflow",
    "Compliance & Standards",
    "Competitive Dynamics",
    "Procurement & Funding",
    "Other / Not Relevant",
]
CATEGORIES: list = []  # populated by _load_domain_config()

_DEFAULT_PERSONAS = [
    "Executive / Decision Maker",
    "Product Manager",
    "Operations Manager",
    "IT / Data Manager",
    "End User / Practitioner",
    "Procurement / Finance",
    "Compliance Officer",
]
PERSONAS: list = []  # populated by _load_domain_config()

AI_LEVERS = [
    "Integration/API",
    "Workflow Automation",
    "Decision Support / Analytics",
    "LLM / Knowledge",
    "Computer Vision / Sensing",
    "Other / None",
]

BEHAVIORAL_STAGES = ["Awareness", "Evaluation", "Frustration", "Advocacy"]
SENTIMENTS = ["frustrated", "neutral", "positive"]

_DEFAULT_VALUE_CHAIN_ROLES = [
    "End Customer", "Vendor / Supplier", "Distributor / Reseller",
    "Regulator / Standards", "Service Provider", "Investor / Analyst",
]
VALUE_CHAIN_ROLES: list = []  # populated by _load_domain_config()

BLOCK_TERMS = [
    "career","careers","job","jobs","hiring","internship",
    "workout","fitness","cardio","exercise","resume","salary",
]

# ── Domain config loader ─────────────────────────────────────────────────────
def _load_domain_config() -> None:
    """Populate CATEGORIES, PERSONAS, VALUE_CHAIN_ROLES from domain.yaml at runtime."""
    global CATEGORIES, PERSONAS, VALUE_CHAIN_ROLES, CLASSIFY_SYSTEM, CLASSIFY_USER_TMPL

    config_path = Path(os.environ.get("CONFIG_PATH", "config.yaml"))
    try:
        import yaml  # type: ignore
        cfg = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
    except Exception:
        cfg = {}

    dom = cfg.get("domain") or {}
    domain_name = dom.get("name", "your industry")

    # Categories
    cats = dom.get("categories") or []
    CATEGORIES = [c for c in cats if isinstance(c, str)] if cats else list(_DEFAULT_CATEGORIES)
    if "Other / Not Relevant" not in CATEGORIES:
        CATEGORIES.append("Other / Not Relevant")

    # Personas
    raw_personas = dom.get("personas") or []
    if raw_personas and isinstance(raw_personas[0], dict):
        PERSONAS = [p.get("label", "") for p in raw_personas if p.get("label")]
    elif raw_personas:
        PERSONAS = list(raw_personas)
    else:
        PERSONAS = list(_DEFAULT_PERSONAS)

    # Value chain roles — optional in config, fall back to defaults
    vc_raw = dom.get("value_chain_roles") or []
    if vc_raw:
        VALUE_CHAIN_ROLES = [r if isinstance(r, str) else r.get("label","") for r in vc_raw]
    else:
        VALUE_CHAIN_ROLES = list(_DEFAULT_VALUE_CHAIN_ROLES)

    # Inject domain_name into prompts
    CLASSIFY_SYSTEM = _CLASSIFY_SYSTEM_TMPL.replace("{domain_name}", domain_name)
    CLASSIFY_USER_TMPL = _CLASSIFY_USER_TMPL_BASE.replace("{domain_name}", domain_name)

    logging.info(f"Domain: {domain_name} | {len(CATEGORIES)} categories | {len(PERSONAS)} personas")

# Store templates with placeholder before domain injection
_CLASSIFY_SYSTEM_TMPL = CLASSIFY_SYSTEM  # will be set after CLASSIFY_SYSTEM is defined
_CLASSIFY_USER_TMPL_BASE = None           # will be set after CLASSIFY_USER_TMPL is defined


# ── The core per-card JTBD / value-chain classification prompt ─────────────────
CLASSIFY_SYSTEM = """\
You are a senior market intelligence analyst specializing in {domain_name} with deep expertise in
Jobs-to-be-Done (JTBD) theory and value-chain analysis. Your job is to classify a single
web signal (article, forum post, product page, regulatory update) to answer three questions:

1. WHO is experiencing this pain or need — and WHERE in the {domain_name} value chain?
2. WHAT is the root cause of the pain — not just the symptom?
3. WHAT workaround are they building today, and WHY does it fail?

CRITICAL RULES:
- Ground every claim in the source text. Use hedged language ("signals suggest", "appears to",
  "may reflect") for inferences. NEVER assert what the source does not support.
- For jtbd: phrase as "When [persona/context]... I need to [job]... so I can [outcome]."
  This must be grounded in the signal — not invented from industry knowledge.
- For root_cause: explain WHY the pain exists structurally — what process, system, or
  incentive failure is causing it. This is the most important field.
- For workaround: describe what people are actually doing today to cope, and why that
  workaround is painful, costly, or error-prone.
- For value_chain_role: identify WHERE in the value chain the pain originates vs. where
  it is experienced (they are often different).
- confidence is ONLY your certainty from this source text — not industry knowledge.
  40–65 is typical for a trade article. Do NOT inflate.
"""

CLASSIFY_USER_TMPL = """\
Classify this {domain_name} market signal using the JTBD / value-chain framework.

Title: {title}
URL: {url}
Source text (truncated to {chars} chars):
{text}

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{{
  "category": "<one of: {categories}>",
  "personas": ["<1-3 from: {personas}>"],
  "value_chain_role": "<primary role experiencing the pain — one of: {vc_roles}>",
  "value_chain_origin": "<where the pain ORIGINATES in the chain — one of: {vc_roles} — may differ from value_chain_role>",
  "ai_lever": "<one of: {ai_levers}>",
  "inference_level": "<direct | inferred | weak>",
  "data_quality": "<sufficient | thin | insufficient>",
  "jtbd": "<15-25 words: When [specific context]... I need to [specific job]... so I can [concrete outcome]. REQUIRED unless source is completely abstract with no actor. Do NOT leave empty for real pain points — make a reasonable inference.>",
  "root_cause": "<1-2 tight sentences. State the specific structural failure — name the system, process, or incentive gap. NO generic observations. If source contains a stat or dollar figure, include it.>",
  "workaround": "<1 sentence: exactly what practitioners do today + why it fails. Empty string if not evidenced.>",
  "one_liner": "<15-20 words max: [who] + [specific pain] + [why it matters]. Must be specific to the source signal. NO generic hedging filler.>",
  "summary": "<25-35 words: one_liner expanded with a concrete number or specific mechanism from the source. If source has no stat, state the gap mechanism specifically. NO generic 'this signals a need for' language.>",
  "parity_caps": ["<0-5 capability terms vendors compete on — e.g. 'offline mobile sync', 'AHJ portal access', 'NFPA 25 form templates'>"],
  "statistic": "<exact metric or claim quoted verbatim from source, or empty string>",
  "confidence": <integer 0-100: certainty from THIS source text only — typical is 40-65>,
  "urgency": <integer 1-5: 1=nice-to-have, 3=workflow gap, 5=compliance-blocking or safety-critical>,
  "sentiment": "<frustrated | neutral | positive>",
  "behavioral_stage": "<Awareness | Evaluation | Frustration | Advocacy>"
}}
"""

# Store base templates for domain injection
_CLASSIFY_SYSTEM_TMPL = CLASSIFY_SYSTEM
_CLASSIFY_USER_TMPL_BASE = CLASSIFY_USER_TMPL

# ── Heuristic fallback (when OpenAI unavailable) ──────────────────────────────
HEURISTICS = {
    "Inspections & Compliance": [
        "inspection","itm","prevention","compliance","permit","deficiency",
        "correction","enforcement","occupancy","pre-plan","preplan","tce","irol",
    ],
    "Data & System Integration": [
        "api","integration","integrate","webhook","sync","export","cad","rms",
        "data insights","etl","snowflake","q360",
    ],
    "Communication & Coordination": [
        "incident command","dispatch","radio","tablet command","paging",
        "alerting","interoperability","situational awareness",
    ],
    "Incident Command & Response": [
        "incident command","ics","nims","fireground","command post","unified command",
        "span of control","accountability","mayday","lodd","line of duty",
        "after action","aar","mass casualty","mci","triage","medical command",
        "command board","tactical worksheet","resource tracking","crew integrity",
        "safety officer","division supervisor","operations section","mutual aid coordination",
        "command vehicle","mobile command","situational awareness fire","first due command",
        "scene watcher","lexipol","nfpa 1561","niosh",
    ],
    "Operations & Training": [
        "training","drill","curriculum","ops","apparatus","tactics",
        "procedures","after action","aar","academy",
    ],
    "Facilities / Built Environment": [
        "facility","building code","sprinkler","alarm","clss","honeywell",
        "hydraulic calc","fire pump","test valve","device testing",
    ],
    "Community Risk Reduction": [
        "risk reduction","crr","public education","smoke alarm","community","outreach",
    ],
    "Wildland/WUI": [
        "wildland","wildfire","wui","brush","vegetation","fuel break","red flag","megafire",
    ],
    "Standards & Codes (NFPA/ICC)": [
        "nfpa","icc","code","standard","72","25","13","101",
    ],
    "Procurement / Grants / Funding": [
        "grant","afg","safer","funding","procurement","rfp","solicitation",
    ],
}

PERSONA_HINTS = {
    "Fire Marshal / Prevention": ["marshal","prevention","plan review"],
    "Fire Inspector": ["inspector","inspection","itm","deficiency"],
    "Fire Compliance Inspector": ["contractor","third-party","tce","irol"],
    "AHJ": ["ahj","authority having jurisdiction","code enforcement"],
    "IT / Data Manager": ["api","integration","database","etl","warehouse","sync","export"],
    "Incident Commander": ["incident commander","command post","unified command","section chief","safety officer","division supervisor","mayday","fireground","span of control"],
    "EMS Medical Commander": ["medical command","mass casualty","mci","triage","ems command","medical director","transport officer"],
    "Facility Manager": ["facility manager","facilities","building engineer","owner"],
    "Contractor / Vendor": ["contractor","installer","service company","vendor"],
}

def _choose_with_heuristics(title: str, text: str) -> Dict[str, Any]:
    blob = f"{title}\n{text}".lower()
    scores = collections.Counter()
    for cat, keys in HEURISTICS.items():
        for k in keys:
            if k in blob:
                scores[cat] += 1
    category = scores.most_common(1)[0][0] if scores else "Other / Not Relevant"
    personas: set = set()
    for p, keys in PERSONA_HINTS.items():
        if any(k in blob for k in keys):
            personas.add(p)
    if not personas:
        personas.add("Fire Chief")
    if any(w in blob for w in ["api","integration","sdk","webhook"]):
        lever = "Integration/API"
    elif any(w in blob for w in ["analytics","insights","dashboard","predictive","ai"]):
        lever = "Decision Support / Analytics"
    elif any(w in blob for w in ["automate","automation","workflow","process"]):
        lever = "Workflow Automation"
    elif any(w in blob for w in ["llm","gpt","rag","chatbot","large language model"]):
        lever = "LLM / Knowledge"
    elif any(w in blob for w in ["camera","vision","ocr","image","sensor"]):
        lever = "Computer Vision / Sensing"
    else:
        lever = "Other / None"
    return {
        "category": category,
        "personas": sorted(personas)[:3],
        "value_chain_role": "Fire Department",
        "value_chain_origin": "Technology Vendor",
        "ai_lever": lever,
        "inference_level": "inferred",
        "data_quality": "thin",
        "jtbd": "",
        "root_cause": "Heuristic fallback — OpenAI key required for root-cause analysis.",
        "workaround": "",
        "one_liner": _truncate(title, 180),
        "summary": _truncate_words(text or title, 40),
        "parity_caps": [],
        "statistic": "",
        "confidence": 35,
        "urgency": 3,
        "sentiment": "neutral",
        "behavioral_stage": "Awareness",
    }

# ── OpenAI quota guard ───────────────────────────────────────────────────────
# Set to True at runtime when a quota/auth error is detected; all subsequent
# LLM calls in the same process will skip to heuristic fallback immediately.
_LLM_QUOTA_EXHAUSTED: bool = False

# ── OpenAI client ─────────────────────────────────────────────────────────────
def _client_or_none() -> Optional[Any]:
    if OpenAI is None:
        return None
    api_key = (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("OPENAI_SUMMARISER_API_KEY")
        or os.environ.get("OPENAI_SUMMARIZER_API_KEY")
    )
    base_url = os.environ.get("OPENAI_API_BASE_URL")
    if not api_key:
        return None
    try:
        return OpenAI(api_key=api_key, **({"base_url": base_url} if base_url else {}))
    except Exception:
        return None

# ── Per-card LLM classification ───────────────────────────────────────────────
def _llm_classify(client: Any, title: str, url: str, text: str) -> Dict[str, Any]:
    # ── HuggingFace pre-filter (free, graceful fallback) ──────────────────
    # Attempt cheap HF zero-shot classification first.
    # If confident (>55%), use it as the category hint and skip OpenAI category inference.
    # If HF is unavailable or low-confidence, falls through to full OpenAI classify.
    _hf_category = None
    _hf_sentiment = None
    _hf_summary   = None
    if _hf:
        try:
            blob = f"{title}\n{text[:600]}"
            _hf_category = _hf.classify_category(blob)
            _hf_sentiment = _hf.classify_sentiment(blob[:512])
            _hf_summary   = _hf.extractive_summary(text, max_length=55, min_length=18)
        except Exception as _e:
            import logging; logging.debug("[hf] pre-filter failed: %s", _e)
            _hf_category = _hf_sentiment = _hf_summary = None

    prompt = CLASSIFY_USER_TMPL.format(
        title=title,
        url=url,
        chars=MAX_CHARS,
        text=_truncate(text, MAX_CHARS),
        categories=", ".join(CATEGORIES),
        personas=", ".join(PERSONAS),
        vc_roles=", ".join(VALUE_CHAIN_ROLES),
        ai_levers=", ".join(AI_LEVERS),
    )
    last_exc: Exception = Exception("no attempts")
    for attempt in range(4):  # exponential backoff: 5s, 15s, 45s
        try:
            resp = client.chat.completions.create(
                model=MODEL_CLASSIFY,
                messages=[
                    {"role": "system", "content": CLASSIFY_SYSTEM},
                    {"role": "user",   "content": prompt},
                ],
                response_format={"type": "json_object"},
                max_completion_tokens=1200,
                temperature=0.1,
            )
            raw = resp.choices[0].message.content
            if not raw:
                raise ValueError("Empty LLM response")

            data = json.loads(raw)

            # ── Normalize / validate ──────────────────────────────────────────
            if data.get("category") not in CATEGORIES:
                data["category"] = "Other / Not Relevant"
            ps = [p for p in (data.get("personas") or []) if p in PERSONAS]
            data["personas"] = ps[:3] or ["Fire Chief"]
            if data.get("ai_lever") not in AI_LEVERS:
                data["ai_lever"] = "Other / None"
            if data.get("inference_level") not in ("direct","inferred","weak"):
                data["inference_level"] = "inferred"
            dq = data.get("data_quality","sufficient")
            if dq not in ("sufficient","thin","insufficient"):
                dq = "sufficient"
            data["data_quality"] = dq
            if data.get("value_chain_role") not in VALUE_CHAIN_ROLES:
                data["value_chain_role"] = "Fire Department"
            if data.get("value_chain_origin") not in VALUE_CHAIN_ROLES:
                data["value_chain_origin"] = data["value_chain_role"]
            data["confidence"] = int(max(0, min(100, int(data.get("confidence", 50)))))

            # ── Override with HF signals where HF was confident ──────────
            # HF category takes precedence if it fired (it uses a finer signal)
            if _hf_category:
                data["category"] = _hf_category
            # HF sentiment is fine-tuned on real social text — more reliable than GPT here
            if _hf_sentiment and data.get("sentiment") == "neutral":
                data["sentiment"] = _hf_sentiment
            # HF extractive summary used as workaround fallback when GPT left it empty
            if _hf_summary and not data.get("workaround", "").strip():
                data["workaround"] = _hf_summary
            data["urgency"]    = max(1, min(5, int(data.get("urgency", 3))))
            data["sentiment"]  = data.get("sentiment") if data.get("sentiment") in SENTIMENTS else "neutral"
            data["behavioral_stage"] = data.get("behavioral_stage") if data.get("behavioral_stage") in BEHAVIORAL_STAGES else "Awareness"

            # Enforce anti-hallucination for low-quality sources
            if dq == "insufficient":
                data["one_liner"]   = _truncate(title, 220)
                data["summary"]     = "Insufficient source content for reliable analysis."
                data["root_cause"]  = "Insufficient source data."
                data["workaround"]  = ""
                data["jtbd"]        = ""
                data["parity_caps"] = []
                data["statistic"]   = ""
                data["confidence"]  = min(data["confidence"], 20)
            else:
                data["one_liner"]   = _truncate((data.get("one_liner") or title).strip(), 220)
                data["summary"]     = _truncate_words(data.get("summary") or data.get("one_liner") or title, 55)
                data["root_cause"]  = _truncate((data.get("root_cause") or "").strip(), 800)
                data["workaround"]  = _truncate((data.get("workaround") or "").strip(), 500)
                data["jtbd"]        = _truncate((data.get("jtbd") or "").strip(), 250)
                data["parity_caps"] = [str(x)[:60] for x in (data.get("parity_caps") or [])][:5]
                data["statistic"]   = _truncate((data.get("statistic") or "").strip(), 160)

            return data

        except Exception as e:
            last_exc = e
            err_str = str(e).lower()
            if "insufficient_quota" in err_str or "401" in err_str or "invalid_api_key" in err_str:
                # Quota or auth error — disable LLM for all remaining cards and
                # fall through to heuristics. Do NOT raise; the pipeline must
                # continue and commit whatever data it has.
                global _LLM_QUOTA_EXHAUSTED
                _LLM_QUOTA_EXHAUSTED = True
                logging.error(
                    f"OpenAI quota/auth error — LLM enrichment disabled for this run. "
                    f"Heuristic fallback will be used for all remaining cards. Error: {e}"
                )
                break  # exit retry loop, fall through to heuristic below
            if attempt < 3:
                wait = 5 * (3 ** attempt)  # 5s, 15s, 45s
                logging.warning(f"LLM classify attempt {attempt+1} failed ({e}), retrying in {wait}s")
                import time; time.sleep(wait)

    logging.warning(f"LLM classify failed after retries — heuristic fallback: {last_exc}")
    return _choose_with_heuristics(title, text)

# ── Scoring ───────────────────────────────────────────────────────────────────
def _score_item(domain: str, category: str, confidence: int,
                urgency: int = 3, sentiment: str = "neutral",
                data_quality: str = "sufficient", date_str: str = "") -> int:
    base = 50
    # Vendor PR discount
    if domain.endswith(("firstdue.com","inspectpoint.com","honeywell.com","vectorsolutions.com")):
        base -= 5
    # Category priority
    if category in ("Inspections & Compliance","Data & System Integration"):
        base += 10
    elif category == "Standards & Codes (NFPA/ICC)":
        base += 6
    # Urgency
    base += (urgency - 3) * 4
    # Sentiment
    if sentiment == "frustrated":
        base += 10
    elif sentiment == "positive":
        base -= 3
    # Data quality
    if data_quality == "insufficient":
        base -= 15
    elif data_quality == "thin":
        base -= 5
    # Recency decay
    if date_str:
        try:
            ts = None
            clean_date = date_str.rstrip("Z").strip()
            for fmt in ("%Y-%m-%dT%H:%M:%S","%Y-%m-%dT%H:%M","%Y-%m-%d"):
                try:
                    ts = datetime.datetime.strptime(clean_date[:len(fmt)], fmt)
                    break
                except ValueError:
                    pass
            if ts:
                age = (datetime.datetime.utcnow() - ts).days
                if age > 365: base -= 20
                elif age > 180: base -= 12
                elif age > 90: base -= 7
                elif age > 30: base -= 3
        except Exception:
            pass
    return max(1, min(100, base + int(confidence / 5)))

# ── Data loading ──────────────────────────────────────────────────────────────
@dataclass
class Item:
    title: str; url: str; date: str; domain: str; text: str

def _coerce_row(row: Any) -> Optional[Item]:
    """Coerce a DB row or dict to an Item. Items with no date or dates
    older than 180 days are treated as fetched today so cards appear
    fresh rather than perpetually showing the original scrape date."""
    if row is None:
        return None
    try:
        today = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        cutoff = (datetime.datetime.utcnow() - datetime.timedelta(days=30)).strftime("%Y-%m-%d")
        if isinstance(row, dict):
            url   = canonical_url(row.get("url",""))
            title = (row.get("title") or "").strip()
            text  = (row.get("summary") or row.get("text") or row.get("content") or "").strip()
            date  = row.get("date") or row.get("published_at") or ""
        else:
            url   = canonical_url(row["url"])
            title = (row["title"] or "").strip()
            text  = (row["text"] or "").strip()
            date  = row.get("date") or row.get("fetched_at") or ""
        if not url or not title:
            return None
        # Use today's date for undated items or items older than 180 days
        # (static pages scraped months ago should not pollute date filters)
        if not date or date[:10] < cutoff:
            date = today
        return Item(title=title, url=url, date=date, domain=_domain(url), text=text)
    except Exception:
        return None

def _load_items() -> List[Item]:
    items: List[Item] = []
    f = Path(OUT_DIR) / "latest.json"
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8")).get("items", [])
            for it in data:
                item = _coerce_row(it)
                if item and not any(t in f"{item.title} {item.text}".lower() for t in BLOCK_TERMS):
                    items.append(item)
        except Exception as e:
            logging.warning(f"Failed to read {f}: {e}")
    if not items and os.path.exists(DEFAULT_DB):
        try:
            db = sqlite3.connect(DEFAULT_DB)
            db.row_factory = sqlite3.Row
            cur = db.cursor()
            cur.execute("SELECT url,title,fetched_at as date,text FROM pages ORDER BY fetched_at DESC LIMIT 2000")
            for row in cur.fetchall():
                item = _coerce_row(row)
                if item and not any(t in f"{item.title} {item.text}".lower() for t in BLOCK_TERMS):
                    items.append(item)
        except Exception as e:
            logging.warning(f"SQLite fallback: {e}")
    return items

# ── Theme labels ──────────────────────────────────────────────────────────────
def _llm_theme_label(client: Any, titles: List[str], fallback: str) -> str:
    if not client or not titles:
        return fallback
    prompt = (
        "Given these fire & life safety article titles, write a 3-5 word theme label "
        "capturing the shared pain or topic. Return only the label.\n\n"
        + "\n".join(f"- {t}" for t in titles[:6])
    )
    try:
        r = client.chat.completions.create(
            model=MODEL_MINI,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=20, temperature=0.1,
        )
        label = (r.choices[0].message.content or "").strip().strip('"')
        if label and len(label.split()) <= 8:
            return label
    except Exception as e:
        logging.warning(f"Theme label failed: {e}")
    return fallback

def _build_themes(cards: List[Dict[str,Any]], client: Any = None) -> List[Dict[str,Any]]:
    per_cat: Dict[str, List[Dict[str,Any]]] = collections.defaultdict(list)
    for c in cards:
        per_cat[c["voc_category"]].append(c)
    out: List[Dict[str,Any]] = []
    for cat, items in per_cat.items():
        counter = collections.Counter()
        for it in items:
            for w in re.findall(r"[A-Za-z][A-Za-z\-]{2,}", f"{it['title']} {it.get('one_liner','')}"):
                wl = w.lower()
                if wl in {"with","from","that","this","into","your","have","will","data","fire","and","the"}:
                    continue
                counter[wl] += 1
        top_words = [w for w,_ in counter.most_common(6)]
        freq_label = f"{cat} — " + ", ".join(top_words[:3]) if top_words else cat
        label = _llm_theme_label(client, [it["title"] for it in items[:6]], freq_label)
        personas = sorted({p for it in items for p in it["personas"]})[:4]
        levers   = sorted({it["ai_lever"] for it in items})[:4]
        links    = [{"title": it["title"], "url": it["url"]} for it in items[:6]]
        out.append({
            "label": label, "category": cat,
            "why_it_matters": f"Signals within {cat.lower()} span {', '.join(top_words[:5])}.",
            "personas": personas, "priority": "High" if cat in ("Inspections & Compliance","Data & System Integration") else "Medium",
            "ai_levers": levers, "count": len(items), "sample_links": links,
        })
    return sorted(out, key=lambda x: (-x["count"], x["category"]))[:20]

# ── Persona summaries — deep per-role bullets ─────────────────────────────────
PERSONA_PROMPT_FILTERS: Dict[str, List[str]] = {
    "ops":               ["Fire Chief","Deputy/Assistant Chief","Operations Officer","Training Officer"],
    "fire_marshal":      ["Fire Marshal / Prevention","Fire Inspector","Fire Compliance Inspector"],
    "inspector":         ["Fire Inspector","Fire Compliance Inspector"],
    "owner":             ["Facility Manager","Contractor / Vendor"],
    "ahj":               ["AHJ","Fire Marshal / Prevention"],
    "system_integrator": ["IT / Data Manager","Contractor / Vendor"],
}

PERSONA_ROLE_DESC = {
    "ops":               "a Fire Chief or Operations Officer responsible for department performance, staffing, and incident outcomes",
    "fire_marshal":      "a Fire Marshal or Prevention Bureau Chief responsible for code enforcement and plan review",
    "inspector":         "a Fire Inspector doing field ITM inspections and deficiency tracking",
    "owner":             "a Building Owner or Facility Manager accountable for life-safety compliance and cost",
    "ahj":               "an Authority Having Jurisdiction (AHJ) who sets local code interpretations and issues permits",
    "system_integrator": "a Fire & Life Safety IT Manager or System Integrator connecting disparate platforms",
}

PERSONA_FOCUS = {
    "ops":               "operational gaps, staffing/resource constraints, technology adoption barriers, and outcome metrics",
    "fire_marshal":      "code complexity, enforcement workload, plan review bottlenecks, and AHJ coordination friction",
    "inspector":         "field workflow gaps, data entry pain, reporting/deficiency-tracking failures, and tool reliability",
    "owner":             "compliance cost, penalty exposure, contractor management complexity, and record-keeping burden",
    "ahj":               "code interpretation ambiguity, inspector capacity, data access limitations, and multi-jurisdiction consistency",
    "system_integrator": "integration barriers, data format incompatibilities, API gaps, and interoperability with CAD/RMS/AHJ portals",
}

def _persona_summaries(client: Any, cards: List[Dict[str,Any]]) -> Dict[str, Any]:
    def _pool(keys: List[str]) -> List[Dict[str,Any]]:
        wanted = set(keys)
        matched = [c for c in cards if wanted.intersection(c.get("personas") or [])]
        return (matched or cards)[:50]

    def ask(key: str) -> List[str]:
        pool = _pool(PERSONA_PROMPT_FILTERS.get(key, []))
        if not client:
            top = collections.Counter([c["voc_category"] for c in pool]).most_common(3)
            return [f"Focus area: {k} ({v} signals)." for k, v in top]

        # Build rich corpus including root_cause and workaround fields
        lines = []
        for c in pool:
            rc  = c.get("root_cause","").strip()
            wk  = c.get("workaround","").strip()
            jbd = c.get("jtbd","").strip()
            cat = c.get("voc_category","")
            ol  = c.get("one_liner","").strip() or c["title"]
            line = f"[{cat}] {c['title']}"
            if ol and ol != c["title"]:
                line += f" — {ol}"
            if rc and "Heuristic" not in rc and "Insufficient" not in rc:
                line += f"\n  Root cause: {rc}"
            if wk:
                line += f"\n  Current workaround: {wk}"
            if jbd:
                line += f"\n  JTBD: {jbd}"
            lines.append(line)

        corpus = _truncate("\n\n".join(lines), 10000)
        role_desc = PERSONA_ROLE_DESC.get(key, "a fire & life safety practitioner")
        focus     = PERSONA_FOCUS.get(key, "operational pain points")

        prompt = f"""\
You are analyzing fire & life safety market intelligence signals to advise {role_desc}.

Your focus for this persona: {focus}

Signal corpus ({len(pool)} signals, root causes and workarounds included where available):
{corpus}

Write EXACTLY 3 insight bullets for this persona. Each bullet MUST:
1. Name a SPECIFIC pain, gap, or workflow failure evidenced by multiple signals — not a generic observation
2. Explain the ROOT CAUSE structurally: what process, system, or incentive failure is causing this?
   (e.g. "AHJs lack real-time data access because CAD systems don't expose APIs..." not just "data is fragmented")
3. Describe the WORKAROUND practitioners use today — and why it fails or creates downstream cost
4. State the commercial implication or opportunity for whoever solves this

Rules:
- Use hedged language: "signals suggest", "appears to", "based on N signals"
- Be specific — name the actual system, code, or workflow involved
- Do NOT repeat the same root cause across bullets
- If fewer than 3 distinct themes exist in the signals, write fewer bullets — do not pad
- Return only the 3 bullets as plain text, one per line, starting with "•"
"""
        try:
            r = client.chat.completions.create(
                model=MODEL_MINI,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=1200, temperature=0.2,
            )
            content = (r.choices[0].message.content or "").strip()
            bullets = [b.strip(" -*•") for b in content.split("\n") if b.strip() and len(b.strip()) > 20]
            return bullets[:3] or [content[:200]]
        except Exception as e:
            logging.warning(f"Persona summary '{key}' failed: {e}")
            return ["Summary unavailable — LLM call failed."]

    return {
        "ops":               ask("ops"),
        "fire_marshal":      ask("fire_marshal"),
        "inspector":         ask("inspector"),
        "owner":             ask("owner"),
        "ahj":               ask("ahj"),
        "system_integrator": ask("system_integrator"),
        "generated_at":      _now_utc(),
    }

# ── Strategic summary ──────────────────────────────────────────────────────────
def _ai_strategic_summary(client: Any, cards: List[Dict[str,Any]], overview: Dict[str,Any]) -> Dict[str,Any]:
    generated_at = _now_utc()
    if not client or not cards:
        return {"generated_at": generated_at, "available": False,
                "note": "LLM not configured — set OPENAI_API_KEY to enable."}

    # Build rich corpus: top 35 cards sorted by score, include root_cause + workaround
    top = sorted(cards, key=lambda c: -c.get("opportunity_score", 0))[:35]
    lines = []
    for c in top:
        rc = c.get("root_cause","").strip()
        wk = c.get("workaround","").strip()
        jbd = c.get("jtbd","").strip()
        line = f"[{c['voc_category']}] {c['title']}"
        if rc and "Heuristic" not in rc and "Insufficient" not in rc:
            line += f"\n  Root cause: {rc}"
        if wk:
            line += f"\n  Workaround: {wk}"
        if jbd:
            line += f"\n  JTBD: {jbd}"
        lines.append(line)
    corpus = _truncate("\n\n".join(lines), 8000)

    div_summary = "\n".join(
        f"  {d['division']}: {d['count']} signals"
        for d in (overview.get("divisions") or [])[:10]
    )

    prompt = f"""\
You are a senior fire & life safety product strategist. Analyze these market intelligence signals
to produce an executive intelligence brief.

Signal distribution ({len(cards)} total signals):
{div_summary}

Top signals with root causes and workarounds:
{corpus}

CRITICAL RULES:
1. Only draw conclusions supported by MULTIPLE signals (2+). Flag single-signal findings as "emerging (low confidence)".
2. Use hedged language throughout. Never assert what the corpus doesn't support.
3. The most valuable insight is structural: WHERE in the value chain does the friction originate vs. where is it felt?
4. Surface contradictions explicitly — do not smooth them over.
5. confidence should be honest — 45-65 is normal for a weekly batch.

Return ONLY valid JSON matching this exact schema:
{{
  "executive_summary": "<3-4 sentences: what the signals collectively suggest about the most significant market movement, citing approximate signal counts and root causes. Hedged.>",
  "top_insights": [
    "<insight: specific finding + root cause + commercial implication. Cite signal count. Hedged.>",
    "<insight 2>",
    "<insight 3>"
  ],
  "value_chain_friction": "<2-3 sentences: WHERE in the value chain (Regulator→Contractor→FD→Owner→Vendor) does the primary friction originate and who bears the cost? Ground in signals.>",
  "workaround_patterns": "<2-3 sentences: what workarounds are practitioners building today (spreadsheets, manual exports, shadow IT, paper-based processes)? What does this signal about unmet demand?>",
  "contradictions": ["<if any signals conflict, describe in 1 sentence — else empty list>"],
  "recommended_focus": [
    "<product or feature area — 5-10 words>",
    "<product or feature area 2>"
  ],
  "watch_signals": "<1-2 sentences: what early/emerging pattern deserves monitoring even with few sources?>",
  "confidence": <integer 0-100: honest confidence given signal volume and agreement>
}}
"""
    try:
        resp = client.chat.completions.create(
            model=MODEL_SUMMARY,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=2000, temperature=0.2,
        )
        content = resp.choices[0].message.content
        if not content:
            raise ValueError("Empty response")
        data = json.loads(content)
        data.update({"generated_at": generated_at, "available": True, "signal_count": len(cards)})
        if not isinstance(data.get("contradictions"), list):
            data["contradictions"] = []
        data["contradictions"] = [str(c)[:300] for c in data["contradictions"] if c][:5]
        return data
    except Exception as e:
        logging.warning(f"Strategic summary failed: {e}")
        return {"generated_at": generated_at, "available": False, "note": f"Generation failed: {e}"}

# ── Describe division ─────────────────────────────────────────────────────────
def _describe_division(div: str, subs: List[str]) -> str:
    subs_txt = ", ".join([s for s in subs if s]) or "related issues"
    return _truncate_words(
        f"VOCs in {div} surface challenges around {subs_txt}. "
        "Practitioners are seeking clearer guidance, better workflows, and tools to reduce friction.",
        42
    )

# ── JSON writer ───────────────────────────────────────────────────────────────
def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    logging.info(f"Wrote {path}")

# ── Main run ──────────────────────────────────────────────────────────────────
def run() -> None:
    _load_domain_config()  # load categories/personas from domain.yaml before anything else
    os.makedirs(OUT_DIR, exist_ok=True)
    client = _client_or_none()
    if client:
        logging.info(f"LLM enrichment ACTIVE — classify={MODEL_CLASSIFY}, summary={MODEL_SUMMARY}, mini={MODEL_MINI}")
    else:
        logging.warning("LLM enrichment OFFLINE — OPENAI_API_KEY not set. Using heuristic fallback.")

    items = _load_items()
    logging.info(f"Items loaded: {len(items)}")

    # Load existing cards to skip re-enriching cards that already have JTBD
    existing_cards: Dict[str, Dict] = {}
    existing_path = Path(OUT_DIR) / "cards.json"
    if existing_path.exists():
        try:
            prev = json.loads(existing_path.read_text(encoding="utf-8"))
            prev_list = prev if isinstance(prev, list) else prev.get("cards", [])
            for c in prev_list:
                if c.get("jtbd", "").strip() and c.get("id"):
                    existing_cards[c["id"]] = c
            logging.info(f"Loaded {len(existing_cards)} previously-enriched cards (will skip LLM re-call)")
        except Exception:
            pass

    accepted = rejected = 0
    cards: List[Dict[str,Any]] = []
    cat_c: collections.Counter = collections.Counter()
    sub_c_map: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    persona_c: collections.Counter = collections.Counter()
    dom_c: collections.Counter = collections.Counter()
    div_counts: collections.Counter = collections.Counter()
    sub_counts: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    persona_by_div: Dict[str, collections.Counter] = collections.defaultdict(collections.Counter)

    for it in items:
        g = stagegate({"title": it.title, "text": it.text, "url": it.url,
                        "date": it.date, "domain": it.domain})
        if not g.get("accepted"):
            rejected += 1
            continue
        accepted += 1
        division    = (g.get("division") or "Other / Not Relevant").strip()
        subdivision = (g.get("subdivision") or "").strip()
        sg_personas = list(dict.fromkeys(g.get("personas") or []))[:3]

        card_id = _hash(f"{it.url}|{it.title}")
        if card_id in existing_cards:
            # Reuse previously-enriched card data — skip LLM call
            cls = existing_cards[card_id]
        elif client and not _LLM_QUOTA_EXHAUSTED:
            cls = _llm_classify(client, it.title, it.url, it.text)
        else:
            cls = _choose_with_heuristics(it.title, it.text)
        personas = sg_personas or cls.get("personas", ["Fire Chief"])

        urgency      = int(cls.get("urgency", 3))
        sentiment    = cls.get("sentiment", "neutral")
        data_quality = cls.get("data_quality", "sufficient")
        score = _score_item(it.domain, division, int(cls.get("confidence", 50)),
                            urgency=urgency, sentiment=sentiment,
                            data_quality=data_quality, date_str=it.date)

        card = {
            "id":               _hash(f"{it.url}|{it.title}"),
            "title":            it.title,
            "url":              it.url,
            "date":             it.date,
            "domain":           it.domain,
            "voc_category":     division,
            "voc_subcategory":  subdivision,
            "personas":         personas,
            "value_chain_role":   cls.get("value_chain_role","Fire Department"),
            "value_chain_origin": cls.get("value_chain_origin","Technology Vendor"),
            "opportunity_score":  score,
            "ai_lever":           cls.get("ai_lever","Other / None"),
            "parity_caps":        cls.get("parity_caps", []),
            "one_liner":          cls.get("one_liner", _truncate(it.title, 180)),
            "summary":            cls.get("summary",   _truncate_words(it.text or it.title, 40)),
            "root_cause":         cls.get("root_cause",""),
            "workaround":         cls.get("workaround",""),
            "statistic":          cls.get("statistic",""),
            "confidence":         int(cls.get("confidence",50)),
            "jtbd":               cls.get("jtbd",""),
            "inference_level":    cls.get("inference_level","inferred"),
            "data_quality":       data_quality,
            "urgency":            urgency,
            "sentiment":          sentiment,
            "behavioral_stage":   cls.get("behavioral_stage","Awareness"),
        }
        cards.append(card)

        div_counts[division] += 1
        sub_counts[division][subdivision] += 1
        for p in personas:
            persona_by_div[division][p] += 1
        cat_c[division] += 1
        if subdivision:
            sub_c_map[division][subdivision] += 1
        for p in personas:
            persona_c[p] += 1
        dom_c[it.domain] += 1

    # Dedup by ID, keep highest score
    best: Dict[str,Dict[str,Any]] = {}
    for c in cards:
        k = c["id"]
        if k not in best or c["opportunity_score"] > best[k]["opportunity_score"]:
            best[k] = c
    cards = sorted(best.values(), key=lambda x: (-x["opportunity_score"], x["title"][:80]))
    logging.info(f"Cards after dedup: {len(cards)} (accepted={accepted}, rejected={rejected})")

    # VOC overview — use len(cards) here (this run's accepted items)
    # voc_overview reflects current-run distribution; the merged total is in cards.json
    overview: Dict[str,Any] = {"generated_at": _now_utc(), "totals": {"cards": len(cards), "note": "count reflects this pipeline run; cards.json contains full cumulative history"}, "divisions": []}
    for div, total in div_counts.most_common():
        top_subs = sub_counts[div].most_common(3)
        subs_labels = [s for s, _ in top_subs]
        by_persona  = dict(persona_by_div[div])
        div_cards   = [c for c in cards if c["voc_category"] == div and c.get("root_cause","").strip()
                       and "Heuristic" not in c.get("root_cause","") and "Insufficient" not in c.get("root_cause","")]
        div_cards.sort(key=lambda c: -c["opportunity_score"])
        # Synthesize top pain as the most specific root_cause from the highest-scored card
        # Prefer cards with a statistic/number for quantification
        stat_cards = [c for c in div_cards if c.get("statistic","").strip()]
        top_card   = stat_cards[0] if stat_cards else (div_cards[0] if div_cards else None)
        if top_card:
            stat = top_card.get("statistic","").strip()
            rc   = top_card.get("root_cause","").strip()
            top_pain = (rc + (f" ({stat})" if stat and stat not in rc else ""))[:400]
        else:
            top_pain = ""
        overview["divisions"].append({
            "division": div, "count": total,
            "top_subdivisions": [{"label": s, "count": c} for s, c in top_subs],
            "summary": _describe_division(div, subs_labels),
            "by_persona": by_persona, "top_pain": top_pain,
        })
    # Will update overview totals with merged count after cards merge below
    _OVERVIEW_PLACEHOLDER = overview

    # Cards — merge new cards with existing ones so the signal list grows over time
    # New cards (processed this run) take priority; existing cards fill in the rest.
    MAX_CARDS = 2000  # cap to prevent unbounded growth
    existing_path = Path(OUT_DIR) / "cards.json"
    merged: Dict[str, Dict] = {}
    # Load all existing cards first (oldest signals as base)
    if existing_path.exists():
        try:
            prev = json.loads(existing_path.read_text(encoding="utf-8"))
            prev_list = prev if isinstance(prev, list) else prev.get("cards", [])
            for c in prev_list:
                if c.get("id"):
                    merged[c["id"]] = c
        except Exception:
            pass
    # Overlay with freshly-processed cards (higher score wins on collision)
    for c in cards:
        k = c["id"]
        if k not in merged or c["opportunity_score"] > merged[k]["opportunity_score"]:
            merged[k] = c
    # Sort by score descending, cap at MAX_CARDS
    all_cards = sorted(merged.values(), key=lambda x: (-x["opportunity_score"], x["title"][:80]))
    all_cards = all_cards[:MAX_CARDS]
    logging.info(f"Cards after merge: {len(all_cards)} (new this run: {len(cards)}, total unique: {len(merged)})")
    _write_json(Path(OUT_DIR) / "cards.json", {"generated_at": _now_utc(), "cards": all_cards})

    # Update voc_overview totals to reflect cumulative merged count, then write
    _OVERVIEW_PLACEHOLDER["totals"]["cards"] = len(all_cards)
    _OVERVIEW_PLACEHOLDER["totals"]["this_run"] = len(cards)
    _OVERVIEW_PLACEHOLDER["totals"].pop("note", None)
    _write_json(Path(OUT_DIR) / "voc_overview.json", _OVERVIEW_PLACEHOLDER)

    # Analytics
    _write_json(Path(OUT_DIR) / "analytics.json", {
        "generated_at": _now_utc(),
        "by_category": dict(cat_c), "by_persona": dict(persona_c), "by_domain": dict(dom_c),
        "totals": {"cards": len(cards), "accepted": accepted, "rejected": rejected,
                   "domains": len(dom_c), "categories": len([k for k,v in cat_c.items() if v>0])},
        "funnel": {"items_loaded": accepted+rejected, "items_passed_stagegate": accepted,
                   "items_deduplicated": len(cards),
                   "pass_rate_pct": round(len(cards)/max(accepted+rejected,1)*100,1)},
    })

    # Themes
    themes = _build_themes(cards, client)
    _write_json(Path(OUT_DIR) / "themes.json", {"generated_at": _now_utc(), "themes": themes})

    # VOC summary
    by_subcategory_top3 = {div: dict(c.most_common(3)) for div, c in sub_c_map.items()}
    _write_json(Path(OUT_DIR) / "voc_summary.json", {
        "generated_at": _now_utc(),
        "totals": {"accepted": accepted, "rejected": rejected, "divisions": len(cat_c)},
        "by_category": dict(cat_c),
        "by_subcategory_top3": by_subcategory_top3,
        "by_persona": dict(persona_c),
    })

    # CSV mirror
    csv_path = Path(OUT_DIR) / "voc_summary.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Division","Count","Top Sub 1","Top Sub 2","Top Sub 3","Summary"])
        for div in overview.get("divisions",[]):
            subs = [s.get("label","") for s in div.get("top_subdivisions",[])[:3]] + ["","",""]
            w.writerow([div.get("division",""), div.get("count",0), *subs[:3], div.get("summary","")])

    # Persona summaries
    summaries = _persona_summaries(client, cards)
    _write_json(Path(OUT_DIR) / "persona_summaries.json", summaries)

    # Strategic summary
    strategic = _ai_strategic_summary(client, cards, overview)
    _write_json(Path(OUT_DIR) / "strategic_summary.json", strategic)

    # Detail CSVs
    top_cards = cards[:80]
    with (Path(OUT_DIR)/"voc_examples.csv").open("w",encoding="utf-8",newline="") as f:
        w = csv.writer(f)
        w.writerow(["date","domain","category","subcategory","personas","title","summary","url","score"])
        for c in top_cards:
            w.writerow([c["date"],c["domain"],c["voc_category"],c.get("voc_subcategory",""),
                        "|".join(c["personas"]),c["title"],c["summary"],c["url"],c["opportunity_score"]])

    with (Path(OUT_DIR)/"voc_detail.csv").open("w",encoding="utf-8",newline="") as f:
        w = csv.writer(f)
        w.writerow(["id","date","domain","category","subcategory","personas","title","one_liner",
                    "root_cause","workaround","jtbd","url","confidence","urgency","sentiment",
                    "behavioral_stage","value_chain_role","value_chain_origin"])
        for c in cards:
            w.writerow([c["id"],c["date"],c["domain"],c["voc_category"],c.get("voc_subcategory",""),
                        "|".join(c["personas"]),c["title"],c.get("one_liner",""),
                        c.get("root_cause",""),c.get("workaround",""),c.get("jtbd",""),c["url"],
                        c["confidence"],c.get("urgency",3),c.get("sentiment","neutral"),
                        c.get("behavioral_stage","Awareness"),
                        c.get("value_chain_role",""),c.get("value_chain_origin","")])

    # Rolling history
    hist_path = Path(OUT_DIR)/"voc_history.json"
    history: List[Dict[str,Any]] = []
    if hist_path.exists():
        try:
            history = json.loads(hist_path.read_text(encoding="utf-8"))
        except Exception:
            history = []
    history.append({"date": _now_utc(), "by_category": dict(cat_c)})
    _write_json(hist_path, history[-120:])

    # ── Supabase writes ──────────────────────────────────────────────────────
    # Runs after all local file writes. Non-fatal: DB failure never blocks git commit.
    try:
        from .supabase_writer import write_intel_cards, write_voc_daily_stats
        run_ts = _now_utc()
        # Write all_cards (full cumulative set) so the DB is authoritative
        sb_ok = write_intel_cards(all_cards, pipeline_run_at=run_ts)
        if sb_ok:
            # Write today's category stats using this run's new cards only
            write_voc_daily_stats(cards, pipeline_run_at=run_ts)
            logging.info(f"[summariser] Supabase writes complete ({len(all_cards)} cards, {len(cards)} new this run)")
        else:
            logging.warning("[summariser] Supabase intel_cards write returned False (check SUPABASE_SERVICE_ROLE_KEY)")
    except Exception as _sb_err:
        logging.warning(f"[summariser] Supabase write skipped: {_sb_err}")

def main():
    run()

if __name__ == "__main__":
    main()
