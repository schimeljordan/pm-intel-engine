# PM Intel Engine

> Market intelligence OS for product managers — domain-configurable signal ingestion, VOC quantification, widget builder, and model-aware auto-upgrade pipeline.

**Live reference implementation:** [fire-intel-agent](https://github.com/schimeljordan/fire-intel-agent) · [fire-intel-agent.vercel.app](https://fire-intel-agent.vercel.app)

---

## What It Does

Point it at your market. Get a daily intelligence dashboard.

The pipeline runs every weekday, ingests 150+ sources, classifies signals against your taxonomy using a free HuggingFace model + OpenAI fallback, quantifies practitioner pain by category and persona, and commits a refreshed static dashboard to your repo — which you deploy to Vercel in one command.

You configure your domain in `config.yaml`. Nothing else requires code changes.

---

## 30-Minute Setup

### 1. Fork and clone

```bash
git clone https://github.com/YOUR_ORG/pm-intel-engine
cd pm-intel-engine
```

### 2. Configure your domain

Edit `config.yaml` — set your domain name, personas, categories, competitors, and search queries. See `configs/` for three complete examples:

| Config | Domain |
|---|---|
| `configs/fire-life-safety.yaml` | Fire & Life Safety (reference implementation) |
| `configs/industrial-manufacturing.yaml` | Industrial Manufacturing / B2G |
| `configs/saas-crm.yaml` | CRM & Sales Technology |

### 3. Add GitHub Secrets

Go to **Settings → Secrets → Actions** and add:

| Secret | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | GPT-4o-mini for classification + summarization |
| `HF_API_KEY` | No | Free HuggingFace tier (graceful fallback if missing) |
| `REDDIT_CLIENT_ID` | No | Reddit API for community signal ingest |
| `REDDIT_CLIENT_SECRET` | No | Reddit API secret |
| `REDDIT_USER_AGENT` | No | Reddit user agent string |
| `REDDIT_USERNAME` | No | Reddit account username |
| `REDDIT_PASSWORD` | No | Reddit account password |
| `GOOGLE_MAPS_KEY` | No | Google Maps API key for the map view |

### 4. Deploy to Vercel

```bash
npm i -g vercel
vercel deploy --prod
```

The pipeline commits to `dashboard/` on each run. Vercel auto-deploys on push.

### 5. Run the first pipeline

Go to **Actions → Daily PM Intel Pipeline → Run workflow**.

Your dashboard populates in ~20 minutes.

---

## How It Works

```
config.yaml
    │
    ├── agent/scraper.py          RSS + page sources
    ├── agent/web_search.py       Google/Bing/DDG via configured queries
    ├── agent/reddit_ingest.py    Subreddit posts + comments
    ├── agent/gdelt_intel.py      GDELT news event signals
    ├── agent/sec_intel.py        SEC EDGAR filings (competitor 10-K/8-K)
    ├── agent/patent_intel.py     USPTO patent filings
    ├── agent/grants_intel.py     Grants.gov awards
    ├── agent/rfp_intel.py        SAM.gov procurement signals
    │
    ├── agent/hf_client.py        HuggingFace pre-filter (free, graceful fallback)
    ├── agent/summariser.py       LLM classify + JTBD summarise
    ├── agent/voc_stagegate.py    VOC taxonomy enforcement
    │
    ├── agent/signal_analytics.py VOC trend computation
    ├── agent/build_dashboard.py  Static dashboard asset generation
    │
    └── dashboard/                Deployed to Vercel
```

All domain-specific values (category names, persona labels, search queries, source URLs) live in `config.yaml`. The agent code is fully generic.

---

## Key Design Constraints

These are non-negotiable and preserved across all future updates:

- **No training on user data.** Pipeline processes publicly available web content only. OpenAI/HuggingFace API calls use their standard inference APIs — providers do not train on API inputs by default. We never send customer config or outputs to model providers for training.
- **No PII storage beyond auth.** Signal content is processed and discarded; only classified card fields are stored.
- **Graceful fallback everywhere.** If OpenAI quota is exhausted, the pipeline degrades to HuggingFace. If HuggingFace is unavailable, it degrades to heuristic classification. The dashboard never goes blank.
- **Token budget enforcement.** Every LLM call checks a per-run token budget before executing. Set `token_budget_per_run` in `config.yaml`. Default: 2M tokens/day.
- **Human review required for model promotions.** The model watcher opens GitHub issues and PRs — it never auto-promotes a new model to production.

---

## Model Awareness Pipeline

The `model-watch.yml` workflow runs daily and scans:

- **HuggingFace** — trending models for `text-classification`, `zero-shot-classification`, `summarization`, `sentiment-analysis` with >10K downloads
- **arXiv** — new `cs.CL` papers tagged with benchmark + classification/summarization

When a candidate is found, it opens a GitHub Issue with evaluation instructions. You benchmark it against 50 held-out signals, open a PR with the integration in `agent/hf_client.py`, run 3 days of shadow mode, then promote.

---

## Roadmap

| Phase | Status | Description |
|---|---|---|
| Kernel extraction | ✅ Done | This repo — domain-agnostic, config-driven |
| MLP commercial shell | 🔜 Next | Auth, Stripe billing, token limits, EULA, daily email |
| Widget builder | 📋 Planned | Natural-language signal widget creation UI |
| Model marketplace | 📋 Planned | Free + paid model tiers, auto-integration pipeline |
| AppExchange listing | 📋 Planned | Salesforce distribution channel |

See `PM_INTEL_ENGINE_SPEC.md` for the full product spec.

---

## File Structure

```
pm-intel-engine/
├── config.yaml              ← YOUR domain config (edit this)
├── configs/
│   ├── fire-life-safety.yaml
│   ├── industrial-manufacturing.yaml
│   └── saas-crm.yaml
├── agent/
│   ├── scraper.py           web + RSS ingest
│   ├── web_search.py        search engine ingest
│   ├── reddit_ingest.py     reddit ingest
│   ├── summariser.py        LLM classify + JTBD summary
│   ├── voc_stagegate.py     VOC taxonomy gate
│   ├── hf_client.py         HuggingFace inference (graceful fallback)
│   ├── llm_client.py        OpenAI client wrapper
│   ├── build_dashboard.py   static asset generation
│   ├── model_watcher.py     new model detection
│   ├── signal_analytics.py  VOC trend computation
│   └── ...                  (intel modules: GDELT, SEC, patents, grants, RFPs)
├── dashboard/               deployed to Vercel
│   ├── index.html
│   ├── map.html
│   ├── app.js
│   ├── style.css
│   ├── domain.json          ← generated from config.yaml by build_dashboard.py
│   └── ...
├── .github/workflows/
│   ├── daily.yml            daily pipeline
│   └── model-watch.yml      daily model awareness scan
├── vercel.json
└── requirements.txt
```

---

## License

MIT. The reference fire-intel-agent implementation at [schimeljordan/fire-intel-agent](https://github.com/schimeljordan/fire-intel-agent) is also MIT.

---

*Built from the fire-intel-agent kernel. Enterprise-safe: inference-only, no user data training, no PII beyond auth.*
