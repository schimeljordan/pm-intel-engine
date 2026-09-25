"use strict";

/**
 * settings.js — Source management, AI suggestions approval, metadata editing.
 *
 * Architecture:
 *  - Reads sources_config.json (pipeline-generated, includes pending_suggestions_count)
 *  - Reads pending_suggestions.json (AI discoveries awaiting approval)
 *  - Reads source_quality.json (signal yield per domain)
 *  - Writes back to GitHub via the GitHub Contents API (same pattern as creator.js)
 *    - data/extra_sources.yaml  → new/removed sources
 *    - data/sources_metadata.json → metadata overlay (personas, topics, region, reliability)
 *    - dashboard/pending_suggestions.json → updated after approve/reject
 */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function escH(s) {
  return String(s ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])
  );
}

function setStatus(id, msg, type = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}

// Use a path relative to the current page — works with type=module and static hosting
const BASE = (() => {
  const p = window.location.pathname;
  return p.substring(0, p.lastIndexOf("/") + 1);
})();
function resolveJSON(p) {
  return BASE + p + "?_=" + Date.now();
}

async function fetchJSON(path) {
  try {
    const r = await fetch(resolveJSON(path), { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function getGHConfig() {
  return {
    pat:    localStorage.getItem("gh_pat")    || "",
    owner:  localStorage.getItem("gh_owner")  || "",
    repo:   localStorage.getItem("gh_repo")   || "",
    branch: localStorage.getItem("gh_branch") || "main",
  };
}

function saveGHConfig(cfg) {
  localStorage.setItem("gh_pat",    cfg.pat);
  localStorage.setItem("gh_owner",  cfg.owner);
  localStorage.setItem("gh_repo",   cfg.repo);
  localStorage.setItem("gh_branch", cfg.branch);
}

function ghHeaders(pat) {
  return {
    "Authorization": `Bearer ${pat}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  };
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function ghGetFile(path) {
  const { pat, owner, repo } = getGHConfig();
  if (!pat || !owner || !repo) throw new Error("GitHub not configured — go to the GitHub Config tab.");
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: ghHeaders(pat) }
  );
  if (resp.status === 404) return { content: "", sha: null };
  if (!resp.ok) throw new Error(`GitHub API ${resp.status} reading ${path}`);
  const data = await resp.json();
  return { content: b64decode(data.content), sha: data.sha };
}

async function ghPutFile(path, content, message, sha) {
  const { pat, owner, repo, branch } = getGHConfig();
  const body = { message, content: b64encode(content), branch };
  if (sha) body.sha = sha;
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { method: "PUT", headers: ghHeaders(pat), body: JSON.stringify(body) }
  );
  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    let msg = `GitHub API error (HTTP ${resp.status})`;
    try {
      const j = JSON.parse(raw);
      if (resp.status === 401) msg = "Authentication failed — check your PAT.";
      else if (resp.status === 403) msg = "Permission denied — PAT needs 'repo' scope.";
      else if (resp.status === 404) msg = "Repository not found — check owner/repo.";
      else msg = j.message || msg;
    } catch { /* raw fallback */ }
    throw new Error(`${msg} (${path})`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// YAML helpers — simple serialiser for the extra_sources.yaml list format
// ---------------------------------------------------------------------------

function serializeSourceEntry(s) {
  let yaml = `- type: ${s.type}\n  url: ${s.url}\n`;
  if (s.label)       yaml += `  label: "${s.label.replace(/"/g, '\\"')}"\n`;
  if (s.personas?.length)  yaml += `  personas: [${s.personas.join(", ")}]\n`;
  if (s.topics?.length)    yaml += `  topics: [${s.topics.join(", ")}]\n`;
  if (s.region)            yaml += `  region: ${s.region}\n`;
  if (s.reliability)       yaml += `  reliability: ${s.reliability}\n`;
  return yaml;
}

/** Append new source entries to existing extra_sources.yaml content. */
function appendToYaml(existingContent, newEntries) {
  const base = (existingContent || "").trimEnd();
  const appended = newEntries.map(serializeSourceEntry).join("");
  return base ? base + "\n" + appended : appended;
}

/** Naive URL extractor from YAML — finds all `url:` lines. */
function extractUrlsFromYaml(yaml) {
  const urls = new Set();
  for (const line of yaml.split("\n")) {
    const m = line.match(/^\s*url:\s*(.+)/);
    if (m) urls.add(m[1].trim().replace(/\/$/, ""));
  }
  return urls;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let SUGGESTIONS    = [];   // items from pending_suggestions.json
let SOURCES        = [];   // items from sources_config.json
let SOURCE_QUALITY = {};   // { domain → { card_count, avg_score } }
let METADATA       = {};   // { url → { label, personas, topics, region, reliability } } (dirty edits)
let META_DIRTY     = {};   // subset of METADATA that has been changed

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

function initTabs() {
  const btns  = $$(".stab");
  const pages = $$(".settings-page");

  function activate(tabId) {
    btns.forEach(b => b.classList.toggle("active", b.dataset.stab === tabId));
    pages.forEach(p => {
      const show = p.id === `stab-${tabId}`;
      p.hidden = !show;
      if (show) p.classList.add("active-stab");
      else      p.classList.remove("active-stab");
    });
  }

  btns.forEach(b => b.addEventListener("click", () => activate(b.dataset.stab)));
}

// ---------------------------------------------------------------------------
// GitHub Config tab
// ---------------------------------------------------------------------------

function initGHTab() {
  const cfg = getGHConfig();
  $("#gh-owner").value  = cfg.owner;
  $("#gh-repo").value   = cfg.repo;
  $("#gh-branch").value = cfg.branch;
  $("#gh-pat").value    = cfg.pat;

  updateGHStatusBar();

  $("#gh-save-btn").addEventListener("click", async () => {
    const cfg2 = {
      owner:  $("#gh-owner").value.trim(),
      repo:   $("#gh-repo").value.trim(),
      branch: $("#gh-branch").value.trim() || "main",
      pat:    $("#gh-pat").value.trim(),
    };
    if (!cfg2.owner || !cfg2.repo || !cfg2.pat) {
      setStatus("#gh-status", "Owner, repo, and PAT are required.", "err");
      return;
    }
    setStatus("#gh-status", "Testing connection…");
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${cfg2.owner}/${cfg2.repo}`,
        { headers: ghHeaders(cfg2.pat) }
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      saveGHConfig(cfg2);
      setStatus("#gh-status", "✓ Connected and saved.", "ok");
      updateGHStatusBar();
    } catch (e) {
      setStatus("#gh-status", `Connection failed: ${e.message}`, "err");
    }
  });

  $("#gh-disconnect-btn")?.addEventListener("click", () => {
    $$(".stab").find(b => b.dataset.stab === "github")?.click();
  });
}

function updateGHStatusBar() {
  const cfg = getGHConfig();
  const bar = $("#github-status-bar");
  if (cfg.owner && cfg.repo && cfg.pat) {
    bar.hidden = false;
    $("#gh-repo-label").textContent = `${cfg.owner}/${cfg.repo}`;
    $("#gh-branch-label").textContent = cfg.branch;
    $("#settings-status").textContent = `${cfg.owner}/${cfg.repo}`;
  } else {
    bar.hidden = true;
    $("#settings-status").textContent = "Not connected";
  }
}

// ---------------------------------------------------------------------------
// Suggestions tab
// ---------------------------------------------------------------------------

async function loadSuggestions() {
  const data = await fetchJSON("pending_suggestions.json");
  const loadingEl = $("#suggestions-loading");
  if (loadingEl) loadingEl.hidden = true;

  if (!data || !data.items?.length) {
    const el = $("#suggestions-empty");
    if (el) el.hidden = false;
    return;
  }

  SUGGESTIONS = data.items;
  renderSuggestions("all");

  const badge = $("#suggestions-badge");
  if (badge) { badge.textContent = SUGGESTIONS.length; badge.hidden = false; }

  const filterBar = $("#suggestions-filter");
  if (filterBar) filterBar.hidden = false;

  const bulkBar = $("#suggestions-bulk-actions");
  if (bulkBar) bulkBar.hidden = false;

  // Filter buttons
  $$(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderSuggestions(btn.dataset.filter);
    });
  });

  $("#reject-all-btn")?.addEventListener("click", async () => {
    if (!confirm("Reject all pending suggestions?")) return;
    await saveUpdatedPending([]);
    SUGGESTIONS = [];
    renderSuggestions("all");
    const b = $("#suggestions-badge");
    if (b) b.hidden = true;
    const bulkEl = $("#suggestions-bulk-actions");
    if (bulkEl) bulkEl.hidden = true;
    const filterEl = $("#suggestions-filter");
    if (filterEl) filterEl.hidden = true;
    const emptyEl = $("#suggestions-empty");
    if (emptyEl) emptyEl.hidden = false;
  });

  $("#approve-all-sources-btn")?.addEventListener("click", async () => {
    const sources = SUGGESTIONS.filter(s => s.category === "source");
    if (!sources.length) { alert("No source suggestions to approve."); return; }
    if (!confirm(`Approve ${sources.length} source suggestion(s) and add to extra_sources.yaml?`)) return;
    try {
      await approveMultipleSources(sources);
      // Remove approved from pending
      const remaining = SUGGESTIONS.filter(s => s.category !== "source");
      await saveUpdatedPending(remaining);
      SUGGESTIONS = remaining;
      renderSuggestions("all");
      updateBadge();
    } catch (e) {
      alert(`Failed: ${e.message}`);
    }
  });
}

function confClass(c) {
  if (c >= 75) return "high";
  if (c >= 50) return "med";
  return "low";
}

function renderSuggestions(filter) {
  const list = $("#suggestions-list");
  if (!list) return;

  const items = filter === "all" ? SUGGESTIONS : SUGGESTIONS.filter(s => s.category === filter);

  if (!items.length) {
    list.innerHTML = `<p class="small muted" style="padding:20px 0;">No ${filter === "all" ? "" : filter} suggestions.</p>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const badgeClass = item.category;
    const label = item.category === "source"
      ? (item.url || "")
      : item.category === "query"
      ? item.query || ""
      : item.name || "";

    const detail = item.label || item.reason || item.reasoning || "";

    return `
    <div class="suggestion-card" data-id="${escH(item.id)}" data-cat="${escH(item.category)}">
      <span class="suggestion-type-badge ${badgeClass}">${escH(item.source_type || item.category)}</span>
      <div class="suggestion-body">
        <div class="suggestion-url">${escH(label)}</div>
        ${detail ? `<div class="suggestion-reason">${escH(detail)}</div>` : ""}
        <div class="suggestion-meta">
          <span class="conf-pill ${confClass(item.confidence)}">${item.confidence}% confidence</span>
          <span class="small muted">${item.suggested_at?.slice(0,10) || ""}</span>
        </div>
        ${item.category === "source" ? `
        <div class="suggestion-meta-fields" id="meta-fields-${escH(item.id)}">
          <div class="form-row">
            <label>Label</label>
            <input class="input sug-label" type="text" value="${escH(item.label || "")}" placeholder="Optional description" maxlength="120" />
          </div>
          <div class="form-row">
            <label>Region</label>
            <select class="input input-sm sug-region">
              <option value="">Global</option>
              <option value="us">US</option>
              <option value="eu">EU</option>
              <option value="apac">APAC</option>
              <option value="uk">UK</option>
            </select>
          </div>
        </div>` : ""}
      </div>
      <div class="suggestion-actions">
        <button class="btn btn-approve btn-sm" data-action="approve" data-id="${escH(item.id)}">Approve</button>
        <button class="btn btn-reject btn-sm"  data-action="reject"  data-id="${escH(item.id)}">Reject</button>
      </div>
    </div>`;
  }).join("");

  // Wire up action buttons
  $$("[data-action]", list).forEach(btn => {
    btn.addEventListener("click", () => handleSuggestionAction(btn.dataset.action, btn.dataset.id));
  });
}

async function handleSuggestionAction(action, id) {
  const item = SUGGESTIONS.find(s => s.id === id);
  if (!item) return;

  if (action === "approve") {
    const card = $(`[data-id="${id}"]`);
    const labelEl  = card?.querySelector(".sug-label");
    const regionEl = card?.querySelector(".sug-region");
    if (labelEl)  item.label  = labelEl.value.trim();
    if (regionEl) item.region = regionEl.value;

    try {
      await approveSuggestion(item);
      SUGGESTIONS = SUGGESTIONS.filter(s => s.id !== id);
      await saveUpdatedPending(SUGGESTIONS);
      renderSuggestions($(".filter-btn.active")?.dataset.filter || "all");
      updateBadge();
    } catch (e) {
      alert(`Approve failed: ${e.message}`);
    }
  } else {
    SUGGESTIONS = SUGGESTIONS.filter(s => s.id !== id);
    await saveUpdatedPending(SUGGESTIONS);
    renderSuggestions($(".filter-btn.active")?.dataset.filter || "all");
    updateBadge();
  }
}

async function approveSuggestion(item) {
  if (item.category === "source") {
    await approveMultipleSources([item]);
  } else if (item.category === "query") {
    await approveQuery(item.query);
  } else if (item.category === "competitor") {
    await approveCompetitor(item);
  }
}

async function approveMultipleSources(items) {
  const { content: existingYaml, sha } = await ghGetFile("data/extra_sources.yaml");
  const existingUrls = extractUrlsFromYaml(existingYaml);
  const newEntries = items
    .filter(item => item.url && !existingUrls.has(item.url.replace(/\/$/, "")))
    .map(item => ({
      type: item.source_type || "page",
      url: item.url,
      label: item.label || "",
      region: item.region || "",
    }));

  if (!newEntries.length) return; // all already exist

  const updatedYaml = appendToYaml(existingYaml, newEntries);
  await ghPutFile(
    "data/extra_sources.yaml",
    updatedYaml,
    `settings: approve ${newEntries.length} source suggestion(s) [settings UI]`,
    sha
  );
}

async function approveQuery(query) {
  // Read config.yaml, append to web_search.queries
  const { content, sha } = await ghGetFile("config.yaml");
  if (!content) throw new Error("Could not read config.yaml");
  // Check if already present
  if (content.includes(`    - '${query}'`) || content.includes(`    - "${query}"`)) return;
  // Find the web_search.queries block and append
  const updated = content.replace(
    /(web_search:\s*\n\s*queries:\s*\n)([\s\S]*?)(\n[^\s])/,
    (match, header, body, next) => {
      return header + body + `    - '${query}'\n` + next;
    }
  );
  if (updated === content) throw new Error("Could not find web_search.queries block in config.yaml");
  await ghPutFile("config.yaml", updated, `settings: add query "${query}" [settings UI]`, sha);
}

async function approveCompetitor(item) {
  const { content: existingYaml, sha } = await ghGetFile("data/competitors.yaml");
  if (!existingYaml) throw new Error("Could not read competitors.yaml");
  const entry = `
  ${item.name}:
    category: ""
    core_competency: ""
    url: ${item.url || ""}
    pricing: "Unknown — needs research"
    primary_value: "${item.reasoning || "Auto-approved from suggestions"}"
    key_customer: ""
    payer: ""
    notes: "Approved via Settings UI"
    positives: []
    negatives: []
    opportunities:
      - "Research needed"
    watch_out_for: []
    opportunity: []
    ahj: ""
    facility_manager: ""
    fire_chief: ""
    fire_inspector: ""
    fire_marshal: ""
`;
  const updated = existingYaml.trimEnd() + "\n" + entry;
  await ghPutFile("data/competitors.yaml", updated,
    `settings: approve competitor "${item.name}" [settings UI]`, sha);
}

async function saveUpdatedPending(items) {
  const { sha } = await ghGetFile("dashboard/pending_suggestions.json");
  const content = JSON.stringify({
    generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    description: "AI-discovered sources/queries/competitors awaiting approval via the Settings UI",
    items,
  }, null, 2);
  await ghPutFile(
    "dashboard/pending_suggestions.json",
    content,
    `settings: update pending suggestions [settings UI]`,
    sha
  );
}

function updateBadge() {
  const badge = $("#suggestions-badge");
  if (!badge) return;
  if (SUGGESTIONS.length > 0) {
    badge.textContent = SUGGESTIONS.length;
    badge.hidden = false;
  } else {
    badge.hidden = true;
    const emptyEl = $("#suggestions-empty");
    if (emptyEl) emptyEl.hidden = false;
    const listEl = $("#suggestions-list");
    if (listEl) listEl.innerHTML = "";
    const bulkEl = $("#suggestions-bulk-actions");
    if (bulkEl) bulkEl.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Source Library tab
// ---------------------------------------------------------------------------

function _ghConfigNotice(tabId) {
  const cfg = getGHConfig();
  if (cfg.pat && cfg.owner && cfg.repo) return "";
  return `<div class="gh-config-notice">
    ⚠ GitHub not configured — saves will fail.
    <a data-goto-github>Set up GitHub Config →</a>
  </div>`;
}

async function loadSources() {
  const [sourcesData, qualityData] = await Promise.all([
    fetchJSON("sources_config.json"),
    fetchJSON("source_quality.json"),
  ]);

  const loadingEl = $("#sources-loading");
  if (loadingEl) loadingEl.hidden = true;

  // Prepend GitHub config notice if not set
  const notice = _ghConfigNotice();
  if (notice) {
    const wrap = $("#stab-sources .section-head");
    if (wrap && !$("#stab-sources .gh-config-notice")) {
      wrap.insertAdjacentHTML("beforebegin", notice);
      $("#stab-sources [data-goto-github]")?.addEventListener("click", () => {
        $(".stab[data-stab='github']")?.click();
      });
    }
  }

  // Build quality index
  if (qualityData?.sources) {
    for (const s of qualityData.sources) {
      SOURCE_QUALITY[s.domain] = s;
    }
  }

  SOURCES = (sourcesData?.sources || []).filter(s => s.type !== "web_search" && s.type !== "serpapi" && s.url);

  // Pre-populate METADATA from sources that already have metadata
  for (const s of SOURCES) {
    if (s.url) {
      METADATA[s.url] = {
        label:       s.label || "",
        personas:    s.personas || [],
        topics:      s.topics || [],
        region:      s.region || "",
        reliability: s.reliability || 0,
      };
    }
  }

  renderSourcesTable();
  initSourceFilters();
  initSaveBar();
}

function domainFrom(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function renderSourcesTable() {
  const tbody = $("#sources-tbody");
  const wrap  = $("#sources-table-wrap");
  const countEl = $("#sources-table-count");
  if (!tbody || !wrap) return;

  const search    = $("#src-search")?.value.toLowerCase() || "";
  const typeF     = $("#src-type-filter")?.value || "";
  const personaF  = $("#src-persona-filter")?.value || "";
  const regionF   = $("#src-region-filter")?.value || "";

  const filtered = SOURCES.filter(s => {
    const meta = METADATA[s.url] || {};
    if (typeF && s.type !== typeF) return false;
    if (personaF && !(meta.personas || []).includes(personaF)) return false;
    if (regionF && (meta.region || "") !== regionF) return false;
    if (search) {
      const blob = `${s.url} ${meta.label || s.label || ""} ${(meta.personas || []).join(" ")} ${(meta.topics || []).join(" ")}`.toLowerCase();
      if (!blob.includes(search)) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = `${filtered.length} sources`;
  wrap.hidden = false;

  tbody.innerHTML = filtered.map(s => {
    const meta  = { ...(METADATA[s.url] || {}), ...(META_DIRTY[s.url] || {}) };
    const dom   = domainFrom(s.url);
    const qual  = SOURCE_QUALITY[dom] || {};
    const yield_ = qual.card_count || 0;
    const stars  = renderStars(meta.reliability || 0);
    const personas = (meta.personas || []).map(p => `<span class="tag persona">${escH(p.replace(/_/g," "))}</span>`).join("");
    const topics   = (meta.topics   || []).map(t => `<span class="tag topic">${escH(t)}</span>`).join("");
    const region   = meta.region ? `<span class="tag region">${escH(meta.region.toUpperCase())}</span>` : "";
    const isDirty  = !!META_DIRTY[s.url];

    return `<tr data-url="${escH(s.url)}" class="${isDirty ? "dirty-row" : ""}">
      <td><span class="type-chip ${s.type}">${escH(s.type)}</span></td>
      <td class="url-cell"><a href="${escH(s.url)}" target="_blank" rel="noopener">${escH(s.url)}</a></td>
      <td>${escH(meta.label || s.label || "")}</td>
      <td class="tags-cell">${personas || '<span class="small muted">—</span>'}</td>
      <td class="tags-cell">${topics   || '<span class="small muted">—</span>'} ${region}</td>
      <td>${region || '<span class="small muted">—</span>'}</td>
      <td class="num"><span class="reliability-stars">${stars}</span></td>
      <td class="num yield-cell ${yield_ > 5 ? "high" : "low"}">${yield_ || "—"}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-action="edit" data-url="${escH(s.url)}" title="Edit metadata">Edit</button>
      </td>
    </tr>`;
  }).join("");

  $$("[data-action='edit']", tbody).forEach(btn => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.url));
  });
}

function renderStars(n) {
  const full = Math.round(n);
  return full ? "★".repeat(full) + "☆".repeat(5 - full) : "☆☆☆☆☆";
}

function initSourceFilters() {
  ["#src-search", "#src-type-filter", "#src-persona-filter", "#src-region-filter"].forEach(id => {
    $(id)?.addEventListener("input", () => renderSourcesTable());
  });
}

function initSaveBar() {
  $("#sources-save-btn")?.addEventListener("click", saveMetadataToGitHub);
  $("#sources-discard-btn")?.addEventListener("click", () => {
    META_DIRTY = {};
    renderSourcesTable();
    updateSaveBar();
  });
}

function updateSaveBar() {
  const bar     = $("#sources-save-bar");
  const countEl = $("#sources-dirty-count");
  const dirty   = Object.keys(META_DIRTY).length;
  if (bar)     bar.hidden     = (dirty === 0);
  if (countEl) countEl.textContent = dirty > 0 ? `${dirty} unsaved change${dirty > 1 ? "s" : ""}` : "";
}

async function saveMetadataToGitHub() {
  const btn = $("#sources-save-btn");
  if (btn) btn.disabled = true;

  // Merge META_DIRTY into METADATA
  for (const [url, meta] of Object.entries(META_DIRTY)) {
    METADATA[url] = { ...METADATA[url], ...meta };
  }

  // Build the sources_metadata.json content
  const payload = { sources: METADATA };
  const content  = JSON.stringify(payload, null, 2);

  try {
    const { sha } = await ghGetFile("data/sources_metadata.json");
    await ghPutFile(
      "data/sources_metadata.json",
      content,
      `settings: update source metadata [settings UI]`,
      sha
    );
    META_DIRTY = {};
    renderSourcesTable();
    updateSaveBar();
    // brief success flash
    const bar = $("#sources-save-bar");
    if (bar) {
      const flash = document.createElement("span");
      flash.className = "status-msg ok";
      flash.textContent = "✓ Saved";
      bar.appendChild(flash);
      setTimeout(() => flash.remove(), 3000);
    }
  } catch (e) {
    alert(`Save failed: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

let MODAL_URL = "";

function openEditModal(url) {
  MODAL_URL = url;
  const meta = { ...(METADATA[url] || {}), ...(META_DIRTY[url] || {}) };

  $("#modal-url").textContent = url;
  $("#modal-label").value     = meta.label || "";
  $("#modal-region").value    = meta.region || "";
  const relVal = String(meta.reliability || 0);
  const relEl  = $("#modal-reliability");
  if (relEl) {
    // set matching option, fallback to 0
    const found = [...relEl.options].find(o => o.value === relVal);
    relEl.value = found ? relVal : "0";
  }

  // Personas checkboxes
  $$("#modal-personas input[type=checkbox]").forEach(cb => {
    cb.checked = (meta.personas || []).includes(cb.value);
  });
  // Topics checkboxes
  $$("#modal-topics input[type=checkbox]").forEach(cb => {
    cb.checked = (meta.topics || []).includes(cb.value);
  });

  $("#edit-modal").hidden = false;
}

function closeModal() {
  $("#edit-modal").hidden = true;
  MODAL_URL = "";
}

function initModal() {
  $("#modal-close-btn")?.addEventListener("click",  closeModal);
  $("#modal-cancel-btn")?.addEventListener("click", closeModal);
  $("#edit-modal")?.addEventListener("click", e => {
    if (e.target === $("#edit-modal")) closeModal();
  });
  $("#modal-save-btn")?.addEventListener("click", () => {
    if (!MODAL_URL) return;
    const personas = $$('#modal-personas input[type=checkbox]:checked').map(c => c.value);
    const topics   = $$('#modal-topics   input[type=checkbox]:checked').map(c => c.value);
    META_DIRTY[MODAL_URL] = {
      label:       $("#modal-label").value.trim(),
      region:      $("#modal-region").value,
      reliability: parseInt($("#modal-reliability").value) || 0,
      personas,
      topics,
    };
    closeModal();
    renderSourcesTable();
    updateSaveBar();
  });
}

// ---------------------------------------------------------------------------
// Add Sources tab
// ---------------------------------------------------------------------------

function initAddTab() {
  // Show GitHub config notice if not set up
  const notice = _ghConfigNotice();
  if (notice) {
    const head = $("#stab-add .section-head");
    if (head && !$("#stab-add .gh-config-notice")) {
      head.insertAdjacentHTML("beforebegin", notice);
      $("#stab-add [data-goto-github]")?.addEventListener("click", () => {
        $(".stab[data-stab='github']")?.click();
      });
    }
  }
  $("#add-single-btn")?.addEventListener("click", addSingleSource);
  $("#bulk-add-btn")?.addEventListener("click",   addBulkSources);
}

async function addSingleSource() {
  const url = $("#add-url")?.value.trim();
  if (!url) { setStatus("#add-single-status", "URL is required.", "err"); return; }
  if (!url.startsWith("https://")) { setStatus("#add-single-status", "URL must start with https://", "err"); return; }

  const entry = {
    type:        $("#add-type")?.value || "page",
    url,
    label:       $("#add-label")?.value.trim() || "",
    personas:    $$('#add-personas input[type=checkbox]:checked').map(c => c.value),
    topics:      $$('#add-topics   input[type=checkbox]:checked').map(c => c.value),
    region:      $("#add-region")?.value || "",
    reliability: parseInt($("#add-reliability")?.value) || 0,
  };

  setStatus("#add-single-status", "Saving…");
  try {
    const { content: existingYaml, sha } = await ghGetFile("data/extra_sources.yaml");
    if (extractUrlsFromYaml(existingYaml).has(url.replace(/\/$/, ""))) {
      setStatus("#add-single-status", "Source already exists.", "err"); return;
    }
    const updated = appendToYaml(existingYaml, [entry]);
    await ghPutFile("data/extra_sources.yaml", updated,
      `settings: add source ${entry.url} [settings UI]`, sha);
    setStatus("#add-single-status", "✓ Added", "ok");
    // Clear form
    $("#add-url").value = "";
    $("#add-label").value = "";
    $$('#add-personas input, #add-topics input').forEach(c => c.checked = false);
  } catch (e) {
    setStatus("#add-single-status", e.message, "err");
  }
}

async function addBulkSources() {
  const raw = $("#bulk-urls")?.value.trim();
  if (!raw) { setStatus("#bulk-status", "Paste at least one URL.", "err"); return; }

  const urls = raw.split(/\n+/).map(u => u.trim()).filter(u => u.startsWith("https://"));
  if (!urls.length) { setStatus("#bulk-status", "No valid https:// URLs found.", "err"); return; }

  const type   = $("#bulk-type")?.value || "page";
  const region = $("#bulk-region")?.value || "";

  setStatus("#bulk-status", `Adding ${urls.length} URL(s)…`);
  try {
    const { content: existingYaml, sha } = await ghGetFile("data/extra_sources.yaml");
    const existing = extractUrlsFromYaml(existingYaml);
    const newEntries = urls
      .filter(u => !existing.has(u.replace(/\/$/, "")))
      .map(u => ({ type, url: u, region }));

    if (!newEntries.length) {
      setStatus("#bulk-status", "All URLs already monitored.", "err"); return;
    }
    const updated = appendToYaml(existingYaml, newEntries);
    await ghPutFile("data/extra_sources.yaml", updated,
      `settings: bulk add ${newEntries.length} source(s) [settings UI]`, sha);
    setStatus("#bulk-status", `✓ Added ${newEntries.length} source(s)`, "ok");
    $("#bulk-urls").value = "";
  } catch (e) {
    setStatus("#bulk-status", e.message, "err");
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  initGHTab();
  initModal();
  initAddTab();

  await Promise.all([
    loadSuggestions(),
    loadSources(),
  ]);
});
