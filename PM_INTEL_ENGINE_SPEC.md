# PM Intel Engine — Product Spec
*September 2026 · Jordan Schimel*

---

## What It Is

A market intelligence operating system for product managers. You describe your domain in a config file and get a running dashboard that ingests 150+ sources daily, classifies signals against your taxonomy, quantifies practitioner pain, and delivers a daily brief — without manual research.

The fire-intel-agent is the reference implementation. This product is the domain-agnostic kernel extracted from it, with a widget builder, commercial infrastructure, and a model-awareness pipeline that auto-integrates new AI models the day they are available.

---

## The Problem It Solves

A PM at a mid-size SaaS company spends 4–6 hours/week manually reading trade press, G2 reviews, Reddit, and customer calls to understand their market. They get anecdotes, not data. They can't see trends over time. They can't quantify "how frustrated is the market about X vs. Y." They pay $15–50K/year for Crayon or Klue and get a vendor's taxonomy instead of their own.

ChatGPT doesn't solve this. It doesn't ingest live sources, accumulate signal over time, or quantify across a corpus. It's an analyst you have to ask, not a research operation that runs while you sleep.

---

## MLP (Minimum Lovable Product) Definition

The MLP is not the full platform. It is the smallest thing a paying PM team will actually love and renew.

**MLP = Domain config + live signal feed + quantified VOC overview + daily email brief**

Specifically:
1. A PM fills out `domain.yaml` (categories, personas, competitors, source list, search queries) — 20 minutes
2. The pipeline runs daily and populates a dashboard with signal cards, category breakdowns, and sentiment distribution
3. A daily email digest lands with the top 5 signals and a one-paragraph briefing
4. The PM can filter by persona, category, sentiment, and behavioral stage

That's it. No widget builder, no model marketplace, no enterprise auth yet. Just: "point it at your market, get a daily brief."

**MLP success criteria:**
- 3 paying teams outside fire & life safety running their own instance
- NPS ≥ 50 from those teams
- At least 1 team says "this replaced a manual process we were spending 4+ hours/week on"

---

## MVP → MLP Progression

### Phase 0: Kernel Extraction (now → 4 weeks)
Extract fire-intel-agent into a domain-agnostic `pm-intel-engine` repo.

Deliverables:
- `domain.yaml` with full comments and examples (3 sample domains: SaaS CRM, industrial manufacturing, fire safety)
- Dashboard with domain name/persona/category config driven entirely from YAML
- README: "from zero to running in 30 minutes"
- GitHub Actions workflow works out of the box with just `OPENAI_API_KEY`

### Phase 1: MLP Commercial Shell (weeks 4–10)
Add the minimum commercial infrastructure to charge money safely.

Deliverables:
- Auth: email+password with bcrypt hashing, JWT sessions, password reset
- Billing: Stripe Checkout, 3 tiers (Solo $49/mo, Team $149/mo, Pro $399/mo)
- Token budget enforcement: hard per-account daily token cap, soft warning at 80%
- EULA + Privacy Policy (see Legal section)
- Rate limiting: per-IP and per-account on all API endpoints
- Daily email digest via SendGrid or Resend (templated, unsubscribe link)
- Basic account management: change email, change password, delete account

### Phase 2: Widget Builder (weeks 10–18)
The differentiating feature. A PM describes a signal they want to track in plain English and the AI generates the search queries, heuristics, and card template.

User flow:
1. PM types: "I want to track how often facility managers mention that their inspection software fails offline"
2. Widget builder generates: 5 search queries, 8 heuristic keywords, a category + persona mapping, a card template with relevant fields
3. PM reviews, edits if needed, saves — widget is live in the next pipeline run
4. Widget results appear as a custom section in their dashboard

Technical path:
- Widget definition stored in `widgets.json` per account
- Pipeline runs widget queries in addition to domain-level queries
- Card classifier gets the widget definition as context for that source

### Phase 3: Model Marketplace (weeks 18–28)
Free and paid model integrations, surfaced as toggleable capabilities in the dashboard.

Free tier models (zero marginal cost):
- HuggingFace: bart-large-mnli (classification), roberta-base-sentiment (sentiment), bart-large-cnn (summarization)
- Ollama local: any model the user runs themselves

Paid tier models (upcharge to user):
- GPT-4o: $0.02/card classify (already implemented)
- Claude 3.5 Sonnet: alternative classify/summarize
- Gemini 1.5 Pro: multimodal (for image-based signals: app screenshots, charts)
- Perplexity API: web-grounded summarization

Model awareness pipeline:
- Daily job monitors HuggingFace trending, arXiv papers tagged `nlp` + `text-classification`, GitHub releases for key model repos
- When a new relevant model is detected: auto-creates a GitHub issue with benchmark comparison, estimated cost, integration complexity
- If the model passes a quality gate (auto-benchmarked against 50 held-out signals), a PR is opened with the integration
- Human review required before merge to prod

---

## User Flow (Widget Builder Detail)

```
[Dashboard] → [+ Add Widget]
    ↓
[Widget Builder chat interface]
  "Describe the market signal you want to track:"
  > "I want to know when fire chiefs complain about CAD integration with mutual aid"
    ↓
  AI generates:
    Name: "CAD Mutual Aid Integration Pain"
    Queries: ["CAD mutual aid fire department problem", "dispatch integration failure fire"]
    Keywords: ["mutual aid", "cad", "dispatch", "interoperability", "two versions of truth"]
    Category: "Data & System Integration"
    Persona: "Fire Chief"
    Template: {title, root_cause, workaround, stat, confidence}
    ↓
  [Preview] → [Edit] → [Save Widget]
    ↓
  Widget runs on next pipeline cycle
  Results appear in dashboard under custom section
  Email digest includes widget highlights
```

---

## Architecture

```
[Domain Config YAML]
        ↓
[Scraper + Web Search]  ←── 150+ sources (RSS, Reddit, ArcGIS, APIs)
        ↓
[HF Pre-filter]  ←── free: bart-mnli, roberta-sentiment (graceful fallback)
        ↓
[LLM Classify]   ←── OpenAI/Claude/Gemini (paid, per-token budget enforced)
        ↓
[VOC Stagegate]  ←── rejects noise, classifies into domain taxonomy
        ↓
[Cards JSON]     ←── accumulated, deduplicated, scored
        ↓
[Dashboard]      ←── static HTML + JS, deployed to Vercel/CDN
        ↓
[Daily Digest]   ←── email via Resend/SendGrid
```

Account/billing layer sits in front of the pipeline runner and enforces:
- Token budget per tier per day
- Model selection per tier
- Widget count per tier

---

## Commercial Tiers

| Tier | Price | Domains | Widgets | Models | Token budget/day | Sources |
|---|---|---|---|---|---|---|
| Solo | $49/mo | 1 | 5 | Free HF + gpt-4o-mini | 500K | 50 |
| Team | $149/mo | 3 | 20 | + gpt-4o | 2M | 150 |
| Pro | $399/mo | 10 | unlimited | + Claude/Gemini | 10M | unlimited |
| Enterprise | custom | unlimited | unlimited | all | custom | custom |

Overage: hard block at budget limit with clear UI message. No surprise bills. Ever.

---

## Security & Cyber Hardening

### Authentication
- bcrypt password hashing (cost factor 12)
- JWT access tokens (15 min expiry) + refresh tokens (30 days, httpOnly cookie)
- Email verification required on signup
- Password reset via time-limited token (1 hour)
- No OAuth initially — adds attack surface before we need it
- Account lockout after 10 failed login attempts (1 hour lockout)

### API Security
- Rate limiting: 100 req/min per IP (global), 1000 req/day per account (API)
- All endpoints: input validation, max request body size (1MB)
- SQL injection protection: parameterized queries only, no string concatenation
- CORS: explicit allowlist only
- Security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options
- HTTPS only, TLS 1.2+
- API keys hashed in DB (SHA-256), never stored plaintext
- Secrets: environment variables only, never in code or logs

### Token Budget Enforcement
- Hard daily cap per account tier enforced server-side, not client-side
- Budget check before every LLM call — if budget exceeded, call is blocked
- Budget resets at midnight UTC
- Audit log: every LLM call logged with token count, model, account ID
- Alert at 80% of daily budget (email to account owner)
- Monthly cap = daily cap × 31 (prevents billing surprise on high-traffic days)

### Data Handling
- No training on user data. Ever. This is a hard architectural constraint, not a policy.
  - Pipeline processes public web content only
  - User config (domain.yaml, widgets) stored but never sent to model providers as training data
  - OpenAI/Anthropic/HF API calls use their standard API (inference only, not fine-tuning)
  - Model providers' standard API terms apply: they do not train on API inputs by default (OpenAI: confirmed for API calls; Anthropic: confirmed; HF Inference API: confirmed for private calls)
- No PII storage beyond: email (for auth), hashed password, billing info (Stripe-hosted, never in our DB)
- Signal content processed and discarded after classification — only the extracted card fields stored
- User can delete their account and all data within 30 days (GDPR/CCPA compliance)
- Data residency: US-East by default, EU option at Pro tier

### Payment Security
- Stripe Checkout only — card numbers never touch our servers
- Stripe webhook signature verification on all webhook events
- Idempotency keys on all payment API calls
- Failed payment grace period: 3 days with email warnings before service suspension

---

## Legal

### What We Need Before Launch
1. **EULA** — covers: acceptable use, no warranty, liability cap, IP ownership (user owns their config and outputs, we own the platform), termination
2. **Privacy Policy** — covers: what we collect (email, usage logs), what we don't collect (user data content, PII from scraped sources), no training on user data, deletion rights, GDPR/CCPA compliance
3. **Terms of Service** — covers: subscription terms, payment, refunds, account suspension

### Key Clauses to Nail Down
- **"No training on your data"**: We process public web signals on your behalf. We do not use your domain config, widget definitions, or signal outputs to train any model. Model providers' standard API terms apply.
- **"We don't store source content"**: Raw scraped text is processed and discarded. We store only classified card fields (title, category, sentiment, confidence, URL).
- **"Token budget is hard"**: We enforce a hard daily token limit. If you hit it, processing stops. We are not liable for delayed intelligence on days the budget is reached.
- **"Public domain content"**: We scrape publicly accessible web pages. We do not circumvent paywalls. Content copyright remains with original publishers.

### Enterprise Pitch
The "no training on user data" architecture means enterprise customers can safely use this with their internal competitive intelligence without fear of data leakage to model providers. This is a genuine differentiator vs. tools that use user interactions to improve their models.

---

## Model Awareness Pipeline

### How It Works
A daily GitHub Actions job:
1. Queries HuggingFace API for models newly released in the last 48h, filtered by task: `text-classification`, `summarization`, `zero-shot-classification`, `sentiment-analysis`
2. Queries arXiv for papers tagged with those tasks + "instruction-following" + "benchmark"
3. Monitors GitHub releases for: `facebookresearch`, `google-research`, `microsoft`, `mistralai`, `meta-llama`, `anthropics`, `openai`
4. Filters: model must be either (a) free on HF Inference API or (b) available on OpenRouter/major provider API

### Auto-Integration Gate
When a candidate model passes the filter:
1. Auto-benchmark on 50 held-out fire & life safety signals (ground truth from current best model)
2. Compute: accuracy vs. current model, latency, cost per 1K tokens
3. If accuracy ≥ current model - 5% AND cost < current model: open GitHub PR with integration code
4. PR requires human review + merge — nothing auto-deploys to production model path
5. After merge: runs in shadow mode (parallel to current model, results logged but not served) for 3 days
6. After shadow validation: promoted to production for that tier

### Paid Model Onboarding
When a new paid model is available:
1. Integration PR opened (same flow as free)
2. Pricing added to tier config: cost per 1K tokens → per-card cost → customer upcharge
3. Feature flagged per account tier
4. Release notes auto-generated from arXiv abstract + benchmark results

---

## Salesforce Angle

The most direct path to Salesforce interest is not "build a product and pitch them." It's:

1. Launch publicly with a strong free tier that gets PM adoption at Salesforce ISV partners and SI firms
2. Publish a case study: "How a PM team replaced 5 hours/week of manual research with pm-intel-engine"
3. Submit to Salesforce AppExchange — their review process takes 4–8 weeks but puts it in front of 150K+ orgs
4. The integration story: pm-intel-engine signals feed directly into Salesforce as Opportunity signals, Account intelligence, and Product Gap objects

The AppExchange angle is actually the right first enterprise channel. Salesforce will either (a) acquire it if it gets traction on the Exchange, or (b) become a distribution partner. Either outcome is good.

---

## Competitive Moat

Short-term (before copying is easy):
- Domain configurability — Crayon/Klue are locked to their taxonomy
- GitHub-native — your data lives in your repo, not in a vendor's SaaS
- Cost: $49/mo vs. $15–50K/year

Long-term (what makes it defensible):
- Signal accumulation — the longer it runs, the more historical baseline you have
- Domain fine-tuning — a pm-intel-engine instance trained on 12 months of fire-service signals will classify fire-service signals better than a generic classifier
- Widget library — as users build widgets, the library becomes a moat ("250 pre-built market intelligence templates")
- Model marketplace — first platform to surface and integrate new relevant AI models in the PM research space

---

## What Not to Build Yet

- Mobile app — dashboard is fine on mobile browser
- Slack integration — distraction until MLP validated
- Team collaboration features — solo PM use case first
- Custom LLM fine-tuning — too expensive, too complex, and legally fraught before the data policy is fully hardened
- Enterprise SSO — add at Pro tier once there's demand

---

## Open Questions

1. **Hosting model**: Vercel (current) works for the static dashboard. The pipeline needs GitHub Actions (already set up) or a cron service. No server needed until the widget builder requires real-time API.
2. **DB**: Currently file-based (JSON + SQLite). Supabase (already integrated) is the right move for multi-tenant. Already partially done.
3. **First non-fire domain**: Industrial manufacturing (StealthRFQ's world) is the obvious second instance — Jordan already knows the domain deeply.
4. **Pricing validation**: Does $49/mo clear the "not worth thinking about" bar for a mid-size PM team? Likely yes — that's less than one hour of a PM's time.

---

*Status: Phase 0 (kernel extraction) ready to begin. Fire-intel-agent is the reference implementation. New repo: `pm-intel-engine` (to be created).*
