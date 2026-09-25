/**
 * creator.js — Domain wizard logic + GitHub API auto-commit
 *
 * No external libraries. Vanilla ES modules.
 * All GitHub API calls made directly from the browser using the user's PAT.
 * PAT stored only in localStorage — never sent anywhere except api.github.com.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STORAGE_KEY = "creator_wizard_state";

const DEFAULT_PERSONAS = [
  { key: "fire_chief",       label: "Fire Chief" },
  { key: "fire_marshal",     label: "Fire Marshal / Prevention" },
  { key: "fire_inspector",   label: "Fire Inspector" },
  { key: "ahj",              label: "AHJ" },
  { key: "facility_manager", label: "Facility Manager" },
];

const DEFAULT_COMPETITORS = [
  { name: "", url: "", pricing: "", primary_value: "", positives: "", negatives: "" },
];

let currentStep = 1;

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------

function showStep(n) {
  document.querySelectorAll(".wizard-step").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".progress-step").forEach(s => {
    const sn = parseInt(s.dataset.step);
    s.classList.remove("active", "done");
    if (sn === n) s.classList.add("active");
    else if (sn < n) s.classList.add("done");
  });
  const el = document.querySelector(`.wizard-step[data-step="${n}"]`);
  if (el) {
    el.classList.add("active");
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  currentStep = n;
  saveState();
}

// ---------------------------------------------------------------------------
// Persona table
// ---------------------------------------------------------------------------

function renderPersonas(personas) {
  const tbody = document.getElementById("personas-body");
  tbody.innerHTML = "";
  personas.forEach((p, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" class="persona-key" value="${escHtml(p.key)}" placeholder="key_name" /></td>
      <td><input type="text" class="persona-label" value="${escHtml(p.label)}" placeholder="Display Label" /></td>
      <td><button class="del-btn" data-i="${i}" title="Remove">✕</button></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const rows = getPersonas();
      rows.splice(parseInt(btn.dataset.i), 1);
      renderPersonas(rows);
    });
  });
}

function getPersonas() {
  return Array.from(document.querySelectorAll("#personas-body tr")).map(tr => ({
    key:   tr.querySelector(".persona-key")?.value.trim() || "",
    label: tr.querySelector(".persona-label")?.value.trim() || "",
  })).filter(p => p.key || p.label);
}

// ---------------------------------------------------------------------------
// Competitor card accordion
// ---------------------------------------------------------------------------

function renderCompetitors(competitors) {
  const list = document.getElementById("competitors-list");
  list.innerHTML = "";
  competitors.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "comp-card";
    card.dataset.i = i;
    card.innerHTML = `
      <div class="comp-card-header">
        <input type="text" class="comp-name" value="${escHtml(c.name)}"
               placeholder="Vendor Name (required)" aria-label="Vendor name" />
        <input type="url" class="comp-url" value="${escHtml(c.url)}"
               placeholder="https://example.com" aria-label="Website URL" />
        <button class="comp-toggle-btn" type="button" aria-expanded="false"
                title="Add details">Details ▾</button>
        <button class="del-btn" type="button" title="Remove">✕</button>
      </div>
      <div class="comp-card-details" hidden>
        <div class="comp-details-grid">
          <div class="field-mini">
            <label>Pricing</label>
            <input type="text" class="comp-pricing" value="${escHtml(c.pricing)}"
                   placeholder="e.g. $49/month, quote-based" />
          </div>
          <div class="field-mini">
            <label>Primary Value Prop</label>
            <input type="text" class="comp-value" value="${escHtml(c.primary_value)}"
                   placeholder="Main selling point in one sentence" />
          </div>
          <div class="field-mini">
            <label>Strengths <span class="comp-hint">(one per line)</span></label>
            <textarea class="comp-pos" rows="3" placeholder="Easy mobile workflow&#10;Strong compliance coverage">${escHtml(c.positives)}</textarea>
          </div>
          <div class="field-mini">
            <label>Weaknesses <span class="comp-hint">(one per line)</span></label>
            <textarea class="comp-neg" rows="3" placeholder="No API&#10;Expensive at scale">${escHtml(c.negatives)}</textarea>
          </div>
        </div>
      </div>
    `;

    card.querySelector(".comp-toggle-btn").addEventListener("click", function () {
      const details = card.querySelector(".comp-card-details");
      const open = !details.hidden;
      details.hidden = open;
      this.textContent = open ? "Details ▾" : "Details ▴";
      this.setAttribute("aria-expanded", String(!open));
    });

    card.querySelector(".del-btn").addEventListener("click", () => {
      const current = getCompetitors();
      current.splice(parseInt(card.dataset.i), 1);
      renderCompetitors(current);
    });

    list.appendChild(card);
  });
}

function getCompetitors() {
  return Array.from(document.querySelectorAll("#competitors-list .comp-card")).map(card => ({
    name:          card.querySelector(".comp-name")?.value.trim() || "",
    url:           card.querySelector(".comp-url")?.value.trim() || "",
    pricing:       card.querySelector(".comp-pricing")?.value.trim() || "",
    primary_value: card.querySelector(".comp-value")?.value.trim() || "",
    positives:     card.querySelector(".comp-pos")?.value.trim() || "",
    negatives:     card.querySelector(".comp-neg")?.value.trim() || "",
  })).filter(c => c.name || c.url);
}

// ---------------------------------------------------------------------------
// Emoji picker
// ---------------------------------------------------------------------------

function initEmojiPicker() {
  document.getElementById("emoji-grid").addEventListener("click", e => {
    const btn = e.target.closest(".emoji-btn");
    if (!btn) return;
    document.querySelectorAll(".emoji-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    document.getElementById("domain-icon").value = btn.dataset.emoji;
  });
}

// ---------------------------------------------------------------------------
// State persistence (localStorage)
// ---------------------------------------------------------------------------

function saveState() {
  try {
    const state = {
      step: currentStep,
      name: document.getElementById("domain-name").value,
      slug: document.getElementById("domain-slug").value,
      shortName: document.getElementById("domain-short-name").value,
      description: document.getElementById("domain-description").value,
      icon: document.getElementById("domain-icon").value,
      personas: getPersonas(),
      categories: document.getElementById("categories-text").value,
      competitors: getCompetitors(),
      sourcesRss: document.getElementById("sources-rss").value,
      sourcesPages: document.getElementById("sources-pages").value,
      sourcesReddit: document.getElementById("sources-reddit").value,
      sourcesQueries: document.getElementById("sources-queries").value,
      ghOwner: document.getElementById("gh-owner").value,
      ghRepo: document.getElementById("gh-repo").value,
      ghBranch: document.getElementById("gh-branch").value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) { /* ignore */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.name)        document.getElementById("domain-name").value = s.name;
    if (s.slug)        document.getElementById("domain-slug").value = s.slug;
    if (s.shortName)   document.getElementById("domain-short-name").value = s.shortName;
    if (s.description) document.getElementById("domain-description").value = s.description;
    if (s.icon) {
      document.getElementById("domain-icon").value = s.icon;
      document.querySelectorAll(".emoji-btn").forEach(b => {
        b.classList.toggle("selected", b.dataset.emoji === s.icon);
      });
    }
    if (s.personas?.length) renderPersonas(s.personas);
    if (s.categories)   document.getElementById("categories-text").value = s.categories;
    // Restore competitors even if saved as empty array (user intentionally cleared them)
    if (Array.isArray(s.competitors)) renderCompetitors(s.competitors);
    if (s.sourcesRss)   document.getElementById("sources-rss").value = s.sourcesRss;
    if (s.sourcesPages) document.getElementById("sources-pages").value = s.sourcesPages;
    if (s.sourcesReddit) document.getElementById("sources-reddit").value = s.sourcesReddit;
    if (s.sourcesQueries) document.getElementById("sources-queries").value = s.sourcesQueries;
    if (s.ghOwner)  document.getElementById("gh-owner").value = s.ghOwner;
    if (s.ghRepo)   document.getElementById("gh-repo").value = s.ghRepo;
    if (s.ghBranch) document.getElementById("gh-branch").value = s.ghBranch;
    // Restore PAT from separate storage key
    const pat = localStorage.getItem("gh_pat");
    if (pat) document.getElementById("gh-pat").value = pat;
    if (s.step && s.step > 1) showStep(s.step);
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// YAML generation
// ---------------------------------------------------------------------------

function collectFormData() {
  const personas = getPersonas();
  const competitors = getCompetitors();
  const categories = document.getElementById("categories-text").value
    .split("\n").map(s => s.trim()).filter(Boolean);
  const rssFeeds = document.getElementById("sources-rss").value
    .split("\n").map(s => s.trim()).filter(s => s.startsWith("http"));
  const webPages = document.getElementById("sources-pages").value
    .split("\n").map(s => s.trim()).filter(s => s.startsWith("http"));
  const subreddits = document.getElementById("sources-reddit").value
    .split(",").map(s => s.trim().replace(/^r\//, "")).filter(Boolean);
  const queries = document.getElementById("sources-queries").value
    .split("\n").map(s => s.trim()).filter(Boolean);

  return {
    name: document.getElementById("domain-name").value.trim(),
    slug: document.getElementById("domain-slug").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    shortName: document.getElementById("domain-short-name").value.trim(),
    description: document.getElementById("domain-description").value.trim(),
    icon: document.getElementById("domain-icon").value || "📊",
    personas,
    categories,
    rssFeeds,
    webPages,
    subreddits,
    queries,
    competitors,
  };
}

function generateConfigYaml(d) {
  const personasYaml = d.personas.map(p =>
    `    - { key: ${yamlStr(p.key)}, label: ${yamlStr(p.label)} }`
  ).join("\n");

  const categoriesYaml = d.categories.map(c =>
    `    - ${yamlStr(c)}`
  ).join("\n");

  const rssYaml = d.rssFeeds.map(u =>
    `  - { type: rss, url: ${yamlStr(u)} }`
  ).join("\n");

  const pagesYaml = d.webPages.map(u =>
    `  - { type: page, url: ${yamlStr(u)} }`
  ).join("\n");

  const redditYaml = d.subreddits.map(s =>
    `    - ${yamlStr(s)}`
  ).join("\n");

  const queriesYaml = d.queries.map(q =>
    `    - ${yamlStr(q)}`
  ).join("\n");

  return `# Auto-generated by Intel Domain Creator
# Domain: ${d.name}

domain:
  name: ${yamlStr(d.name)}
  short_name: ${yamlStr(d.shortName || d.name)}
  description: ${yamlStr(d.description)}
  icon: ${yamlStr(d.icon)}
  personas:
${personasYaml || "    []"}
  categories:
${categoriesYaml || "    []"}

competitors_path: data/${d.slug}/competitors.yaml

storage:
  db_path: data/${d.slug}/scraper.db

crawler:
  user_agent: "${d.slug}-intel-agent/1.0 (+github actions)"
  timeout_seconds: 30
  min_delay_seconds: 1.4
  delay_jitter_seconds: 0.8
  max_articles_per_site: 300

web_search:
  queries:
${queriesYaml || "    []"}
  results_per_query: 50
  recency_days: 365
  engines:
    - google_news_rss
    - bing_news_rss
    - duckduckgo
  site_limit_per_domain: 50
  block_domains:
    - pinterest.com
    - facebook.com
    - linkedin.com
    - youtube.com
    - x.com
    - twitter.com
    - instagram.com
    - tiktok.com

reddit:
  subreddits:
${redditYaml || "    []"}
  post_limit: 100
  recency_days: 30
  min_score: 5

sources:
${(rssYaml ? rssYaml + "\n" : "") + (pagesYaml || "  []")}

self_improve:
  enabled: true
  max_new_sources_per_run: 5
  max_new_queries_per_run: 3
  max_new_competitors_per_run: 2
  min_confidence_to_commit: 60
  dry_run: false
`;
}

function generateCompetitorsYaml(d) {
  if (!d.competitors.length) return "competitors: {}\n";

  const entries = d.competitors.map(c => {
    const key = c.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const positives = c.positives ? c.positives.split("\n").map(s => s.trim()).filter(Boolean).map(s => `      - ${yamlStr(s)}`).join("\n") : "      []";
    const negatives = c.negatives ? c.negatives.split("\n").map(s => s.trim()).filter(Boolean).map(s => `      - ${yamlStr(s)}`).join("\n") : "      []";
    return `  ${key}:
    name: ${yamlStr(c.name)}
    url: ${yamlStr(c.url)}
    pricing: ${yamlStr(c.pricing)}
    primary_value: ${yamlStr(c.primary_value)}
    positives:
${positives}
    negatives:
${negatives}`;
  }).join("\n\n");

  return `competitors:\n${entries}\n`;
}

// Minimal YAML string quoting — wrap in double quotes, escape backslashes and quotes
function yamlStr(s) {
  if (!s) return '""';
  const safe = String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${safe}"`;
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function githubPut(pat, owner, repo, path, content, message) {
  const headers = {
    "Authorization": `Bearer ${pat}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
  // Check if file exists (need SHA for update)
  let sha = null;
  try {
    const check = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers }
    );
    if (check.ok) {
      const data = await check.json();
      sha = data.sha || null;
    }
  } catch (_) { /* new file */ }

  // Safe Unicode → base64 via TextEncoder (avoids deprecated unescape)
  const encoded = (() => {
    const bytes = new TextEncoder().encode(content);
    let bin = "";
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin);
  })();
  const body = { message, content: encoded };
  if (sha) body.sha = sha;

  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { method: "PUT", headers, body: JSON.stringify(body) }
  );
  if (!resp.ok) {
    const raw = await resp.text();
    let msg = `GitHub API error (HTTP ${resp.status})`;
    try {
      const parsed = JSON.parse(raw);
      if (resp.status === 401) msg = "Authentication failed — check your PAT is valid and not expired.";
      else if (resp.status === 403) msg = "Permission denied — ensure your PAT has 'repo' scope and you have write access.";
      else if (resp.status === 404) msg = `Repository not found — check owner and repo name are correct.`;
      else msg = parsed.message || msg;
    } catch (_) { /* raw text fallback */ }
    throw new Error(`${msg} (writing ${path})`);
  }
  return resp.json();
}

async function githubDispatch(pat, owner, repo, branch, configPath) {
  const headers = {
    "Authorization": `Bearer ${pat}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
  // Try both possible workflow file names
  for (const wf of ["daily.yml", "daily.yaml"]) {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ref: branch, inputs: { config: configPath } }),
      }
    );
    if (resp.status === 204 || resp.ok) return true;
  }
  // Non-fatal — workflow dispatch is best-effort
  console.warn("workflow_dispatch returned non-204 for both workflow names");
  return false;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function setStatus(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status-icon ${state}`;
  if (state === "running") el.textContent = "⟳";
  else if (state === "done") el.textContent = "✓";
  else if (state === "error") el.textContent = "✕";
}

function showError(msg) {
  const el = document.getElementById("deploy-error");
  el.textContent = msg;
  el.style.display = "block";
  document.getElementById("deploy-success").style.display = "none";
}

function showSuccess(msg) {
  const el = document.getElementById("deploy-success");
  el.textContent = msg;
  el.style.display = "block";
  document.getElementById("deploy-error").style.display = "none";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateStep(step) {
  if (step === 1) {
    const name = document.getElementById("domain-name").value.trim();
    const slug = document.getElementById("domain-slug").value.trim();
    if (!name) { alert("Domain Name is required."); return false; }
    if (!slug)  { alert("Short Slug is required."); return false; }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      alert("Slug must be lowercase letters, numbers, and hyphens only.");
      return false;
    }
  }
  if (step === 3) {
    const cats = document.getElementById("categories-text").value.trim();
    if (!cats) { alert("Please enter at least one category."); return false; }
  }
  if (step === 6) {
    const owner = document.getElementById("gh-owner").value.trim();
    const repo  = document.getElementById("gh-repo").value.trim();
    const pat   = document.getElementById("gh-pat").value.trim();
    if (!owner) { alert("GitHub owner is required."); return false; }
    if (!repo)  { alert("Repository name is required."); return false; }
    if (!pat)   { alert("GitHub PAT is required."); return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Auto-fill slug from name
// ---------------------------------------------------------------------------

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

async function deploy() {
  if (!validateStep(6)) return;

  const owner  = document.getElementById("gh-owner").value.trim();
  const repo   = document.getElementById("gh-repo").value.trim();
  const branch = document.getElementById("gh-branch").value.trim() || "main";
  const pat    = document.getElementById("gh-pat").value.trim();

  // Persist PAT in its own key
  localStorage.setItem("gh_pat", pat);

  const d = collectFormData();
  const configYaml = generateConfigYaml(d);
  const competitorsYaml = generateCompetitorsYaml(d);

  const deployBtn = document.getElementById("deploy-btn");
  deployBtn.disabled = true;
  document.getElementById("deploy-error").style.display = "none";
  document.getElementById("deploy-success").style.display = "none";
  document.getElementById("deploy-status").style.display = "block";

  const configPath      = `configs/${d.slug}.yaml`;
  const competitorsPath = `data/${d.slug}/competitors.yaml`;

  try {
    // 1. Write configs/{slug}.yaml
    setStatus("s-config", "running");
    await githubPut(pat, owner, repo, configPath, configYaml,
      `feat: domain config for ${d.name} [creator]`);
    setStatus("s-config", "done");

    // 2. Write data/{slug}/competitors.yaml
    setStatus("s-competitors", "running");
    await githubPut(pat, owner, repo, competitorsPath, competitorsYaml,
      `feat: competitors for ${d.name} [creator]`);
    setStatus("s-competitors", "done");

    // 3. Trigger workflow with domain-specific config path
    setStatus("s-dispatch", "running");
    await githubDispatch(pat, owner, repo, branch, configPath);
    setStatus("s-dispatch", "done");

    showSuccess(
      `✓ Domain "${d.name}" deployed! Config at ${configPath}. ` +
      `Check GitHub Actions for pipeline progress. ` +
      `Your dashboard will update after the pipeline completes.`
    );
  } catch (err) {
    const failedId = document.querySelector(".status-icon.running")?.id;
    if (failedId) setStatus(failedId, "error");
    showError(`Deploy failed: ${err.message}`);
  } finally {
    deployBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  // Render initial tables
  renderPersonas(DEFAULT_PERSONAS);
  renderCompetitors(DEFAULT_COMPETITORS);

  // Emoji picker
  initEmojiPicker();

  // Auto-slug from name
  document.getElementById("domain-name").addEventListener("input", e => {
    const slugEl = document.getElementById("domain-slug");
    if (!slugEl.dataset.userEdited) {
      slugEl.value = slugify(e.target.value);
    }
  });
  document.getElementById("domain-slug").addEventListener("input", function () {
    this.dataset.userEdited = "1";
  });

  // Progress bar click navigation
  document.querySelectorAll(".progress-step").forEach(s => {
    s.addEventListener("click", () => {
      const n = parseInt(s.dataset.step);
      if (n < currentStep || validateStep(currentStep)) showStep(n);
    });
  });

  // Next/prev buttons
  document.querySelectorAll("[data-next]").forEach(btn => {
    btn.addEventListener("click", () => {
      const n = parseInt(btn.dataset.next);
      if (validateStep(n - 1)) showStep(n);
    });
  });
  document.querySelectorAll("[data-prev]").forEach(btn => {
    btn.addEventListener("click", () => showStep(parseInt(btn.dataset.prev)));
  });

  // Step 1 explicit next button
  document.getElementById("step1-next").addEventListener("click", () => {
    if (validateStep(1)) showStep(2);
  });

  // Add persona button
  document.getElementById("add-persona").addEventListener("click", () => {
    const rows = getPersonas();
    rows.push({ key: "", label: "" });
    renderPersonas(rows);
  });

  // Add competitor button
  document.getElementById("add-competitor").addEventListener("click", () => {
    const rows = getCompetitors();
    rows.push({ name: "", url: "", pricing: "", primary_value: "", positives: "", negatives: "" });
    renderCompetitors(rows);
  });

  // PAT show/hide toggle
  document.getElementById("pat-toggle").addEventListener("click", function () {
    const input = document.getElementById("gh-pat");
    if (input.type === "password") {
      input.type = "text";
      this.textContent = "Hide";
    } else {
      input.type = "password";
      this.textContent = "Show";
    }
  });

  // Preview buttons
  function refreshPreview() {
    const d = collectFormData();
    document.getElementById("yaml-preview").textContent = generateConfigYaml(d);
  }
  document.getElementById("preview-btn").addEventListener("click", refreshPreview);
  document.getElementById("preview-btn-nav").addEventListener("click", refreshPreview);

  // Deploy button
  document.getElementById("deploy-btn").addEventListener("click", deploy);

  // Autosave on input
  document.querySelector(".creator-body").addEventListener("input", saveState);

  // Load persisted state (restores form values and step)
  loadState();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
