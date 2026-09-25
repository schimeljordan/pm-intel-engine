"use strict";

/* =====================================================================
 * Utilities
 * ===================================================================== */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const text = (x) => (x == null ? "" : String(x));

function escapeHTML(s) {
  return text(s).replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]
  ));
}

const debounce = (fn, ms = 150) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

const toKey = (s) =>
  text(s).toLowerCase().replace(/\s+\/\s+/g, " ").replace(/\s+/g, "_");

/* =====================================================================
 * Fetch helpers
 * ===================================================================== */
const BASE = (() => { const p = window.location.pathname; return p.substring(0, p.lastIndexOf("/") + 1); })();

function resolvePath(p) {
  if (p.startsWith("http") || p.startsWith("/") || p.startsWith("./")) return p;
  return BASE + p;
}

async function fetchJSON(path) {
  try {
    const url = resolvePath(path);
    const r = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) {
      console.warn(`fetchJSON ${url} → ${r.status}`);
      fetchJSON._lastErrors = fetchJSON._lastErrors || {};
      fetchJSON._lastErrors[path] = r.status;
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn(`fetchJSON error ${path}:`, e);
    fetchJSON._lastErrors = fetchJSON._lastErrors || {};
    fetchJSON._lastErrors[path] = e.message;
    return null;
  }
}

/* =====================================================================
 * Supabase intel card loader — server-side filtered, paginated
 * Falls back to cards.json when Supabase has no data.
 * ===================================================================== */
const INTEL_EDGE_URL = "https://wflqkvszshblumbpcxch.supabase.co/functions/v1/intel-analytics";
const SUPABASE_ANON  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndmbHFrdnN6c2hibHVtYnBjeGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgyMTcwMjMsImV4cCI6MjA4Mzc5MzAyM30.0jziSBoP7i_AgsA2-cUJYGaaMQ9eaMJHZW1NCCntDxE";

/**
 * Fetch cards from the intel-analytics Edge Function.
 * @param {Object} filters  — { category, persona, sentiment, urgency_min, score_min, days_back, search, limit, offset }
 * @returns {Promise<{cards: Array, total: number}|null>}
 */
async function fetchCardsFromSupabase(filters = {}) {
  try {
    const params = new URLSearchParams({ action: "cards", limit: 300, offset: 0, ...filters });
    // Remove null/undefined params
    for (const [k, v] of [...params.entries()]) {
      if (v === null || v === undefined || v === "" || v === "null") params.delete(k);
    }
    const r = await fetch(`${INTEL_EDGE_URL}?${params}`, {
      headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
      cache: "no-store",
    });
    if (!r.ok) { console.warn("[supabase-cards] HTTP", r.status); return null; }
    const d = await r.json();
    if (!d?.cards?.length) return null;   // fall through to cards.json
    return d;
  } catch (e) {
    console.warn("[supabase-cards] error:", e);
    return null;
  }
}

/**
 * Fetch summary stats from Supabase (total cards, new this week, top category).
 * Used to update the header KPI strip.
 */
async function fetchSupabaseSummary() {
  try {
    const r = await fetch(`${INTEL_EDGE_URL}?action=summary`, {
      headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/**
 * Fetch weekly velocity from Supabase for trend annotations.
 */
async function fetchSupabaseVelocity() {
  try {
    const r = await fetch(`${INTEL_EDGE_URL}?action=velocity`, {
      headers: { "apikey": SUPABASE_ANON, "Authorization": `Bearer ${SUPABASE_ANON}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.velocity ?? null;
  } catch { return null; }
}

/** Replace a .loading element with an error message when data failed to load. */
function showLoadError(loadingSelector, message) {
  const el = $(loadingSelector);
  if (!el) return;
  el.className = "panel-error";
  el.innerHTML = `<span class="error-icon">⚠️</span><span>${escapeHTML(message || "Data unavailable")}</span>`;
}

async function fetchFirst(paths) {
  for (const p of paths) {
    const data = await fetchJSON(p);
    if (data) return { path: p, data };
  }
  return { path: null, data: null };
}

async function fetchText(path) {
  try {
    const url = resolvePath(path);
    const r = await fetch(`${url}?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  }
}

/* =====================================================================
 * Download helper
 * ===================================================================== */
function download(filename, content, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* =====================================================================
 * Tab navigation
 * ===================================================================== */
function initTabs() {
  const btns  = $$(".nav-btn[data-tab]");
  const pages = $$(".tab-page[id^='tab-']");
  const nav   = $(".topnav");
  const hamburger = $("#nav-hamburger");

  function activate(tabId) {
    btns.forEach((b) => {
      const active = b.dataset.tab === tabId;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active);
    });
    pages.forEach((p) => {
      const show = p.id === `tab-${tabId}`;
      p.hidden = !show;
    });
    history.replaceState(null, "", `#${tabId}`);
    // Lazy-load tabs whose data is heavy / rendered on demand.
    if (tabId === "nfirs") loadNfirs();
    if (tabId === "deptmap") loadDeptMap();
    if (tabId === "neris") loadNeris();
    if (tabId === "aiintel") loadAiIntel();
    if (tabId === "icmd") loadIcmdLazy();
    if (tabId === "marketintel") loadMarketIntelLazy();
    if (tabId === "fieldintel") loadFieldIntelLazy();
    if (tabId === "pmhub") loadPMHubLazy();
    // Close mobile nav on tab select
    if (nav) nav.classList.remove("nav-open");
    if (hamburger) hamburger.setAttribute("aria-expanded", "false");
  }

  btns.forEach((b) => b.addEventListener("click", () => activate(b.dataset.tab)));

  // Hamburger toggle for mobile
  if (hamburger && nav) {
    hamburger.addEventListener("click", () => {
      const open = nav.classList.toggle("nav-open");
      hamburger.setAttribute("aria-expanded", String(open));
    });
  }

  // Honour hash on load
  const hash = location.hash.replace("#", "");
  const validTab = btns.some((b) => b.dataset.tab === hash);
  activate(validTab ? hash : "intel");
}

/* =====================================================================
 * Domain config
 * ===================================================================== */
let DOMAIN = {
  name: "Intel Dashboard",
  short_name: "Intel",
  icon: "📊",
  personas: [],
  categories: [],
};

async function loadDomain() {
  const data = await fetchJSON("domain.json");
  if (data) {
    DOMAIN = { ...DOMAIN, ...data };
  }

  // Update header
  const iconEl = $("#domain-icon");
  const nameEl = $("#domain-name");
  if (iconEl) iconEl.textContent = DOMAIN.icon;
  if (nameEl) nameEl.textContent = DOMAIN.short_name;
  document.title = DOMAIN.name + " Dashboard";

  const domainLabel = $("#voc-domain-label");
  if (domainLabel && DOMAIN.description) {
    domainLabel.textContent = DOMAIN.description;
  }
}

/* =====================================================================
 * Persona dropdowns — populated from domain config + actual data
 * ===================================================================== */
function populatePersonaSelects(personas) {
  $$("select[id$='-persona'], #intel-persona").forEach((sel) => {
    const existing = new Set([...sel.options].map((o) => o.value));
    personas.forEach((p) => {
      const label = typeof p === "string" ? p : (p.label || p.key);
      if (!existing.has(label)) {
        const opt = document.createElement("option");
        opt.value = label;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    });
  });
}

/* =====================================================================
 * VOC Bar Chart (SVG)
 * ===================================================================== */
let VOC_OVERVIEW   = null;
let CURRENT_PERSONA = null;
let NEW_COUNTS     = {};   // { [voc_category]: # cards from last 7 days }
let VOC_HISTORY    = null; // cached voc_history.json array

/** Count cards per category that were added within the last `days` days. */
function computeNewCounts(cards, days = 7) {
  const cutoff = Date.now() - days * 24 * 3600000;
  const result = {};
  for (const c of cards) {
    const cat = c.voc_category;
    if (!cat) continue;
    if (!result[cat]) result[cat] = 0;
    if (c.date && new Date(c.date).getTime() > cutoff) result[cat]++;
  }
  return result;
}

function seriesFromOverview(overview, persona, newCounts = {}) {
  return (overview.divisions || []).map((d) => {
    const subsRaw  = d.top_subcategories || d.top_subdivisions || d.subcategories || d.subdivisions || [];
    const subsArr  = (Array.isArray(subsRaw) ? subsRaw : [])
      .map((s) => (typeof s === "string" ? { label: s } : s))
      .filter(Boolean);
    return {
      division: d.division,
      count: persona ? (d.by_persona?.[persona] || 0) : (d.count ?? 0),
      subs: subsArr,
      topPain: d.top_pain || "",
      newCount: newCounts[d.division] || 0,
    };
  }).filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
}

// Short display labels for narrow screens
const DIVISION_SHORT = {
  "Integration & Interop":      "Integration",
  "Inspections & Compliance":   "Inspections",
  "Software UX":                "Software UX",
  "Operations & Training":      "Operations",
  "Communication":              "Comms",
  "Standards & Codes":          "Standards",
  "Built Environment":          "Built Env",
  "Community Risk Reduction":   "CRR",
  "Procurement & Funding":      "Procurement",
  "Wildland/WUI":               "Wildland",
};

// VOC category → CSS class (maps to --cat-*-bar vars in style.css)
const VOC_CAT_CLASS = {
  "Inspections & Compliance":  "voc-bar-cat-inspection",
  "Integration & Interop":     "voc-bar-cat-compliance",
  "Standards & Codes":         "voc-bar-cat-compliance",
  "Operations & Training":     "voc-bar-cat-ops",
  "Communication":             "voc-bar-cat-ops",
  "Wildland/WUI":              "voc-bar-cat-incident",
  "Built Environment":         "voc-bar-cat-incident",
  "Software UX":               "voc-bar-cat-training",
  "Community Risk Reduction":  "voc-bar-cat-training",
  "Procurement & Funding":     "voc-bar-cat-inspection",
};

function vocCatClass(division) {
  return VOC_CAT_CLASS[division] || "voc-bar-cat-ops";
}

function renderVocChart(container, overview, persona = null, newCounts = {}) {
  if (!container) return;
  container.innerHTML = "";

  const series = seriesFromOverview(overview, persona, newCounts);
  if (!series.length) {
    container.innerHTML = '<div class="empty-state">No VOC data for this persona.</div>';
    return;
  }

  const W = container.clientWidth || container.parentElement?.clientWidth || 960;
  const isNarrow  = W < 520;
  const isVeryNarrow = W < 360;
  // Rotate labels whenever there are many categories, regardless of screen width
  const needsRotation = isNarrow || series.length > 6;

  // On very narrow screens, render horizontal bars instead
  if (isVeryNarrow || (isNarrow && series.length > 3)) {
    _renderVocHorizontal(container, series, W);
    // Legend for horizontal layout
    if (series.some((s) => s.newCount > 0)) {
      const legend = document.createElement("div");
      legend.className = "voc-bar-legend";
      legend.innerHTML = `<span class="voc-legend-item"><span class="voc-legend-swatch voc-legend-existing"></span>Prior</span><span class="voc-legend-item"><span class="voc-legend-swatch voc-legend-new"></span>New this week</span>`;
      container.appendChild(legend);
    }
    return;
  }

  const H = 320;
  const maxV   = Math.max(...series.map((s) => s.count), 1);
  const padTop = maxV > 100 ? 32 : 12;
  // Increase bottom padding when labels are rotated
  const pad    = { top: padTop, right: 12, bottom: needsRotation ? 110 : 100, left: 44 };

  const innerW = Math.max(140, W - pad.left - pad.right);
  const innerH = Math.max(120, H - pad.top - pad.bottom);
  const n      = series.length;
  const gap    = 10;
  const barW   = Math.max(24, Math.floor((innerW - (n - 1) * gap) / n));
  const yPos   = (v) => innerH - Math.round((v / maxV) * innerH);

  const GNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(GNS, "svg");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.classList.add("voc-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "VOC bar chart");

  // Y-axis grid lines
  const gridGroup = document.createElementNS(GNS, "g");
  for (const [lab, yy] of [["0", innerH], [String(maxV), 0]]) {
    const t = document.createElementNS(GNS, "text");
    t.setAttribute("x", 6);
    t.setAttribute("y", pad.top + yy + 4);
    t.setAttribute("class", "voc-y");
    t.textContent = lab;
    gridGroup.appendChild(t);

    const line = document.createElementNS(GNS, "line");
    line.setAttribute("x1", pad.left);
    line.setAttribute("x2", pad.left + innerW);
    line.setAttribute("y1", pad.top + yy);
    line.setAttribute("y2", pad.top + yy);
    line.setAttribute("class", "voc-grid");
    gridGroup.appendChild(line);
  }
  svg.appendChild(gridGroup);

  // Bars + labels
  series.forEach((s, i) => {
    const x = pad.left + i * (barW + gap);
    const h = innerH - yPos(s.count);

    // Bar — stacked if new signals exist this week
    const oldCount = Math.max(0, s.count - s.newCount);
    const tooltipHandler = (e) => _showVocTooltip(e, s.division, s.count, s.topPain, s.newCount);

    if (s.newCount > 0) {
      // Existing segment (bottom, dim blue)
      const oldRect = document.createElementNS(GNS, "rect");
      oldRect.setAttribute("x", x);
      oldRect.setAttribute("y", pad.top + yPos(oldCount));
      oldRect.setAttribute("width", barW);
      oldRect.setAttribute("height", Math.max(2, innerH - yPos(oldCount)));
      oldRect.setAttribute("rx", "4");
      oldRect.setAttribute("class", `voc-bar voc-bar-existing ${vocCatClass(s.division)}`);
      oldRect.setAttribute("role", "graphics-symbol");
      oldRect.setAttribute("aria-label", `${s.division}: ${oldCount} prior signals`);
      oldRect.style.cursor = "pointer";
      oldRect.addEventListener("mousemove", tooltipHandler);
      oldRect.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(oldRect);

      // New segment (top, green)
      const newH = Math.max(2, yPos(oldCount) - yPos(s.count));
      const newRect = document.createElementNS(GNS, "rect");
      newRect.setAttribute("x", x);
      newRect.setAttribute("y", pad.top + yPos(s.count));
      newRect.setAttribute("width", barW);
      newRect.setAttribute("height", newH);
      newRect.setAttribute("rx", "4");
      newRect.setAttribute("class", "voc-bar-new");
      newRect.setAttribute("role", "graphics-symbol");
      newRect.setAttribute("aria-label", `${s.division}: ${s.newCount} new this week`);
      newRect.style.cursor = "pointer";
      newRect.addEventListener("mousemove", tooltipHandler);
      newRect.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(newRect);
    } else {
      // No new signals — single solid bar
      const rect = document.createElementNS(GNS, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", pad.top + yPos(s.count));
      rect.setAttribute("width", barW);
      rect.setAttribute("height", Math.max(2, h));
      rect.setAttribute("rx", "4");
      rect.setAttribute("class", `voc-bar ${vocCatClass(s.division)}`);
      rect.setAttribute("role", "graphics-symbol");
      rect.setAttribute("aria-label", `${s.division}: ${s.count}`);
      rect.style.cursor = "pointer";
      rect.addEventListener("mousemove", tooltipHandler);
      rect.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(rect);
    }

    // Value label
    const valY = Math.max(pad.top + 14, pad.top + yPos(s.count) - 5);
    const shadow = document.createElementNS(GNS, "text");
    shadow.setAttribute("x", x + barW / 2);
    shadow.setAttribute("y", valY);
    shadow.setAttribute("class", "voc-val");
    shadow.setAttribute("text-anchor", "middle");
    shadow.setAttribute("style", "paint-order:stroke;stroke:#0e1217;stroke-width:3;opacity:.7;");
    shadow.textContent = s.count;
    svg.appendChild(shadow);

    const val = document.createElementNS(GNS, "text");
    val.setAttribute("x", x + barW / 2);
    val.setAttribute("y", valY);
    val.setAttribute("class", "voc-val");
    val.setAttribute("text-anchor", "middle");
    val.textContent = s.count;
    svg.appendChild(val);

    // Division label — abbreviated + rotated when many bars or narrow screen
    const labelText = needsRotation
      ? (DIVISION_SHORT[s.division] || s.division.split(/[\s&]/)[0])
      : s.division;
    const lab = document.createElementNS(GNS, "text");
    const labelY = pad.top + innerH + 16;
    const labelX = x + barW / 2;
    if (needsRotation) {
      // Rotate -45° around the label anchor to prevent overlap
      lab.setAttribute("x", labelX);
      lab.setAttribute("y", labelY);
      lab.setAttribute("transform", `rotate(-40, ${labelX}, ${labelY})`);
      lab.setAttribute("text-anchor", "end");
    } else {
      lab.setAttribute("x", labelX);
      lab.setAttribute("y", labelY);
      lab.setAttribute("text-anchor", "middle");
    }
    lab.setAttribute("class", "voc-x");
    lab.textContent = labelText;
    svg.appendChild(lab);

    // Sub-category labels — skip when rotated to avoid overlap
    if (!needsRotation) {
      const subs = (s.subs || []).map((o) => o.label).filter(Boolean).slice(0, 3);
      if (subs.length) {
        [subs.slice(0, 2).join(" · "), subs[2]].filter(Boolean).forEach((line, li) => {
          const t = document.createElementNS(GNS, "text");
          t.setAttribute("x", x + barW / 2);
          t.setAttribute("y", pad.top + innerH + 40 + li * 18);
          t.setAttribute("class", "voc-sub");
          t.setAttribute("text-anchor", "middle");
          t.textContent = line;
          svg.appendChild(t);
        });
      }
    }
  });

  container.appendChild(svg);

  // Add legend when new signals are present
  if (series.some((s) => s.newCount > 0)) {
    const legend = document.createElement("div");
    legend.className = "voc-bar-legend";
    legend.innerHTML =
      `<span class="voc-legend-item"><span class="voc-legend-swatch voc-legend-existing"></span>Prior signals</span>` +
      `<span class="voc-legend-item"><span class="voc-legend-swatch voc-legend-new"></span>New this week</span>`;
    container.appendChild(legend);
  }
}

/** Horizontal bar layout for very narrow screens. */
function _renderVocHorizontal(container, series, W) {
  const rowH = 36;
  const padLeft = 110;
  const padRight = 40;
  const H = series.length * rowH + 16;
  const innerW = Math.max(80, W - padLeft - padRight);
  const maxV = Math.max(...series.map((s) => s.count), 1);

  const GNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(GNS, "svg");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.classList.add("voc-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "VOC bar chart");

  series.forEach((s, i) => {
    const y = i * rowH + 8;
    const hTip = (e) => _showVocTooltip(e, s.division, s.count, s.topPain, s.newCount);

    const label = document.createElementNS(GNS, "text");
    label.setAttribute("x", padLeft - 6);
    label.setAttribute("y", y + rowH / 2 + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "voc-x");
    label.textContent = (DIVISION_SHORT[s.division] || s.division).slice(0, 14);
    svg.appendChild(label);

    const bWOld = Math.max(0, Math.round(((s.count - s.newCount) / maxV) * innerW));
    const bWNew = Math.max(0, Math.round((s.newCount / maxV) * innerW));
    const bW    = bWOld + bWNew || 2;

    if (bWOld > 0) {
      const oldRect = document.createElementNS(GNS, "rect");
      oldRect.setAttribute("x", padLeft);
      oldRect.setAttribute("y", y + 4);
      oldRect.setAttribute("width", bWOld);
      oldRect.setAttribute("height", rowH - 10);
      oldRect.setAttribute("rx", "3");
      oldRect.setAttribute("class", `voc-bar voc-bar-existing ${vocCatClass(s.division)}`);
      oldRect.style.cursor = "pointer";
      oldRect.addEventListener("mousemove", hTip);
      oldRect.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(oldRect);
    }
    if (bWNew > 0) {
      const newRect = document.createElementNS(GNS, "rect");
      newRect.setAttribute("x", padLeft + bWOld);
      newRect.setAttribute("y", y + 4);
      newRect.setAttribute("width", bWNew);
      newRect.setAttribute("height", rowH - 10);
      newRect.setAttribute("rx", "3");
      newRect.setAttribute("class", "voc-bar-new");
      newRect.style.cursor = "pointer";
      newRect.addEventListener("mousemove", hTip);
      newRect.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(newRect);
    }
    if (bWOld === 0 && bWNew === 0) {
      const stub = document.createElementNS(GNS, "rect");
      stub.setAttribute("x", padLeft);
      stub.setAttribute("y", y + 4);
      stub.setAttribute("width", 2);
      stub.setAttribute("height", rowH - 10);
      stub.setAttribute("class", `voc-bar ${vocCatClass(s.division)}`);
      stub.style.cursor = "pointer";
      stub.addEventListener("mousemove", hTip);
      stub.addEventListener("mouseleave", _hideVocTooltip);
      svg.appendChild(stub);
    }

    const val = document.createElementNS(GNS, "text");
    val.setAttribute("x", padLeft + bW + 5);
    val.setAttribute("y", y + rowH / 2 + 4);
    val.setAttribute("class", "voc-val");
    val.textContent = s.count;
    svg.appendChild(val);
  });

  container.appendChild(svg);
}

/* =====================================================================
 * VOC Chart — Hover Tooltip
 * ===================================================================== */
let _vocTooltip = null;

function _showVocTooltip(e, division, count, topPain, newCount = 0) {
  if (!_vocTooltip) {
    _vocTooltip = document.createElement("div");
    _vocTooltip.className = "voc-tooltip";
    document.body.appendChild(_vocTooltip);
  }
  const countLine = newCount > 0
    ? `${count} signals — <span style="color:var(--accent-2);font-weight:700;">${newCount} new this week</span>`
    : `${count} signals`;
  _vocTooltip.innerHTML =
    `<strong>${escapeHTML(division)}</strong><span class="voc-tooltip-count">${countLine}</span>` +
    (topPain ? `<p>${escapeHTML(topPain)}</p>` : "");
  _vocTooltip.hidden = false;
  _positionVocTooltip(e);
}

function _positionVocTooltip(e) {
  if (!_vocTooltip) return;
  const x = e.clientX + 14;
  const y = e.clientY - 8;
  const tw = 300;
  _vocTooltip.style.left = (x + tw > window.innerWidth ? e.clientX - tw - 14 : x) + "px";
  _vocTooltip.style.top  = y + "px";
}

function _hideVocTooltip() {
  if (_vocTooltip) _vocTooltip.hidden = true;
}

/* =====================================================================
 * VOC Chart — Pain Annotation Panel (below chart)
 * ===================================================================== */
function renderVocPainAnnotations(container, overview, persona) {
  if (!container) return;
  const series = seriesFromOverview(overview, persona).filter((s) => s.topPain);
  if (!series.length) { container.hidden = true; return; }
  container.innerHTML = series.slice(0, 6).map((s) =>
    `<div class="pain-row">
       <span class="chip pain-cat-chip">${escapeHTML(s.division)}</span>
       <span class="pain-text">${escapeHTML(s.topPain)}</span>
     </div>`
  ).join("");
  container.hidden = false;
}

/* =====================================================================
 * VOC Chart — New vs Solidified Summary Panel
 * ===================================================================== */
function renderVocNewSummary(container, series, history) {
  if (!container) return;

  // Determine solidified categories: appeared in >= 4 of last 8 daily snapshots
  const solidifiedCats = new Set();
  if (history?.length) {
    const snap8 = history.slice(-8);
    for (const s of series) {
      if (snap8.filter((h) => (h.by_category?.[s.division] || 0) > 0).length >= 4)
        solidifiedCats.add(s.division);
    }
  }

  const newItems   = series.filter((s) => s.newCount > 0).sort((a, b) => b.newCount - a.newCount);
  const staleItems = series.filter((s) => s.newCount === 0 && s.count > 0);
  const totalNew   = newItems.reduce((sum, s) => sum + s.newCount, 0);

  if (!newItems.length && !staleItems.length) { container.hidden = true; return; }

  const catWord = newItems.length === 1 ? "category" : "categories";
  const sigWord = totalNew === 1 ? "signal" : "signals";

  container.innerHTML = `
    <div class="vnews-header">
      <strong>New this week</strong>
      <span class="pill pill-accent">${totalNew} ${sigWord} · ${newItems.length} ${catWord}</span>
    </div>
    ${newItems.length ? `<div class="vnews-rows">
      ${newItems.map((s) => {
        const pct = Math.round((s.newCount / s.count) * 100);
        const isEmerging = pct >= 30 && s.newCount >= 2;
        const isSolid    = solidifiedCats.has(s.division);
        const tag = isEmerging
          ? `<span class="vnews-tag vnews-emerging">↑ emerging</span>`
          : isSolid
            ? `<span class="vnews-tag vnews-solid">✓ solidified</span>`
            : `<span class="vnews-tag">ongoing</span>`;
        return `<div class="vnews-row">
          <span class="vnews-div">${escapeHTML(s.division)}</span>
          <span class="vnews-new">+${s.newCount} new</span>
          <span class="vnews-pct">${pct}% of total</span>
          ${tag}
        </div>`;
      }).join("")}
    </div>` : ""}
    ${staleItems.length ? `
    <div class="vnews-stale">
      <span class="small muted">No new signals this week: </span>
      ${staleItems.map((s) => `<span class="chip">${escapeHTML(s.division)}</span>`).join(" ")}
    </div>` : ""}
  `;
  container.hidden = false;
}

function buildVocCsv(overview, persona = null) {
  const header = ["Division", "Count", "Top Sub 1", "Top Sub 2", "Top Sub 3"];
  const lines  = [header.join(",")];
  (overview.divisions || []).forEach((d) => {
    const count   = persona ? (d.by_persona?.[persona] || 0) : (d.count ?? 0);
    const subsRaw = d.top_subdivisions || d.top_subcategories || d.subdivisions || d.subcategories || [];
    const subs    = (Array.isArray(subsRaw) ? subsRaw : [])
      .map((s) => (typeof s === "string" ? s : s.label || ""))
      .filter(Boolean)
      .slice(0, 3);
    while (subs.length < 3) subs.push("");
    lines.push([d.division, count, ...subs].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  });
  return lines.join("\n");
}

/* =====================================================================
 * VOC Detail Cards
 * ===================================================================== */
const CARDS_PER_PAGE = 30;
let ALL_CARDS        = [];
let FILTERED_CARDS   = [];
let CARDS_PAGE       = 0;

function filterCards(cards, search, persona) {
  let out = cards.slice();
  if (persona) {
    const personaKey = toKey(persona);
    out = out.filter((c) => (c.personas || []).some((p) => {
      if (p === persona) return true;
      const pKey = toKey(p);
      // Full match, or partial: "fire_marshal" matches "Fire Marshal / Prevention"
      return pKey === personaKey || personaKey.startsWith(pKey) || pKey.startsWith(personaKey);
    }));
  }
  if (search) {
    const q = search.toLowerCase();
    out = out.filter((c) =>
      [c.title, c.voc_category, c.voc_subcategory, c.one_liner, c.summary, c.domain,
       c.jtbd, c.sentiment, c.behavioral_stage, c.why, c.root_cause, c.workaround, c.value_chain_role]
        .some((v) => text(v).toLowerCase().includes(q))
    );
  }
  return out;
}

function renderVocCards(container, cards, page) {
  if (!container) return;
  const start  = page * CARDS_PER_PAGE;
  const slice  = cards.slice(start, start + CARDS_PER_PAGE);

  if (!cards.length) {
    container.innerHTML = '<div class="empty-state">No signals match the current filters.</div>';
    return;
  }

  container.innerHTML = slice.map((c) => {
    const score    = c.opportunity_score || 0;
    const personas = (c.personas || []).map((p) => `<span class="chip">${escapeHTML(p)}</span>`).join("");
    const dateStr  = c.date ? new Date(c.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
    const cat      = escapeHTML(c.voc_category || "");
    const subcat   = c.voc_subcategory ? ` · ${escapeHTML(c.voc_subcategory)}` : "";
    const lever    = c.ai_lever && c.ai_lever !== "Other / None" ? `<span class="chip">${escapeHTML(c.ai_lever)}</span>` : "";
    const oneliner  = escapeHTML(c.one_liner || c.summary || "");
    // Prefer root_cause (new field); fall back to legacy why; hide heuristic placeholders
    const rawRootCause = c.root_cause || c.why || "";
    const why = (!rawRootCause.startsWith("Heuristic") && !rawRootCause.startsWith("Insufficient"))
      ? escapeHTML(rawRootCause) : "";
    const jtbd      = escapeHTML(c.jtbd || "");
    const domain    = escapeHTML(c.domain || "");
    const pct       = Math.round(score);
    const urgency   = c.urgency || 3;
    const sentiment = c.sentiment || "";
    const sentimentChip = (sentiment && sentiment !== "neutral")
      ? `<span class="chip chip-${sentiment === "frustrated" ? "danger" : "ok"} small">${escapeHTML(sentiment)}</span>`
      : "";

    return `
      <div class="voc-card-item" data-urgency="${urgency}">
        <a class="voc-card-title" href="${escapeHTML(c.url)}" target="_blank" rel="noopener">${escapeHTML(c.title)}</a>
        <div class="voc-card-meta">
          <span class="chip">${cat}${subcat}</span>
          ${personas}
          ${lever}
          ${sentimentChip}
          <span class="voc-card-score">
            ${pct}
            <span class="score-bar" title="Opportunity score ${pct}/100">
              <span class="score-bar-fill" style="width:${pct}%"></span>
            </span>
          </span>
          ${domain ? `<span class="muted small">${domain}</span>` : ""}
          ${dateStr ? `<span class="muted small">${dateStr}</span>` : ""}
        </div>
        ${oneliner ? `<div class="voc-card-summary">${oneliner}</div>` : ""}
        ${why ? `<div class="voc-card-why"><span class="voc-why-label">Root cause:</span> ${why}</div>` : ""}
        ${c.workaround ? `<div class="voc-card-why voc-card-workaround"><span class="voc-why-label">Workaround:</span> ${escapeHTML(c.workaround)}</div>` : ""}
        ${c.jtbd && !why ? `<div class="voc-card-why"><span class="voc-why-label">JTBD:</span> ${escapeHTML(c.jtbd)}</div>` : ""}
        ${(c.value_chain_role || c.value_chain_origin)
          ? `<div class="voc-card-vc"><span class="voc-why-label">Value chain:</span> ${
              (c.value_chain_origin && c.value_chain_origin !== c.value_chain_role)
                ? escapeHTML(c.value_chain_origin) + " → " + escapeHTML(c.value_chain_role || "")
                : escapeHTML(c.value_chain_role || "")
            }</div>` : ""}
        ${jtbd ? `<div class="voc-card-jtbd"><span class="voc-why-label">JTBD:</span> ${jtbd}</div>` : ""}
      </div>
    `;
  }).join("");
}

function updateCardsPagination(total, page) {
  const paginEl   = $("#voc-cards-pagination");
  const prevBtn   = $("#cards-prev");
  const nextBtn   = $("#cards-next");
  const pageLabel = $("#cards-page-label");
  const totalPages = Math.ceil(total / CARDS_PER_PAGE);

  if (!paginEl) return;
  paginEl.hidden = totalPages <= 1;

  if (pageLabel) pageLabel.textContent = `Page ${page + 1} of ${totalPages}`;
  if (prevBtn)   prevBtn.disabled = page === 0;
  if (nextBtn)   nextBtn.disabled = page >= totalPages - 1;
}

/* =====================================================================
 * Actionable Insights Summary Table
 * Aggregates pain points, JTBD, behavioral stage, and sentiment
 * per VOC category from cards.json
 * ===================================================================== */
function renderInsightsTable(cards) {
  const wrap = $("#insights-wrap");
  const tbody = $("#insights-table-body");
  if (!wrap || !tbody) return;

  // Filter cards that have at least JTBD or urgency data
  const enriched = cards.filter((c) => c.jtbd || c.urgency || c.sentiment || c.behavioral_stage);
  if (!enriched.length) {
    wrap.hidden = true;
    return;
  }

  // Group by category
  const byCategory = {};
  for (const c of enriched) {
    const cat = c.voc_category || "Uncategorized";
    if (!byCategory[cat]) {
      byCategory[cat] = { count: 0, urgencySum: 0, stages: {}, sentiments: {}, jtbds: [] };
    }
    const g = byCategory[cat];
    g.count++;
    g.urgencySum += Number(c.urgency) || 3;

    const stage = c.behavioral_stage || "Awareness";
    g.stages[stage] = (g.stages[stage] || 0) + 1;

    const sent = c.sentiment || "neutral";
    g.sentiments[sent] = (g.sentiments[sent] || 0) + 1;

    // Collect JTBD/why from frustrated/high-urgency cards first for relevance
    const rawPain = c.root_cause || c.jtbd || c.why || "";
    const painText = (!rawPain.startsWith("Heuristic") && !rawPain.startsWith("Insufficient"))
      ? rawPain.trim() : (c.jtbd || "").trim();
    if (painText) {
      const weight = (sent === "frustrated" ? 2 : 1) + (Number(c.urgency) || 3);
      g.jtbds.push({ text: painText, weight });
    }
  }

  // Sort categories by total signal count descending
  const sorted = Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count);

  tbody.innerHTML = sorted.map(([cat, g]) => {
    const avgUrgency = (g.urgencySum / g.count).toFixed(1);
    const urgencyColor = avgUrgency >= 4 ? "var(--danger, #e55)" : avgUrgency >= 3 ? "var(--warning, #e90)" : "var(--muted)";

    // Dominant behavioral stage
    const domStage = Object.entries(g.stages).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    const stageClass = { Frustration: "chip chip-danger", Evaluation: "chip chip-warn", Awareness: "chip chip-muted", Advocacy: "chip chip-ok" }[domStage] || "chip";

    // Sentiment breakdown
    const frustrated = g.sentiments["frustrated"] || 0;
    const neutral    = g.sentiments["neutral"]    || 0;
    const positive   = g.sentiments["positive"]   || 0;
    const sentHtml = [
      frustrated ? `<span class="chip chip-danger">${frustrated} frustrated</span>` : "",
      neutral    ? `<span class="chip chip-muted">${neutral} neutral</span>`        : "",
      positive   ? `<span class="chip chip-ok">${positive} positive</span>`         : "",
    ].filter(Boolean).join(" ");

    // Top JTBD — pick the highest-weight unique statement
    const topJtbd = g.jtbds
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map((j) => `<div class="insight-jtbd">${escapeHTML(j.text)}</div>`)
      .join("") || '<span class="muted">—</span>';

    return `
      <tr>
        <td><strong>${escapeHTML(cat)}</strong></td>
        <td class="num">${g.count}</td>
        <td class="num" style="color:${urgencyColor};font-weight:600;">${avgUrgency}</td>
        <td><span class="${stageClass}">${escapeHTML(domStage)}</span></td>
        <td>${sentHtml}</td>
        <td>${topJtbd}</td>
      </tr>`;
  }).join("");

  wrap.hidden = false;
}

function refreshCards() {
  const search  = ($("#intel-search")?.value || "").trim();
  const persona = $("#intel-persona")?.value || "";

  FILTERED_CARDS = filterCards(ALL_CARDS, search, persona);
  CARDS_PAGE     = 0;

  const count = $("#cards-count");
  if (count) count.textContent = FILTERED_CARDS.length;

  renderVocCards($("#voc-cards"), FILTERED_CARDS, CARDS_PAGE);
  updateCardsPagination(FILTERED_CARDS.length, CARDS_PAGE);
}

/* =====================================================================
 * Command Center Strip
 * ===================================================================== */
function renderCommandStrip(cards, overview) {
  const strip = $("#command-strip");
  if (!strip) return;

  // New signals since last visit
  const lastVisit = localStorage.getItem("last_visit_ts");
  const lastVisitDate = lastVisit ? new Date(lastVisit) : null;
  const newCount = lastVisitDate
    ? cards.filter((c) => c.date && new Date(c.date) > lastVisitDate).length
    : cards.length;
  const newEl = $("#cmd-new-count");
  if (newEl) newEl.textContent = newCount;

  // Top pain category (first division by count)
  const topDiv = (overview?.divisions || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0))[0];
  const catEl  = $("#cmd-pain-cat");
  const cntEl  = $("#cmd-pain-count");
  if (catEl && topDiv) catEl.textContent = topDiv.division;
  if (cntEl && topDiv) cntEl.textContent = `${topDiv.count || 0} signals`;

  // Frustration signals
  const frustCount = cards.filter((c) => c.behavioral_stage === "Frustration").length;
  const frustEl = $("#cmd-frust-count");
  if (frustEl) frustEl.textContent = frustCount;

  // Highest urgency category
  const urgByCategory = {};
  for (const c of cards) {
    const cat = c.voc_category || "Other";
    if (!urgByCategory[cat]) urgByCategory[cat] = { sum: 0, count: 0 };
    urgByCategory[cat].sum   += Number(c.urgency) || 3;
    urgByCategory[cat].count += 1;
  }
  const [topUrgCat, topUrgData] = Object.entries(urgByCategory)
    .sort((a, b) => (b[1].sum / b[1].count) - (a[1].sum / a[1].count))[0] || [];
  const urgCatEl   = $("#cmd-urg-cat");
  const urgScoreEl = $("#cmd-urg-score");
  if (urgCatEl && topUrgCat) urgCatEl.textContent = topUrgCat;
  if (urgScoreEl && topUrgData) {
    urgScoreEl.textContent = `avg ${(topUrgData.sum / topUrgData.count).toFixed(1)} urgency`;
  }

  strip.hidden = false;

  // Store current visit timestamp
  localStorage.setItem("last_visit_ts", new Date().toISOString());
}

/* =====================================================================
 * Strategic summary + persona insights renderers
 * ===================================================================== */
function renderStrategicSummary(data) {
  const el = $("#strategic-summary");
  if (!el) return;
  if (!data?.available) {
    el.innerHTML = `<div class="ai-offline-banner">
      <span class="ai-offline-icon">&#x26A0;</span>
      <span><strong>AI enrichment offline</strong> — root-cause analysis, JTBD, and workaround mapping are unavailable.
      Set <code>OPENAI_API_KEY</code> in GitHub Actions secrets to enable root-cause analysis, JTBD, and strategic summaries.</span>
    </div>`;
    el.hidden = false;
    return;
  }
  const insights = (data.top_insights || []).map(i => `<li>${escapeHTML(i)}</li>`).join("");
  const focus = (data.recommended_focus || []).map(f => `<span class="chip chip-accent">${escapeHTML(f)}</span>`).join(" ");
  el.innerHTML = `
    <div class="strat-header">
      <strong>Strategic Summary</strong>
      <span class="pill pill-accent">${data.signal_count || ""} signals analyzed</span>
      <span class="small muted">AI &middot; ${data.confidence || 0}% confidence</span>
    </div>
    <p class="strat-exec">${escapeHTML(data.executive_summary || "")}</p>
    ${insights ? `<ul class="strat-insights">${insights}</ul>` : ""}
    ${focus ? `<div class="strat-focus"><span class="small muted">Focus areas: </span>${focus}</div>` : ""}
    ${data.watch_signals ? `<div class="strat-watch"><span class="small muted">Watch: </span>${escapeHTML(data.watch_signals)}</div>` : ""}
  `;
  el.hidden = false;
}

function renderPersonaInsights(data) {
  const el = $("#persona-insights-body");
  if (!el || !data) return;
  const personas = [
    { key: "ops",   label: "Operations / Fire Chief" },
    { key: "owner", label: "Building Owner / FM" },
    { key: "ahj",   label: "AHJ / Inspector" },
  ];
  const cols = personas.map(({ key, label }) => {
    const bullets = (data[key] || []).map(b => `<li>${escapeHTML(b)}</li>`).join("");
    return bullets
      ? `<div class="pi-col"><div class="pi-label">${escapeHTML(label)}</div><ul class="pi-bullets">${bullets}</ul></div>`
      : "";
  }).filter(Boolean).join("");
  const panel = $("#persona-insights");
  if (!cols) { if (panel) panel.hidden = true; return; }
  el.innerHTML = `<div class="pi-grid">${cols}</div>`;
  if (panel) panel.hidden = false;
}

/* =====================================================================
 * Intel tab loader
 * ===================================================================== */
async function loadIntel() {
  // --- VOC Overview ---
  const vocData = await fetchJSON("voc_overview.json");
  if (vocData?.divisions?.length) {
    VOC_OVERVIEW = vocData;

    const upd = $("#updated-at");
    if (upd && vocData.generated_at) {
      try { upd.textContent = `Updated ${new Date(vocData.generated_at).toLocaleString()}`; } catch (_) {}
    }

    // Populate persona selects from actual data
    const personaSet = new Set();
    vocData.divisions.forEach((d) => Object.keys(d.by_persona || {}).forEach((p) => personaSet.add(p)));
    // Also from domain config
    (DOMAIN.personas || []).forEach((p) => personaSet.add(typeof p === "string" ? p : p.label));
    populatePersonaSelects([...personaSet].sort());

    CURRENT_PERSONA = $("#intel-persona")?.value || null;
    renderVocChart($("#voc-chart"), VOC_OVERVIEW, CURRENT_PERSONA || null);
    renderVocPainAnnotations($("#voc-pain-annotations"), VOC_OVERVIEW, CURRENT_PERSONA || null);

    const total =
      vocData.totals?.cards ??
      vocData.totals?.accepted ??
      (vocData.divisions || []).reduce((a, d) => a + (d.count || 0), 0);
    const pill = $("#voc-total");
    if (pill) pill.textContent = String(total);

    // Persona filter
    $("#intel-persona")?.addEventListener("change", () => {
      CURRENT_PERSONA = $("#intel-persona").value || null;
      renderVocChart($("#voc-chart"), VOC_OVERVIEW, CURRENT_PERSONA, NEW_COUNTS);
      renderVocPainAnnotations($("#voc-pain-annotations"), VOC_OVERVIEW, CURRENT_PERSONA || null);
      const series = seriesFromOverview(VOC_OVERVIEW, CURRENT_PERSONA || null, NEW_COUNTS);
      renderVocNewSummary($("#voc-new-summary"), series, VOC_HISTORY);
      refreshCards();
    });

    // Resize
    window.addEventListener("resize", debounce(() => {
      renderVocChart($("#voc-chart"), VOC_OVERVIEW, CURRENT_PERSONA || null, NEW_COUNTS);
      renderVocPainAnnotations($("#voc-pain-annotations"), VOC_OVERVIEW, CURRENT_PERSONA || null);
    }, 120));

    // CSV download — prefer pre-generated detail CSV
    $("#voc-download")?.addEventListener("click", async () => {
      const txt = await fetchText("voc_detail.csv");
      if (txt) {
        download("voc_detail.csv", txt);
      } else {
        const csv = buildVocCsv(VOC_OVERVIEW, CURRENT_PERSONA || null);
        download(`voc_overview_${toKey(CURRENT_PERSONA || "all")}.csv`, csv);
      }
    });
  } else {
    const chart = $("#voc-chart");
    if (chart) chart.innerHTML = `
      <div class="empty-state">
        No VOC data yet. <a href="./creator.html" style="color:var(--accent);">Set up your domain</a>
        and trigger the pipeline in GitHub Actions to populate this chart.
      </div>`;
  }

  // --- VOC Cards (Supabase-first, falls back to cards.json) ---
  let sbData = await fetchCardsFromSupabase();
  let cardsSource = "supabase";
  if (!sbData?.cards?.length) {
    // Supabase empty or unreachable — fall back to static file
    const raw = await fetchJSON("cards.json");
    if (raw?.cards?.length) {
      sbData = { cards: raw.cards, total: raw.cards.length };
      cardsSource = "static";
    }
  }
  console.info(`[intel] cards source: ${cardsSource}, count: ${sbData?.cards?.length ?? 0}`);

  const cardsData = sbData;
  if (cardsData?.cards?.length) {
    // Supabase returns pre-sorted by score; static fallback: sort+cap to 300
    ALL_CARDS = cardsSource === "supabase"
      ? (cardsData.cards || [])
      : (cardsData.cards || []).slice().sort(
          (a, b) => (Number(b.opportunity_score) || 0) - (Number(a.opportunity_score) || 0)
        ).slice(0, 300);
    refreshCards();
    renderInsightsTable(ALL_CARDS);
    if (VOC_OVERVIEW) renderCommandStrip(ALL_CARDS, VOC_OVERVIEW);

    // Compute new-this-week counts and re-render chart with stacked coloring
    NEW_COUNTS = computeNewCounts(ALL_CARDS);
    if (VOC_OVERVIEW) {
      renderVocChart($("#voc-chart"), VOC_OVERVIEW, CURRENT_PERSONA || null, NEW_COUNTS);
    }

    // Load history and render new-vs-solidified summary
    VOC_HISTORY = await fetchJSON("voc_history.json");
    if (VOC_OVERVIEW) {
      const series = seriesFromOverview(VOC_OVERVIEW, CURRENT_PERSONA || null, NEW_COUNTS);
      renderVocNewSummary($("#voc-new-summary"), series, VOC_HISTORY);
    }

    // Update total pill from Supabase if available (shows true cumulative count)
    if (cardsSource === "supabase" && cardsData.total) {
      const pill = $("#voc-total");
      if (pill) pill.textContent = String(cardsData.total);
    }

    // Lazy-load optional charts after cards are ready — avoids blocking boot.
    setTimeout(loadOptionalCharts, 500);
  } else {
    const el = $("#voc-cards");
    if (el) el.innerHTML = `
      <div class="empty-state">
        No signals yet. After your first pipeline run, scored intelligence cards will appear here.<br>
        <a href="./creator.html" style="color:var(--accent);">Configure sources →</a>
      </div>`;
  }

  // Strategic summary and persona insights
  const [strategicData, personaData] = await Promise.all([
    fetchJSON("strategic_summary.json"),
    fetchJSON("persona_summaries.json"),
  ]);
  renderStrategicSummary(strategicData);
  renderPersonaInsights(personaData);

  // Search on cards
  $("#intel-search")?.addEventListener("input", debounce(refreshCards, 200));

  // Pagination
  $("#cards-prev")?.addEventListener("click", () => {
    if (CARDS_PAGE > 0) {
      CARDS_PAGE--;
      renderVocCards($("#voc-cards"), FILTERED_CARDS, CARDS_PAGE);
      updateCardsPagination(FILTERED_CARDS.length, CARDS_PAGE);
    }
  });
  $("#cards-next")?.addEventListener("click", () => {
    const totalPages = Math.ceil(FILTERED_CARDS.length / CARDS_PER_PAGE);
    if (CARDS_PAGE < totalPages - 1) {
      CARDS_PAGE++;
      renderVocCards($("#voc-cards"), FILTERED_CARDS, CARDS_PAGE);
      updateCardsPagination(FILTERED_CARDS.length, CARDS_PAGE);
    }
  });
}

/* =====================================================================
 * Competitive tab
 * ===================================================================== */
function listHTML(arr) {
  return arr?.length ? `<ul>${arr.map((x) => `<li>${escapeHTML(x)}</li>`).join("")}</ul>` : "";
}

function normalizeBattlecard(raw) {
  // vendors array
  if (raw?.vendors?.length) {
    return raw.vendors.map((v) => _normalizeVendor(v));
  }
  // competitors array
  if (raw?.competitors?.length) {
    return raw.competitors.map((v) => _normalizeVendor(v));
  }
  // legacy cards
  if (raw?.cards?.length) {
    return raw.cards.map((c) => {
      const row = {
        vendor: text(c.vendor || c.title), site: text(c.site || c.url || ""),
        pricing: "", primary_value: "", key_customer: "", payer: "",
        positives: [], negatives: [], opportunities: [],
        fire_chief: "", fire_marshal: "", fire_inspector: "", facility_manager: "", ahj: "", notes: "",
      };
      for (const b of (c.bullets || c.items || []).map(text)) {
        const [k, ...rest] = b.split(":"); const val = rest.join(":").trim(); if (!k || !val) continue;
        const split = (s) => s.split(/[;•\-]\s+/).map((x) => x.trim()).filter(Boolean);
        const K = k.trim().toLowerCase();
        if (K.startsWith("pricing"))        row.pricing = val;
        else if (K.startsWith("primary value"))  row.primary_value = val;
        else if (K.startsWith("key customer"))   row.key_customer = val;
        else if (K.startsWith("who pays"))       row.payer = val;
        else if (K.startsWith("positives"))      row.positives = split(val);
        else if (K.startsWith("negatives"))      row.negatives = split(val);
        else if (K.startsWith("opportunities"))  row.opportunities = split(val);
        else if (K.startsWith("fire chief"))     row.fire_chief = val;
        else if (K.startsWith("fire marshal"))   row.fire_marshal = val;
        else if (K.startsWith("fire inspector")) row.fire_inspector = val;
        else if (K.startsWith("facility"))       row.facility_manager = val;
        else if (K === "ahj")                    row.ahj = val;
        else row.notes = (row.notes ? row.notes + " " : "") + b;
      }
      return row;
    });
  }
  return [];
}

function _normalizeVendor(v) {
  const personas = v.personas || {};
  // Personas can be strings OR arrays of strings (battlecard.json uses arrays)
  const pText = (val, fallback) => {
    const raw = val !== undefined && val !== null && val !== "" ? val : (fallback || "");
    if (Array.isArray(raw)) return raw.filter(Boolean).join("; ");
    return text(raw);
  };
  return {
    vendor:           text(v.name || v.vendor),
    site:             text(v.site || v.url || ""),
    pricing:          text(v.pricing || ""),
    primary_value:    text(v.primary_value || ""),
    core_competency:  text(v.core_competency || ""),
    category:         text(v.category || ""),
    key_customer:     text(v.key_customer || ""),
    payer:            text(v.payer || ""),
    // new field names with backward-compat fallback to legacy names
    watch_out_for:    (v.watch_out_for || v.positives  || []).map(text),
    opportunity:      (v.opportunity   || v.opportunities || []).map(text),
    positives:        (v.positives  || []).map(text),
    negatives:        (v.negatives  || []).map(text),
    fire_chief:       pText(personas.fire_chief,       v["fire chief"]),
    fire_marshal:     pText(personas.fire_marshal,     v["fire marshal"] || v["fire marshal / prevention"]),
    fire_inspector:   pText(personas.fire_inspector,   v["fire inspector"]),
    facility_manager: pText(personas.facility_manager, v["facility manager"]),
    ahj:              pText(personas.ahj,              v["ahj"]),
    building_owner:   pText(personas.building_owner,   v["building owner"] || v["building_owner"]),
    esd:              pText(personas.esd,              v["esd"]),
    notes:            text(v.notes || ""),
  };
}

function renderBattlecard(rows) {
  const tbody = $("#battlecard-body");
  if (!tbody) return;
  tbody.innerHTML = rows.slice().sort((a, b) => text(a.vendor).localeCompare(text(b.vendor))).map((r) => `
    <tr>
      <td><strong>${escapeHTML(r.vendor)}</strong></td>
      <td>${r.site ? `<a href="${escapeHTML(r.site)}" target="_blank" rel="noopener">site ↗</a>` : ""}</td>
      <td>${escapeHTML(r.pricing)}</td>
      <td>${escapeHTML(r.primary_value)}</td>
      <td>${escapeHTML(r.key_customer)}</td>
      <td>${escapeHTML(r.payer)}</td>
      <td>${listHTML(r.positives)}</td>
      <td>${listHTML(r.negatives)}</td>
      <td>${listHTML(r.opportunities)}</td>
      <td>${escapeHTML(r.fire_chief)}</td>
      <td>${escapeHTML(r.fire_marshal)}</td>
      <td>${escapeHTML(r.fire_inspector)}</td>
      <td>${escapeHTML(r.facility_manager)}</td>
      <td>${escapeHTML(r.ahj)}</td>
      <td>${escapeHTML(r.notes)}</td>
    </tr>
  `).join("");
  const meta = $("#bc-meta");
  if (meta) meta.textContent = `${rows.length} vendor${rows.length === 1 ? "" : "s"}`;
}

function rowsToCSV(rows) {
  const header = ["Vendor","Website","Pricing","Primary Value","Key Customer","Who Pays",
    "Positives","Negatives","Opportunities","Fire Chief","Fire Marshal / Prevention",
    "Fire Inspector","Facility Manager","AHJ","Notes"];
  const q = (v) => `"${text(v).replace(/"/g, '""')}"`;
  return [header.join(","), ...rows.map((r) => [
    r.vendor, r.site, r.pricing, r.primary_value, r.key_customer, r.payer,
    (r.positives || []).join(" | "), (r.negatives || []).join(" | "),
    (r.opportunities || []).join(" | "),
    r.fire_chief, r.fire_marshal, r.fire_inspector, r.facility_manager, r.ahj, r.notes,
  ].map(q).join(","))].join("\n");
}

/* =====================================================================
 * Battle Card Grid
 * ===================================================================== */
const PERSONA_KEYS   = ["fire_chief", "fire_marshal", "fire_inspector", "facility_manager", "ahj", "building_owner", "esd"];
const PERSONA_LABELS = {
  fire_chief: "Fire Chief", fire_marshal: "Fire Marshal", fire_inspector: "Fire Inspector",
  facility_manager: "Facility Mgr", ahj: "AHJ", building_owner: "Building Owner", esd: "ESD",
};

const CATEGORY_CSS_CLASS = {
  "Inspection & Testing Platforms":    "bc-cat-inspection",
  "Compliance Tracking & AHJ Portals": "bc-cat-compliance",
  "Fire Department Operations & RMS":  "bc-cat-ops",
  "Incident Command & Pre-Planning":   "bc-cat-incident",
  "Training & Workforce Compliance":   "bc-cat-training",
};
const CATEGORY_ORDER = [
  "Inspection & Testing Platforms",
  "Compliance Tracking & AHJ Portals",
  "Fire Department Operations & RMS",
  "Incident Command & Pre-Planning",
  "Training & Workforce Compliance",
];

function renderBattlecardItem(r, newsLookup) {
  // Persona rows — show label + description text for each persona with content
  const personaRows = PERSONA_KEYS
    .filter((k) => text(r[k]).trim())
    .map((k) => `
      <div class="bc-persona-row">
        <span class="bc-persona-name">${PERSONA_LABELS[k]}</span>
        <span class="bc-persona-text">${escapeHTML(r[k])}</span>
      </div>`)
    .join("");

  // News ticker
  const newsKey = text(r.vendor).toLowerCase();
  const matchedNewsKey = Object.keys(newsLookup).find((k) => k.includes(newsKey) || newsKey.includes(k));
  const recentNews = matchedNewsKey ? newsLookup[matchedNewsKey] : null;
  const newsTicker = recentNews
    ? `<div class="bc-news-ticker">
         <span class="muted small">Latest: </span>
         <a href="${escapeHTML(recentNews.url)}" target="_blank" rel="noopener" class="bc-news-link">${escapeHTML(recentNews.title || "")}</a>
         ${recentNews.date ? `<span class="muted small">${new Date(recentNews.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>` : ""}
         ${(recentNews.snippet || recentNews.summary) ? `<div class="muted small" style="margin-top:4px;">${escapeHTML((recentNews.snippet || recentNews.summary).slice(0, 180))}</div>` : ""}
       </div>`
    : "";

  // Payer badge color
  const payerClass = (r.payer || "").toLowerCase().includes("contractor") ? "bc-payer-contractor"
    : (r.payer || "").toLowerCase().includes("agency") ? "bc-payer-agency" : "";

  return `
    <div class="bc-card" data-vendor="${escapeHTML(r.vendor)}">
      <div class="bc-card-header">
        <div class="bc-card-name">
          <strong>${escapeHTML(r.vendor)}</strong>
          ${r.site ? `<a href="${escapeHTML(r.site)}" class="bc-site-link" target="_blank" rel="noopener">↗</a>` : ""}
        </div>
        <div class="bc-card-chips">
          ${r.payer ? `<span class="bc-payer-chip ${payerClass}">${escapeHTML(r.payer)}</span>` : ""}
          ${r.pricing ? `<span class="bc-pricing-chip">${escapeHTML(r.pricing)}</span>` : ""}
        </div>
      </div>
      <div class="bc-card-body">
        ${r.primary_value ? `<div class="bc-product-text">${escapeHTML(r.primary_value)}</div>` : ""}
        ${r.core_competency ? `<div class="bc-core-competency"><div class="bc-core-competency-label">Why they win</div><div class="bc-core-competency-text">${escapeHTML(r.core_competency)}</div></div>` : ""}
        ${r.watch_out_for?.length ? `<div class="bc-section bc-watch"><div class="bc-section-label">Watch Out For</div><ul>${r.watch_out_for.map((w) => `<li>${escapeHTML(w)}</li>`).join("")}</ul></div>` : ""}

        ${personaRows ? `<div class="bc-section bc-personas"><div class="bc-section-label">Persona Relevance</div><div class="bc-persona-grid">${personaRows}</div></div>` : ""}
        ${newsTicker}
      </div>
    </div>
  `;
}

function renderBattlecardGrid(rows, newsData) {
  const grid = $("#battlecard-grid");
  if (!grid) return;

  if (!rows.length) {
    grid.innerHTML = '<div class="empty-state">No competitive data yet. Run the pipeline to populate battlecards.</div>';
    return;
  }

  // Build news lookup by competitor name
  const newsLookup = {};
  if (newsData?.competitors) {
    for (const comp of newsData.competitors) {
      const key = (comp.name || "").toLowerCase();
      const latestItem = (comp.news || []).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      if (latestItem) newsLookup[key] = latestItem;
    }
  }

  // Separate profiled vendors from auto-discovered stubs (no category + no substantive content)
  const isStub = (r) => !text(r.category) && !r.watch_out_for?.length && !r.opportunity?.length && !r.core_competency;
  const profiled = rows.filter((r) => !isStub(r));
  const stubs    = rows.filter(isStub);

  // Group profiled vendors by category, preserving CATEGORY_ORDER, then alpha within each group
  const grouped = {};
  for (const cat of CATEGORY_ORDER) grouped[cat] = [];
  for (const r of profiled) {
    const cat = text(r.category) || "Other";
    if (grouped[cat]) grouped[cat].push(r);
    else grouped[cat] = [r];
  }

  const sortAlpha = (arr) => arr.slice().sort((a, b) => text(a.vendor).localeCompare(text(b.vendor)));
  const activeCats = [...CATEGORY_ORDER, "Other"].filter((c) => grouped[c]?.length);

  const stubsHTML = stubs.length ? `
    <div class="bc-stubs-section">
      <div class="bc-category-header" style="margin-bottom:10px;">
        <span class="bc-category-label">Signal Mentions — Not Yet Profiled</span>
        <span class="bc-category-count">${stubs.length}</span>
      </div>
      <div class="bc-stubs-list">
        ${sortAlpha(stubs).map((r) => `
          <div class="bc-stub-row">
            <span class="bc-stub-name">${escapeHTML(r.vendor)}</span>
            ${r.site ? `<a href="${escapeHTML(r.site)}" target="_blank" rel="noopener" class="bc-site-link">↗</a>` : ""}
            <span class="bc-stub-note muted small">${escapeHTML(r.primary_value || "")}</span>
          </div>`).join("")}
      </div>
    </div>` : "";

  grid.innerHTML = activeCats.map((cat) => `
    <div class="bc-category-group">
      <div class="bc-category-header">
        <span class="bc-category-label">${escapeHTML(cat)}</span>
        <span class="bc-category-count">${grouped[cat].length} vendor${grouped[cat].length > 1 ? "s" : ""}</span>
      </div>
      <div class="bc-group-grid">${sortAlpha(grouped[cat]).map((r) => renderBattlecardItem(r, newsLookup)).join("")}</div>
    </div>
  `).join("") + stubsHTML;

  const meta = $("#bc-meta");
  if (meta) meta.textContent = `${rows.length} vendor${rows.length === 1 ? "" : "s"}`;
}

/* =====================================================================
 * Competitor News Feed
 * ===================================================================== */
function renderCompetitorNewsFeed(newsData) {
  const feedEl = $("#competitor-news-feed");
  const unreadCountEl = $("#news-unread-count");
  const showReadBtn = $("#news-show-read");
  if (!feedEl) return;

  if (!newsData?.competitors?.length) {
    feedEl.innerHTML = '<div class="empty-state">No competitor news yet — run the pipeline to populate this feed.</div>';
    if (unreadCountEl) unreadCountEl.textContent = "0 unread";
    return;
  }

  // Flatten all news items with competitor name
  const allItems = [];
  for (const comp of newsData.competitors) {
    for (const item of (comp.news || [])) {
      if (item.url || item.title) {
        allItems.push({ ...item, competitorName: comp.name || "" });
      }
    }
  }

  if (!allItems.length) {
    feedEl.innerHTML = '<div class="empty-state">Competitor news feed is empty. Pipeline needs to run to populate news.</div>';
    if (unreadCountEl) unreadCountEl.textContent = "0 unread";
    return;
  }

  // Sort by date descending; null dates go to the end in original order
  allItems.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  // Read state from localStorage
  let readUrls = new Set();
  try { readUrls = new Set(JSON.parse(localStorage.getItem("read_news_urls") || "[]")); } catch (_) {}

  let showRead = false;

  function recencyColor(dateStr) {
    if (!dateStr) return "var(--muted)";
    const days = (Date.now() - new Date(dateStr)) / 86400000;
    if (days <= 7)  return "var(--accent-2)";
    if (days <= 30) return "var(--warn)";
    return "var(--muted)";
  }

  function renderFeed() {
    const unreadCount = allItems.filter((it) => !readUrls.has(it.url)).length;
    if (unreadCountEl) unreadCountEl.textContent = `${unreadCount} unread`;

    // Update nav badge
    updateCompetitiveBadge(unreadCount);

    const visible = showRead ? allItems : allItems.filter((it) => !readUrls.has(it.url) || it._alwaysShow);
    if (!visible.length) {
      feedEl.innerHTML = '<div class="empty-state">All items marked as read. <button id="news-show-all-btn" class="btn btn-ghost btn-sm">Show all</button></div>';
      const btn = $("#news-show-all-btn");
      if (btn) btn.addEventListener("click", () => { showRead = true; renderFeed(); });
      return;
    }

    feedEl.innerHTML = allItems.map((it) => {
      const isRead = readUrls.has(it.url);
      if (!showRead && isRead) return "";
      const dateStr = it.date
        ? new Date(it.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "Recent";
      let domain = "";
      try { domain = new URL(it.url).hostname.replace(/^www\./, ""); } catch (_) {}
      return `
        <div class="news-item${isRead ? " news-read" : ""}" data-url="${escapeHTML(it.url || "")}"
             style="border-left: 3px solid ${recencyColor(it.date)}">
          <div class="news-item-meta">
            <span class="news-competitor-label">${escapeHTML(it.competitorName)}</span>
            <span class="news-date">${dateStr}</span>
          </div>
          <div class="news-title${isRead ? " news-title-read" : ""}">${escapeHTML(it.title || "")}</div>
          ${(it.snippet || it.summary) ? `<div class="news-summary">${escapeHTML(it.snippet || it.summary)}</div>` : ""}
          <div class="news-item-footer">
            ${it.url ? `<a class="news-link" href="${escapeHTML(it.url)}" target="_blank" rel="noopener">${escapeHTML(domain)} ↗</a>` : "<span></span>"}
            <button class="btn-mark-read" data-url="${escapeHTML(it.url || "")}">${isRead ? "✓ Read" : "Mark read"}</button>
          </div>
        </div>
      `;
    }).join("");

    // Mark-read handlers
    feedEl.querySelectorAll(".btn-mark-read").forEach((btn) => {
      btn.addEventListener("click", () => {
        const url = btn.dataset.url;
        if (!url) return;
        readUrls.add(url);
        try { localStorage.setItem("read_news_urls", JSON.stringify([...readUrls])); } catch (_) {}
        renderFeed();
      });
    });
  }

  renderFeed();

  if (showReadBtn) {
    showReadBtn.addEventListener("click", () => {
      showRead = !showRead;
      showReadBtn.textContent = showRead ? "Hide read" : "Show read";
      renderFeed();
    });
  }
}

function updateCompetitiveBadge(unreadCount) {
  const btn = document.querySelector('[data-tab="competitive"]');
  if (!btn) return;
  let badge = btn.querySelector(".nav-badge");
  if (unreadCount > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      btn.appendChild(badge);
    }
    badge.textContent = unreadCount;
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }
}

async function loadCompetitive() {
  // Battlecard + competitor news (load in parallel)
  const [{ data }, newsData] = await Promise.all([
    fetchFirst(["competitor_insights.json", "competitive.json", "competitors.json", "battlecard.json"]),
    fetchJSON("competitor_news.json"),
  ]);
  const rows = normalizeBattlecard(data || {});
  renderBattlecardGrid(rows, newsData);
  renderCompetitorNewsFeed(newsData);

  let current = rows.slice();

  // Populate category filter from data
  const catSel = $("#bc-category");
  if (catSel) {
    const cats = [...new Set(rows.map((r) => text(r.category)).filter(Boolean))].sort();
    cats.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      catSel.appendChild(opt);
    });
  }

  function applyBcFilters() {
    const q        = ($("#bc-search")?.value || "").trim().toLowerCase();
    const persona  = ($("#bc-persona")?.value || "").trim();
    const category = ($("#bc-category")?.value || "").trim();
    let r = rows.slice();
    if (q) r = r.filter((x) => JSON.stringify(x).toLowerCase().includes(q));
    if (persona) {
      const key = toKey(persona);
      r = r.filter((x) => text(x[key]).length);
    }
    if (category) r = r.filter((x) => text(x.category) === category);
    current = r;
    renderBattlecardGrid(current, newsData);
  }

  $("#bc-search")?.addEventListener("input", debounce(applyBcFilters, 150));
  $("#bc-persona")?.addEventListener("change", applyBcFilters);
  $("#bc-category")?.addEventListener("change", applyBcFilters);
  $("#bc-download")?.addEventListener("click", () => download("competitive_battlecard.csv", rowsToCSV(current)));

  // Cutting Edge publications
  const ce = await fetchJSON("cutting_edge.json");
  const edgeEl = $("#cutting-edge");
  if (ce?.items?.length && edgeEl) {
    const count = $("#edge-count");
    if (count) count.textContent = ce.items.length;
    edgeEl.innerHTML = ce.items.map((it) => {
      const dateStr = it.date ? new Date(it.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
      return `
        <div class="pub-item">
          <div class="pub-item-meta">
            ${it.source ? `<span class="chip">${escapeHTML(it.source)}</span>` : ""}
            ${dateStr ? `<span class="small muted">${dateStr}</span>` : ""}
          </div>
          <a href="${escapeHTML(it.url)}" target="_blank" rel="noopener">${escapeHTML(it.title)}</a>
        </div>
      `;
    }).join("");
  } else if (edgeEl) {
    edgeEl.innerHTML = '<div class="empty-state">No industry publications loaded yet — run the pipeline to populate this feed.</div>';
  }

  // Cross-reference SEC filings + patents onto the Competitive tab (Part 4.4).
  await augmentCompetitiveWithMarketData(rows);
}

/** Fuzzy-ish name match: case-insensitive substring either direction. */
function _nameMatches(a, b) {
  const x = (a || "").toLowerCase().trim();
  const y = (b || "").toLowerCase().trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

async function augmentCompetitiveWithMarketData(rows) {
  const [sec, patents] = await Promise.all([
    fetchJSON("sec_intel.json"),
    fetchJSON("patent_intel.json"),
  ]);

  // Patent counts per competitor (from competitor_patents buckets).
  const patentCounts = {};
  if (patents && !patents.error) {
    for (const c of (patents.competitor_patents || [])) {
      patentCounts[(c.competitor || "").toLowerCase()] = (c.patents || []).length;
    }
  }
  if (Object.keys(patentCounts).length) {
    $$("#battlecard-grid [data-vendor]").forEach((card) => {
      const vendor = card.getAttribute("data-vendor") || "";
      let count = 0;
      for (const [name, n] of Object.entries(patentCounts)) {
        if (_nameMatches(vendor, name)) count = Math.max(count, n);
      }
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "badge badge--patent";
        badge.textContent = `${count} patent${count === 1 ? "" : "s"}`;
        const head = card.querySelector(".bc-card-name") || card;
        head.appendChild(badge);
      }
    });
  }

  // "Recent SEC Filings" section appended under the battlecard grid.
  const grid = $("#battlecard-grid");
  if (!grid) return;
  const existing = $("#competitive-sec-section");
  if (existing) existing.remove();
  if (feedHasError(sec)) return;

  const vendorNames = new Set(rows.map((r) => (r.vendor || "").toLowerCase()).filter(Boolean));
  const matched = (sec.companies || []).filter((c) =>
    (c.recent_filings || []).length &&
    [...vendorNames].some((v) => _nameMatches(v, c.name))
  );
  // If no battlecard vendor matches a public competitor, still show the SEC
  // companies we track so the section isn't silently empty.
  const toShow = matched.length ? matched : (sec.companies || []).filter((c) => (c.recent_filings || []).length);
  if (!toShow.length) return;

  const section = document.createElement("div");
  section.id = "competitive-sec-section";
  section.style.marginTop = "32px";
  section.innerHTML =
    `<div class="subsection-head"><h3>Recent SEC Filings</h3>` +
    `<span class="pill">${toShow.length} compan${toShow.length === 1 ? "y" : "ies"}</span></div>` +
    toShow.map((c) => {
      const rowsHTML = (c.recent_filings || []).slice(0, 5).map((f) =>
        `<li><span class="chip">${escapeHTML(f.form)}</span> ` +
        `<a href="${escapeHTML(f.url)}" target="_blank" rel="noopener">${escapeHTML(f.description || f.form)}</a> ` +
        `<span class="muted small">${fmtDate(f.date)}</span>` +
        (f.is_ma_signal ? ` <span class="badge--ma">M&amp;A</span>` : "") + `</li>`
      ).join("");
      return `<div class="sec-company"><div class="sec-company__name">${escapeHTML(c.name)}</div>` +
        `<ul class="intel-list">${rowsHTML}</ul></div>`;
    }).join("");
  grid.parentElement.insertBefore(section, grid.nextSibling);
}

/* =====================================================================
 * Sources tab
 * ===================================================================== */
async function loadSources() {
  // --- Recent items from latest.json ---
  const latest    = await fetchJSON("latest.json");
  const latestEl  = $("#latest-items");
  const latestCnt = $("#latest-count");

  if (latest?.items?.length && latestEl) {
    const items = latest.items.slice(0, 100); // show up to 100 most recent
    if (latestCnt) latestCnt.textContent = latest.items.length;
    latestEl.innerHTML = items.map((it) => {
      const dateStr = it.date
        ? new Date(it.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
        : "";
      const domain = it.url ? (() => {
        try { return new URL(it.url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
      })() : "";
      return `
        <div class="latest-item">
          <a class="latest-item-title" href="${escapeHTML(it.url)}" target="_blank" rel="noopener">${escapeHTML(it.title)}</a>
          <div class="latest-item-meta">
            ${domain  ? `<span>${escapeHTML(domain)}</span>` : ""}
            ${it.source ? `<span class="chip">${escapeHTML(it.source)}</span>` : ""}
            ${dateStr   ? `<span>${dateStr}</span>` : ""}
          </div>
          ${it.summary ? `<div class="latest-item-summary">${escapeHTML(it.summary)}</div>` : ""}
        </div>
      `;
    }).join("");
  } else if (latestEl) {
    latestEl.innerHTML = '<div class="empty-state">No recent items yet — run the pipeline to populate latest.json.</div>';
  }

  // --- Configured sources from sources_config.json ---
  const srcData = await fetchJSON("sources_config.json");
  const srcEl   = $("#sources-list");
  const srcCnt  = $("#sources-count");

  if (!srcData?.sources?.length) {
    if (srcEl) srcEl.innerHTML = `
      <div class="empty-state">
        No sources configured yet.
        <a href="./creator.html" style="color:var(--accent);">Use the Domain Creator</a>
        to set up sources, then run the pipeline to generate this list.
      </div>`;
    return;
  }

  if (srcCnt) srcCnt.textContent = srcData.sources.length;

  // Group by section
  const groups = {};
  for (const s of srcData.sources) {
    const grp = s.section || "Other";
    if (!groups[grp]) groups[grp] = [];
    groups[grp].push(s);
  }

  function renderGroups(sources) {
    const g = {};
    for (const s of sources) {
      const grp = s.section || "Other";
      if (!g[grp]) g[grp] = [];
      g[grp].push(s);
    }
    return Object.entries(g).map(([grpName, items]) => `
      <div class="source-group">
        <div class="source-group-title">${escapeHTML(grpName)} <span class="pill">${items.length}</span></div>
        <div class="source-list">
          ${items.map((s) => {
            const typeClass = `source-type-${s.type || "page"}`;
            const label     = s.label || s.url;
            const urlDisplay = s.url
              ? `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener">${escapeHTML(s.url)}</a>`
              : `<em>${escapeHTML(label)}</em>`;
            const queriesHtml = s.queries?.length
              ? `<div class="small muted" style="margin-top:6px;">${s.queries.slice(0, 5).map((q) => escapeHTML(q)).join("<br>")}</div>`
              : "";
            return `
              <div class="source-row">
                <span class="source-type-badge ${typeClass}">${escapeHTML(s.type || "page")}</span>
                <div class="source-url">${urlDisplay}${queriesHtml}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `).join("");
  }

  let filteredSources = srcData.sources.slice();

  function applySourceFilters() {
    const q    = ($("#sources-search")?.value || "").trim().toLowerCase();
    const type = ($("#sources-type-filter")?.value || "").trim();
    filteredSources = srcData.sources.filter((s) => {
      if (type && s.type !== type) return false;
      if (q && !JSON.stringify(s).toLowerCase().includes(q)) return false;
      return true;
    });
    if (srcEl) srcEl.innerHTML = renderGroups(filteredSources);
  }

  if (srcEl) srcEl.innerHTML = renderGroups(filteredSources);

  $("#sources-search")?.addEventListener("input",       debounce(applySourceFilters, 150));
  $("#sources-type-filter")?.addEventListener("change", applySourceFilters);
}

/* =====================================================================
 * Optional charts (rendered only when JSON files exist)
 * ===================================================================== */

/** Simple horizontal bar chart rendered as an SVG in a container element. */
/* Simple SVG line/area chart for time-series data.
 * items: [{date: string, value: number}]
 */
function _renderLineChart(container, items) {
  if (!container || !items?.length) return;
  const W = container.clientWidth || container.parentElement?.clientWidth || 700;
  const H = 180;
  const padL = 48, padR = 20, padT = 16, padB = 32;
  const innerW = Math.max(100, W - padL - padR);
  const innerH = H - padT - padB;

  const values = items.map((d) => d.value);
  const maxV = Math.max(...values, 1);
  const minV = Math.min(...values, 0);
  const range = maxV - minV || 1;

  const xScale = (i) => padL + (i / (items.length - 1)) * innerW;
  const yScale = (v) => padT + innerH - ((v - minV) / range) * innerH;

  const GNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(GNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.style.overflow = "visible";

  // Grid lines
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const y = padT + innerH * (1 - t);
    const line = document.createElementNS(GNS, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", padL + innerW);
    line.setAttribute("y1", y);    line.setAttribute("y2", y);
    line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    const lbl = document.createElementNS(GNS, "text");
    lbl.setAttribute("x", padL - 6); lbl.setAttribute("y", y + 4);
    lbl.setAttribute("text-anchor", "end"); lbl.setAttribute("class", "voc-x");
    lbl.textContent = Math.round(minV + range * t);
    svg.appendChild(lbl);
  });

  // Area fill
  const areaPoints = [
    `${xScale(0)},${padT + innerH}`,
    ...items.map((d, i) => `${xScale(i)},${yScale(d.value)}`),
    `${xScale(items.length - 1)},${padT + innerH}`,
  ].join(" ");
  const area = document.createElementNS(GNS, "polygon");
  area.setAttribute("points", areaPoints);
  area.setAttribute("fill", "var(--accent)"); area.setAttribute("fill-opacity", "0.12");
  svg.appendChild(area);

  // Line
  const linePoints = items.map((d, i) => `${xScale(i)},${yScale(d.value)}`).join(" ");
  const polyline = document.createElementNS(GNS, "polyline");
  polyline.setAttribute("points", linePoints);
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "var(--accent)"); polyline.setAttribute("stroke-width", "2");
  polyline.setAttribute("stroke-linejoin", "round"); polyline.setAttribute("stroke-linecap", "round");
  svg.appendChild(polyline);

  // X-axis date labels (every ~6 points)
  const step = Math.max(1, Math.floor(items.length / 6));
  items.forEach((d, i) => {
    if (i % step !== 0 && i !== items.length - 1) return;
    const lbl = document.createElementNS(GNS, "text");
    lbl.setAttribute("x", xScale(i)); lbl.setAttribute("y", H - 4);
    lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("class", "voc-x");
    lbl.textContent = d.date;
    svg.appendChild(lbl);
  });

  // Dots on recent few points
  items.slice(-5).forEach((d, ii) => {
    const i = items.length - 5 + ii;
    const dot = document.createElementNS(GNS, "circle");
    dot.setAttribute("cx", xScale(i)); dot.setAttribute("cy", yScale(d.value));
    dot.setAttribute("r", "3"); dot.setAttribute("fill", "var(--accent)");
    svg.appendChild(dot);
  });

  container.innerHTML = "";
  container.appendChild(svg);
}

function renderHBarChart(container, items, { labelKey, valueKey, maxItems = 15 } = {}) {
  if (!container || !items?.length) return;
  const data = items.slice(0, maxItems);
  const maxV = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const rowH = 28;
  const padLeft = 160;
  const padRight = 48;
  const W = container.clientWidth || container.parentElement?.clientWidth || 700;
  const H = data.length * rowH + 20;
  const innerW = Math.max(200, W - padLeft - padRight);

  const GNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(GNS, "svg");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.classList.add("voc-svg");

  data.forEach((d, i) => {
    const y = i * rowH + 4;
    const barW = Math.round((d[valueKey] / maxV) * innerW);

    const label = document.createElementNS(GNS, "text");
    label.setAttribute("x", padLeft - 8);
    label.setAttribute("y", y + rowH / 2 + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "voc-x");
    label.textContent = text(d[labelKey]).slice(0, 26);
    svg.appendChild(label);

    const rect = document.createElementNS(GNS, "rect");
    rect.setAttribute("x", padLeft);
    rect.setAttribute("y", y + 4);
    rect.setAttribute("width", Math.max(2, barW));
    rect.setAttribute("height", rowH - 10);
    rect.setAttribute("rx", "3");
    rect.setAttribute("class", "voc-bar");
    svg.appendChild(rect);

    const val = document.createElementNS(GNS, "text");
    val.setAttribute("x", padLeft + barW + 6);
    val.setAttribute("y", y + rowH / 2 + 4);
    val.setAttribute("class", "voc-y");
    val.textContent = d[valueKey];
    svg.appendChild(val);
  });

  container.innerHTML = "";
  container.appendChild(svg);
}

async function loadOptionalCharts() {
  const [trends, quality, mentions, improveLog, analytics] = await Promise.all([
    fetchJSON("voc_trends.json"),
    fetchJSON("source_quality.json"),
    fetchJSON("competitor_mentions.json"),
    fetchJSON("self_improve_log.json"),
    fetchJSON("analytics.json"),
  ]);

  // Last-updated bar + staleness warning
  const runDate = analytics?.generated_at || analytics?.run_at;
  if (runDate) {
    const bar = $("#last-updated-bar");
    const dateEl = $("#pipeline-run-date");
    if (bar && dateEl) {
      try { dateEl.textContent = new Date(runDate).toLocaleString(); } catch (_) {}
      bar.hidden = false;

      // Show staleness warning only if data is more than 4 days old
      // (pipeline is weekday-only so Fri→Mon is normal — don't false-alarm on weekends)
      try {
        const ageMs = Date.now() - new Date(runDate).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        if (ageHours > 96) { // 4 days
          const ageDays = Math.floor(ageHours / 24);
          bar.classList.add("last-updated-bar--stale");
          const staleWarn = document.createElement("span");
          staleWarn.className = "stale-warning";
          staleWarn.textContent = `\u26a0\ufe0f Data is ${ageDays} day${ageDays !== 1 ? "s" : ""} old — pipeline may need attention`;
          bar.appendChild(staleWarn);
        }
      } catch (_) {}
    }
  }

  // Source quality chart
  if (quality?.sources?.length) {
    const wrap = $("#source-quality-wrap");
    if (wrap) wrap.hidden = false;
    const container = $("#source-quality-chart");
    if (container) {
      renderHBarChart(container, quality.sources, { labelKey: "domain", valueKey: "card_count", maxItems: 15 });
    }
  }

  // Competitor mentions chart — self_improve.py writes mentions as an array [{name, count}, ...]
  const mentionsArr = Array.isArray(mentions?.mentions)
    ? mentions.mentions
    : (mentions?.mentions ? Object.entries(mentions.mentions).map(([name, count]) => ({ name, count })) : null);
  if (mentionsArr?.length) {
    const wrap = $("#competitor-mentions-wrap");
    if (wrap) wrap.hidden = false;
    const container = $("#competitor-mentions-chart");
    const mentCnt = $("#mentions-count");
    if (container) {
      const items = mentionsArr.slice().sort((a, b) => (b.count || 0) - (a.count || 0));
      if (mentCnt) mentCnt.textContent = items.length;
      renderHBarChart(container, items, { labelKey: "name", valueKey: "count", maxItems: 15 });
    }
  }

  // Self-improve log — _write_log stores {"runs": [...]}; latest run is runs[last]
  const latestRun = Array.isArray(improveLog?.runs)
    ? improveLog.runs[improveLog.runs.length - 1]
    : (improveLog?.date ? improveLog : null); // fallback: old single-entry format
  if (latestRun) {
    const wrap = $("#self-improve-wrap");
    if (wrap) wrap.hidden = false;
    const logEl = $("#self-improve-log");
    const runDate = $("#improve-run-date");
    const dateStr = latestRun.date || latestRun.run_at || "";
    if (runDate && dateStr) {
      try { runDate.textContent = new Date(dateStr).toLocaleString(); } catch (_) {}
    }
    if (logEl) {
      const added = [
        ...(latestRun.sources_added || []).map((u) => `<li>Source: <code>${escapeHTML(String(u))}</code></li>`),
        ...(latestRun.queries_added || []).map((q) => `<li>Query: <em>${escapeHTML(q)}</em></li>`),
        ...(latestRun.competitors_added || []).map((c) => `<li>Competitor: <strong>${escapeHTML(typeof c === "string" ? c : (c.name || JSON.stringify(c)))}</strong></li>`),
      ];
      const skipped = (latestRun.skipped || []).length + (latestRun.rejected || []).length;
      const totalRuns = improveLog?.runs?.length || 1;
      logEl.innerHTML = `
        <div class="source-row" style="gap:16px; flex-wrap:wrap; margin-bottom:12px;">
          <span class="chip">+${(latestRun.sources_added || []).length} sources</span>
          <span class="chip">+${(latestRun.queries_added || []).length} queries</span>
          <span class="chip">+${(latestRun.competitors_added || []).length} competitors</span>
          <span class="small muted">${skipped} skipped / rejected</span>
          <span class="small muted">${totalRuns} total agent runs</span>
        </div>
        ${added.length ? `<ul class="small" style="margin:0 0 12px; padding-left:20px;">${added.join("")}</ul>` : '<p class="small muted">No changes made this run.</p>'}
        ${latestRun.reasoning ? `<p class="small muted" style="margin:0 0 8px;"><em>${escapeHTML(latestRun.reasoning)}</em></p>` : ""}
        <details>
          <summary class="small" style="cursor:pointer; color:var(--accent);">Full log JSON (last ${totalRuns} runs)</summary>
          <pre style="font-size:11px; color:var(--muted); white-space:pre-wrap; word-break:break-all; max-height:300px; overflow-y:auto;">${escapeHTML(JSON.stringify(improveLog, null, 2))}</pre>
        </details>
      `;
    }
  }
}

/* =====================================================================
 * Trends Tab
 * ===================================================================== */
async function loadTrends() {
  const history = await fetchJSON("voc_history.json");
  const tbody = $("#trends-velocity-body");
  const emptyEl = $("#trends-velocity-empty");

  // Also try to render history chart
  const histWrap = $("#trends-history-wrap");
  const histChart = $("#trends-history-chart");

  if (!history?.length || history.length < 2) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  // Render signal history chart — SVG line chart showing total signals over time
  if (histWrap && histChart) {
    histWrap.hidden = false;
    const pts = history.slice(-30);
    const totals = pts.map((pt) => ({
      date: pt.date ? new Date(pt.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "",
      value: Object.values(pt.by_category || {}).reduce((s, v) => s + (Number(v) || 0), 0),
    }));
    _renderLineChart(histChart, totals);
  }

  if (!tbody) return;

  const recent14 = history.slice(-14);
  const prior14  = history.slice(-28, -14);

  const categories = new Set(recent14.flatMap((h) => Object.keys(h.by_category || {})));

  function avg(snapshots, cat) {
    const vals = snapshots.map((h) => Number(h.by_category?.[cat]) || 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  const velocity = [...categories].map((cat) => {
    const recentAvg = avg(recent14, cat);
    const priorAvg  = avg(prior14.length ? prior14 : recent14, cat);
    const delta     = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;
    return { cat, recentAvg, priorAvg, delta };
  }).sort((a, b) => b.recentAvg - a.recentAvg);

  if (!velocity.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  // Hide empty state — we have data
  if (emptyEl) emptyEl.hidden = true;

  tbody.innerHTML = velocity.map(({ cat, recentAvg, priorAvg, delta }) => {
    const arrow = delta > 15 ? "↑" : delta < -15 ? "↓" : "→";
    const arrowClass = delta > 15 ? "trend-up" : delta < -15 ? "trend-down" : "trend-flat";
    const deltaStr = delta !== 0 ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%` : "—";
    return `
      <tr>
        <td><strong>${escapeHTML(cat)}</strong></td>
        <td class="num">${recentAvg.toFixed(1)}</td>
        <td class="num">${priorAvg.toFixed(1)}</td>
        <td class="num">${deltaStr}</td>
        <td><span class="trend-arrow ${arrowClass}">${arrow}</span></td>
      </tr>`;
  }).join("");
}

/* =====================================================================
 * PM Hub
 * ===================================================================== */
let _pmHubLoaded = false;
function loadPMHubLazy() {
  if (_pmHubLoaded) return;
  _pmHubLoaded = true;
  loadPMHub();
}

async function loadPMHub() {
  const data = await fetchJSON("pm_hub.json");
  if (!data) return;

  const genAt = $("#pm-generated-at");
  if (genAt && data.generated_at) genAt.textContent = `Generated: ${data.generated_at.slice(0,16).replace("T"," ")} UTC`;

  _renderRegRadar(data.regulatory_radar || []);
  _renderGapMap(data.feature_gap_map || {});
  _renderTechSignals(data.technology_signals || []);
  _renderMATargets(data.ma_targets || []);
  _renderHorizons(data.strategic_horizons || {});
  _renderPRDSeeds(data.prd_seeds || []);

  const dlBtn = $("#pm-download");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "pm_hub.json";
      a.click();
    });
  }
}

function _renderRegRadar(items) {
  const body  = $("#pm-reg-body");
  const count = $("#pm-reg-count");
  const empty = $("#pm-reg-empty");
  if (!body) return;
  if (count) count.textContent = items.length;
  if (!items.length) { if (empty) empty.hidden = false; body.closest("table").hidden = true; return; }
  body.innerHTML = items.map(r => {
    // standards may be an array or a string
    const stdArr = Array.isArray(r.standards) ? r.standards : (r.standard ? [r.standard] : []);
    const stdStr = stdArr.length ? stdArr.join(", ") : "—";
    // product_opportunity may be missing — derive from JTBD if blank
    const prodOpp = r.product_opportunity || (r.jtbd ? r.jtbd.slice(0, 80) + "…" : "—");
    return `
    <tr>
      <td><strong>${escapeHTML(stdStr)}</strong></td>
      <td><span class="tag tag-region">${escapeHTML(r.region || "—")}</span></td>
      <td><span class="urgency-badge urg-${Math.min(5, Math.max(1, r.urgency || 3))}">${r.urgency || "—"}/5</span></td>
      <td>${escapeHTML(prodOpp)}</td>
      <td class="small muted"><a href="${escapeHTML(r.url || "#")}" target="_blank" rel="noopener" class="url-link">${escapeHTML(r.title || r.url || "")}</a></td>
    </tr>`;
  }).join("");
}

function _renderGapMap(rawGapMap) {
  const grid = $("#pm-gap-grid");
  if (!grid) return;

  // Normalize: agent outputs {categories, competitors, matrix, gaps, note}
  // where matrix[cat][vendor] = {coverage: 'strong'|'weak'|'none', voc_demand: N}
  // The renderer expects a flat map: gapMap[cat][vendor] = 'strong'|'weak'|null
  let gapMap = rawGapMap;
  if (rawGapMap && rawGapMap.matrix && typeof rawGapMap.matrix === 'object') {
    gapMap = {};
    for (const [cat, vendors] of Object.entries(rawGapMap.matrix)) {
      gapMap[cat] = {};
      for (const [vendor, info] of Object.entries(vendors || {})) {
        const cov = typeof info === 'object' ? (info.coverage || null) : info;
        // Normalize 'none' -> null so it renders as ○
        gapMap[cat][vendor] = (cov && cov !== 'none') ? cov : null;
      }
    }
    // Attach gap scores from gaps array
    for (const g of (rawGapMap.gaps || [])) {
      if (gapMap[g.category]) gapMap[g.category].__gap_score__ = Math.round(g.gap_score ?? 0);
    }
  }

  const categories = Object.keys(gapMap);
  if (!categories.length) { grid.innerHTML = '<p class="muted small">No gap data available.</p>'; return; }

  // Collect all competitors across all categories
  const allVendors = new Set();
  categories.forEach(cat => Object.keys(gapMap[cat] || {}).filter(v => v !== '__gap_score__').forEach(v => allVendors.add(v)));
  const vendors = [...allVendors].sort();

  const coverageClass = (v) => {
    if (!v) return "gap-none";
    if (v === "strong") return "gap-strong";
    if (v === "weak")   return "gap-weak";
    return "gap-none";
  };
  const coverageLabel = (v) => v === "strong" ? "●" : v === "weak" ? "◐" : "○";

  grid.innerHTML = `
    <div class="gap-table-wrap">
      <table class="gap-table">
        <thead>
          <tr>
            <th class="gap-cat-col">Pain Category</th>
            ${vendors.map(v => `<th class="gap-vendor-col" title="${escapeHTML(v)}">${escapeHTML(v.length > 12 ? v.slice(0,11)+"…" : v)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${categories.map(cat => {
            const row = gapMap[cat] || {};
            const gapScore = row.__gap_score__ != null ? row.__gap_score__ : null;
            return `<tr>
              <td class="gap-cat-label">
                <span class="gap-cat-name">${escapeHTML(cat)}</span>
                ${gapScore != null ? `<span class="gap-score-pill ${gapScore >= 70 ? "gap-score-high" : gapScore >= 40 ? "gap-score-med" : "gap-score-low"}" title="Gap score: higher = more opportunity">${gapScore}%</span>` : ""}
              </td>
              ${vendors.map(v => {
                const val = row[v];
                return `<td class="gap-cell ${coverageClass(val)}" title="${escapeHTML(v)}: ${val || 'none'}">${coverageLabel(val)}</td>`;
              }).join("")}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
      <div class="gap-legend">
        <span class="gap-strong">● Strong</span>
        <span class="gap-weak">◐ Weak</span>
        <span class="gap-none">○ None</span>
        <span class="small muted" style="margin-left:8px;">Gap score % = how uncovered competitors are</span>
      </div>
    </div>`;
}

function _renderTechSignals(items) {
  const body  = $("#pm-tech-body");
  const count = $("#pm-tech-count");
  if (!body) return;
  if (count) count.textContent = items.length;
  if (!items.length) { body.innerHTML = '<p class="muted small">No technology signals found.</p>'; return; }

  const horizons = ["near", "mid", "long"];
  const horizonLabel = { near: "Near-term (0–12 mo)", mid: "Mid-term (1–2 yr)", long: "Long-term (2–5 yr)" };
  const grouped = {};
  horizons.forEach(h => { grouped[h] = items.filter(i => i.horizon === h); });

  body.innerHTML = horizons.map(h => {
    const items = grouped[h];
    if (!items.length) return "";
    return `
      <div class="pm-horizon-section">
        <div class="pm-horizon-label">${horizonLabel[h]}</div>
        <div class="pm-tech-cards">
          ${items.map(s => `
            <div class="pm-tech-card">
              <div class="pm-tech-title">${escapeHTML(s.title || "")}</div>
              <div class="pm-tech-meta">
                <span class="tag tag-topic">${escapeHTML(s.ai_lever || "")}</span>
                ${s.persona ? `<span class="tag tag-persona">${escapeHTML(s.persona)}</span>` : ""}
                ${s.urgency ? `<span class="urgency-badge urg-${Math.min(5,s.urgency)}">${s.urgency}/5</span>` : ""}
              </div>
              ${s.summary ? `<div class="pm-tech-summary small muted">${escapeHTML(s.summary)}</div>` : ""}
              ${s.url ? `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener" class="pm-tech-link small">Source ↗</a>` : ""}
            </div>`).join("")}
        </div>
      </div>`;
  }).join("");
}

function _renderMATargets(items) {
  const body  = $("#pm-ma-body");
  const count = $("#pm-ma-count");
  const empty = $("#pm-ma-empty");
  if (!body) return;
  if (count) count.textContent = items.length;
  if (!items.length) { if (empty) empty.hidden = false; body.closest("table").hidden = true; return; }
  body.innerHTML = items.map(r => {
    // category may be missing — derive from primary_value or notes
    const cat = r.category || (r.primary_value ? r.primary_value.split(" ")[0] : "") || "—";
    // rationale may be a placeholder tag — prefer notes or primary_value
    const rationale = (r.rationale && r.rationale !== "signal") ? r.rationale
      : (r.notes || r.primary_value || "—");
    // signal_count: 0 is valid but unhelpful — show ma_score as secondary
    const sigDisplay = r.signal_count > 0 ? r.signal_count
      : (r.ma_score != null ? `Score: ${r.ma_score}` : "—");
    return `
    <tr>
      <td><strong>${escapeHTML(r.name || "—")}</strong>
        ${r.url ? `<a href="${escapeHTML(r.url)}" target="_blank" rel="noopener" class="small muted" style="margin-left:6px;">↗</a>` : ""}
      </td>
      <td>${cat !== "—" ? `<span class="tag tag-topic">${escapeHTML(cat)}</span>` : "—"}</td>
      <td class="num">${sigDisplay}</td>
      <td class="small">${escapeHTML(rationale)}</td>
      <td><span class="tag ${r.source === 'pending' ? 'tag-region' : 'tag-persona'}">${escapeHTML(r.source || "signal")}</span></td>
    </tr>`;
  }).join("");
}

function _renderHorizons(horizons) {
  const body = $("#pm-horizons-body");
  if (!body) return;

  const quarterly = horizons.quarterly_focus || [];
  const bets      = horizons.three_year_bets || [];
  const tech      = horizons.tech_shifts || [];
  const insights  = horizons.strategic_insights || [];

  body.innerHTML = `
    <div class="pm-horizons-grid">
      <div class="pm-horizon-block">
        <div class="pm-horizon-title">🎯 This Quarter — Urgent Signals</div>
        ${quarterly.length
          ? quarterly.map(q => `<div class="pm-horizon-item">
              <span class="pm-hitem-title">${escapeHTML(q.category || q.title || "")}</span>
              ${q.signal_count != null ? `<span class="pill">${q.signal_count} signals</span>` : ""}
              ${q.urgency != null ? `<span class="urgency-badge urg-${Math.min(5,q.urgency)}">${q.urgency}/5</span>` : ""}
              ${q.top_jtbd ? `<div class="small muted">JTBD: ${escapeHTML(q.top_jtbd)}</div>` : ""}
            </div>`).join("")
          : '<p class="small muted">No high-urgency signals this period.</p>'}
      </div>
      <div class="pm-horizon-block">
        <div class="pm-horizon-title">🔭 3-Year Technology Bets</div>
        ${bets.length
          ? bets.map(b => `<div class="pm-horizon-item">
              <span class="pm-hitem-title">${escapeHTML(b.ai_lever || b.title || "")}</span>
              ${b.signal_count != null ? `<span class="pill">${b.signal_count} signals</span>` : ""}
              ${b.example_title ? `<div class="small muted">${escapeHTML(b.example_title)}</div>` : ""}
            </div>`).join("")
          : '<p class="small muted">No long-horizon technology signals yet.</p>'}
      </div>
      <div class="pm-horizon-block">
        <div class="pm-horizon-title">📈 Emerging Tech Shifts (30d)</div>
        ${tech.length
          ? tech.map(t => `<div class="pm-horizon-item">
              <span class="pm-hitem-title">${escapeHTML(t.ai_lever || t.name || "")}</span>
              ${t.count != null ? `<span class="pill">${t.count} mentions</span>` : ""}
            </div>`).join("")
          : '<p class="small muted">No recent tech shift data.</p>'}
      </div>
      <div class="pm-horizon-block">
        <div class="pm-horizon-title">💡 Strategic Insights</div>
        ${insights.length
          ? insights.map(i => `<div class="pm-horizon-item small">${escapeHTML(i)}</div>`).join("")
          : '<p class="small muted">No strategic insights synthesised yet.</p>'}
      </div>
    </div>`;
}

function _renderPRDSeeds(seeds) {
  const tabs = $("#pm-prd-tabs");
  const body = $("#pm-prd-body");
  if (!body || !seeds.length) {
    if (body) body.innerHTML = '<p class="small muted">No PRD seeds generated. Run the pipeline to generate persona-based PRD seeds from VOC data.</p>';
    return;
  }

  // Build tab buttons
  if (tabs) {
    tabs.innerHTML = seeds.map((s, i) => `
      <button class="filter-btn${i === 0 ? " active" : ""}" data-prd-idx="${i}">
        ${escapeHTML(s.persona || `Persona ${i+1}`)}
      </button>`).join("");
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-prd-idx]");
      if (!btn) return;
      $$(".filter-btn", tabs).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _renderPRDSeedPanel(seeds[Number(btn.dataset.prdIdx)]);
    });
  }

  _renderPRDSeedPanel(seeds[0]);
}

function _renderPRDSeedPanel(seed) {
  const body = $("#pm-prd-body");
  if (!body || !seed) return;

  const jtbds  = seed.top_jtbds  || [];
  const pains  = seed.top_pains  || [];
  const parity = (seed.parity_caps && Array.isArray(seed.parity_caps)) ? seed.parity_caps : [];
  const sigs   = seed.top_signals || [];
  // Derive pains from top_signals if top_pains is empty
  const painItems = pains.length ? pains
    : sigs.slice(0, 4).map(s => s.root_cause || s.title || "").filter(Boolean);

  body.innerHTML = `
    <div class="prd-seed-grid">
      <div class="prd-seed-block">
        <div class="prd-seed-title">Jobs To Be Done</div>
        ${jtbds.length
          ? `<ul class="prd-seed-list">${jtbds.map(j => `<li>${escapeHTML(j)}</li>`).join("")}</ul>`
          : '<p class="small muted">No JTBD data.</p>'}
      </div>
      <div class="prd-seed-block">
        <div class="prd-seed-title">Key Pains</div>
        ${painItems.length
          ? `<ul class="prd-seed-list">${painItems.map(p => `<li>${escapeHTML(typeof p === "string" ? p : p.why || p.title || "")}</li>`).join("")}</ul>`
          : '<p class="small muted">No pain data yet — more pipeline runs will populate this.</p>'}
      </div>
      <div class="prd-seed-block">
        <div class="prd-seed-title">Parity Capabilities Demanded</div>
        ${parity.length
          ? `<ul class="prd-seed-list">${parity.map(p => `<li>${escapeHTML(p)}</li>`).join("")}</ul>`
          : '<p class="small muted">Parity data builds over time as signals accumulate.</p>'}
      </div>
      <div class="prd-seed-block">
        <div class="prd-seed-title">Top Supporting Signals</div>
        ${sigs.length
          ? sigs.map(s => `<div class="prd-signal-item">
              <div class="small">${escapeHTML(s.title || "")}</div>
              <div class="small muted">${escapeHTML(s.source || "")}${s.published ? " · " + escapeHTML(s.published.slice(0,10)) : ""}</div>
            </div>`).join("")
          : '<p class="small muted">No signals.</p>'}
      </div>
    </div>`;
}

/* =====================================================================
 * Boot
 * ===================================================================== */
async function loadSettingsBadge() {
  const badge = $("#settings-pending-badge");
  if (!badge) return;
  const data = await fetchJSON("sources_config.json");
  const count = data?.pending_suggestions_count || 0;
  if (count > 0) {
    badge.textContent = count;
    badge.hidden = false;
  }
}

/* =====================================================================
 * Field Intel + Market Intel tabs
 *
 * Every panel degrades gracefully: if a feed is missing or carries an
 * `error` field, we render a "Data unavailable" notice instead of crashing.
 * ===================================================================== */
function fmtNum(n) {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${fmtNum(v)}`;
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return escapeHTML(String(s).slice(0, 10));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statCard(label, value) {
  return `<div class="stat-card"><div class="stat-card__num">${escapeHTML(String(value))}</div>` +
         `<div class="stat-card__label">${escapeHTML(label)}</div></div>`;
}

function intelPanel(title, bodyHTML) {
  return `<section class="intel-panel">` +
    `<div class="intel-panel__header">${escapeHTML(title)}</div>` +
    `<div class="intel-panel__body">${bodyHTML}</div></section>`;
}

function dataUnavailable(msg) {
  return `<div class="empty-state">${escapeHTML(msg || "Data unavailable.")}</div>`;
}

function feedHasError(data) {
  // null/undefined feed, an explicit error field, or no usable object.
  return !data || typeof data !== "object" || !!data.error;
}

function starRating(rating) {
  const r = Math.round(Number(rating) || 0);
  const full = "★".repeat(Math.max(0, Math.min(5, r)));
  const empty = "☆".repeat(Math.max(0, 5 - r));
  return `<span class="star-rating" title="${escapeHTML(String(rating || 0))} / 5">${full}${empty}</span>`;
}

function simpleTable(headers, rows) {
  if (!rows.length) return dataUnavailable("No records.");
  const head = headers.map((h) => `<th>${escapeHTML(h)}</th>`).join("");
  const body = rows.map((cells) =>
    `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`
  ).join("");
  return `<table class="intel-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---- Field Intel panels ---- */
function panelFema(d) {
  if (feedHasError(d)) return intelPanel("FEMA Fire Activity", dataUnavailable("FEMA data unavailable."));
  const s = d.summary || {};
  const stats = `<div class="stat-row">` +
    statCard("Active Fire Declarations", fmtNum(s.total_fire_declarations_ytd || (d.disaster_declarations || []).length)) +
    statCard("Open Grants", fmtNum(s.active_grant_count || (d.active_grants || []).length)) +
    statCard("Total Grant Ceiling", fmtMoney(s.total_grant_ceiling)) +
    `</div>`;

  const decls = (d.disaster_declarations || []).slice(0, 12).map((x) => [
    escapeHTML(x.state), escapeHTML(x.county), fmtDate(x.declaration_date),
    escapeHTML((x.programs_declared || []).join(", ")),
  ]);
  const declTable = simpleTable(["State", "County", "Declared", "Programs"], decls);

  const grants = (d.active_grants || []).slice(0, 10).map((g) => [
    `<a href="https://www.grants.gov/search-results-detail/${encodeURIComponent(g.opportunity_id || "")}" target="_blank" rel="noopener">${escapeHTML(g.title || "(untitled)")}</a>`,
    escapeHTML(g.agency || ""), fmtDate(g.close_date), escapeHTML(String(g.award_ceiling || "")),
  ]);
  const grantTable = simpleTable(["Opportunity", "Agency", "Closes", "Ceiling"], grants);

  return intelPanel("FEMA Fire Activity",
    stats +
    `<h4 class="intel-subhead">Recent Fire Disaster Declarations</h4>${declTable}` +
    `<h4 class="intel-subhead">Active Grant Opportunities</h4>${grantTable}`);
}

function panelWildfire(d) {
  if (feedHasError(d)) return intelPanel("Wildfire Watch", dataUnavailable("Wildfire data unavailable."));
  const incidents = d.incidents || [];
  const alerts = d.weather_alerts || [];
  const declarations = d.fema_declarations || [];
  const s = d.summary || {};

  // Banner for high-severity alerts
  const fireAlerts = alerts.filter(a => a.event && (a.event.includes("Fire") || a.event.includes("Red Flag")));
  let banner = "";
  if (fireAlerts.length) {
    banner = `<div class="alert-banner">⚠ ${fmtNum(fireAlerts.length)} active fire weather alert${fireAlerts.length === 1 ? "" : "s"}</div>`;
  }

  const stats = `<div class="stat-row">` +
    statCard("Active Fires", fmtNum(s.active_incidents || incidents.length)) +
    statCard("Acres Burning", fmtNum(s.total_acres_burning || 0)) +
    statCard("Structures Lost", fmtNum(s.total_structures_destroyed || 0)) +
    statCard("Fire Declarations", fmtNum(s.fema_declarations_recent || declarations.length)) +
    `</div>`;

  const topFires = incidents.slice(0, 12).map(f => [
    escapeHTML(f.name || ""),
    fmtNum(f.acres || 0),
    f.contained_pct != null ? `${f.contained_pct}%` : "—",
    escapeHTML(f.state || ""),
    escapeHTML(f.cause || f.complexity || "") || "—",
  ]);
  const fireTable = simpleTable(["Fire", "Acres", "Contained", "State", "Cause / Complexity"], topFires);

  // Recent FEMA fire declarations — dedup by disaster_number
  const seenDecls = new Set();
  const dedupedDecls = declarations.filter(d2 => {
    const key = d2.disaster_number || (d2.state + d2.title + d2.declaration_date);
    if (seenDecls.has(key)) return false;
    seenDecls.add(key);
    return true;
  });
  const declRows = dedupedDecls.slice(0, 8).map(d2 => [
    escapeHTML(d2.disaster_number || ""),
    escapeHTML(d2.state || ""),
    escapeHTML(d2.title || ""),
    fmtDate(d2.declaration_date),
  ]);
  const declTable = declRows.length ? simpleTable(["Disaster #", "State", "Title", "Date"], declRows) : "";

  // Weather alerts
  const warnList = alerts.slice(0, 8).map((w) =>
    `<li><strong>${escapeHTML(w.event || "")}</strong>: ` +
    `${escapeHTML((w.area || "").substring(0, 80))} ` +
    `<span class="muted small">(expires ${fmtDate(w.expires)})</span></li>`
  ).join("");
  const warnHTML = warnList ? `<ul class="intel-list">${warnList}</ul>` : "";

  return intelPanel("Wildfire Watch",
    banner + stats +
    `<h4 class="intel-subhead">Largest Active Fires</h4>${fireTable}` +
    (declTable ? `<h4 class="intel-subhead">FEMA Fire Declarations (Recent)</h4>${declTable}` : "") +
    (warnHTML ? `<h4 class="intel-subhead">Fire Weather Alerts</h4>${warnHTML}` : ""));
}

function panelEcfr(d) {
  if (feedHasError(d)) return intelPanel("Regulatory Radar", dataUnavailable("eCFR data unavailable."));
  const newCount = d.summary?.total_new_changes || 0;
  const badge = `<span class="badge ${newCount > 0 ? "badge--new" : ""}">${fmtNum(newCount)} New Regulatory Change${newCount === 1 ? "" : "s"}</span>`;
  const allChanges = [];
  for (const t of (d.titles || [])) {
    for (const c of (t.changes || [])) {
      allChanges.push({ ...c, _label: t.label || t.title });
    }
  }
  allChanges.sort((a, b) => String(b.amendment_date || "").localeCompare(String(a.amendment_date || "")));
  const rows = allChanges.slice(0, 15).map((c) => [
    escapeHTML(c._label || ""),
    escapeHTML(c.section || c.part || ""),
    fmtDate(c.amendment_date || c.issue_date) + (c.is_new ? ` <span class="badge--new">NEW</span>` : ""),
  ]);
  const table = simpleTable(["Title", "Section", "Amended"], rows);
  return intelPanel("Regulatory Radar", `<div style="margin-bottom:10px;">${badge}</div>${table}`);
}

function panelGrants(d) {
  if (feedHasError(d)) return intelPanel("Grant Intelligence", dataUnavailable("Grants data unavailable."));
  const s = d.summary || {};
  // awards[] = AFG/SAFER by CFDA program number (fire-specific, from USASpending)
  // opportunities[] = open/forecasted Grants.gov fire opportunities (may be awarded fallback)
  const awards = (d.awards && d.awards.length > 0) ? d.awards : [];
  const opps = (d.opportunities && d.opportunities.length > 0) ? d.opportunities : [];

  const totalAwarded = s.total_awarded || awards.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  // Total ceiling = sum of award_ceiling across open opportunities
  const totalCeiling = opps.reduce((sum, o) => sum + (Number(o.award_ceiling) || 0), 0);

  const stats = `<div class="stat-row">` +
    statCard("Open Opportunities", fmtNum(opps.length || s.open_opportunity_count || 0)) +
    statCard("Total Grant Ceiling", totalCeiling > 0 ? fmtMoney(totalCeiling) : "See Grants.gov") +
    statCard("AFG/SAFER Awards", fmtNum(s.award_count || awards.length)) +
    statCard("Total Awarded (FY25+)", fmtMoney(totalAwarded)) +
    `</div>`;

  // Open opportunities table — show ceiling when available
  const oppRows = opps.slice(0, 12).map((o) => [
    escapeHTML((o.title || "").substring(0, 50)),
    escapeHTML(o.agency || ""),
    o.award_ceiling != null ? fmtMoney(o.award_ceiling) : "—",
    fmtDate(o.close_date || o.open_date),
  ]);
  const oppTable = oppRows.length
    ? simpleTable(["Opportunity", "Agency", "Ceiling", "Close/Post Date"], oppRows)
    : "<p class=\"muted small\">No fire-specific open opportunities found this run — check Grants.gov for AFG/SAFER listings.</p>";

  // AFG/SAFER awards table
  const awardRows = awards.slice(0, 10).map((a) => [
    escapeHTML((a.recipient || "").substring(0, 40)),
    fmtMoney(a.amount || 0),
    escapeHTML(a.state || ""),
    fmtDate(a.start_date),
  ]);
  const awardTable = awardRows.length ? simpleTable(["Recipient", "Amount", "State", "Date"], awardRows) : "";

  // Top states by AFG/SAFER award amount
  const byState = {};
  for (const a of awards) {
    const st = a.state || "";
    if (!st) continue;
    byState[st] = (byState[st] || 0) + (Number(a.amount) || 0);
  }
  const stateItems = Object.entries(byState)
    .map(([state, amount]) => ({ state, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount).slice(0, 10);

  const chartId = "grants-state-chart";
  const chartHTML = stateItems.length ? `<div id="${chartId}" class="vbar"></div>` : "";

  const html = stats +
    `<h4 class="intel-subhead">Active Fire Grant Opportunities (AFG / SAFER / Wildfire)</h4>${oppTable}` +
    (awardTable ? `<h4 class="intel-subhead">Recent AFG/SAFER Award Recipients</h4>${awardTable}` : "") +
    (chartHTML ? `<h4 class="intel-subhead">Top States by Award Amount</h4>${chartHTML}` : "");

  setTimeout(() => {
    const el = document.getElementById(chartId);
    if (el && stateItems.length) renderHBarChart(el, stateItems, { labelKey: "state", valueKey: "amount", maxItems: 10 });
  }, 0);

  return intelPanel("Grant Intelligence", html);
}

function panelBls(d) {
  if (!d || feedHasError(d)) return intelPanel("Workforce Intelligence", dataUnavailable("BLS workforce data unavailable."));
  const w = d.workforce || {};
  const totals = d.totals || {};
  const grants = d.afg_safer_grants_by_state || [];

  const ff = w.firefighters || {};
  const ffWage = w.firefighters_wage || {};
  const ems = w.ems_paramedics || {};

  // BLS API series occasionally fail — show "BLS data unavailable" note instead of zeros
  const blsOk = totals.firefighter_employment != null;
  const stats = `<div class="stat-row">` +
    statCard("Firefighter Jobs", blsOk ? fmtNum(Number(totals.firefighter_employment || 0).toFixed(0)) : "See BLS") +
    statCard("FF Mean Wage", blsOk ? fmtMoney(totals.firefighter_mean_wage_usd || 0) : "See BLS") +
    statCard("EMT/Paramedic Jobs", blsOk ? fmtNum(Number(totals.ems_employment || 0).toFixed(0)) : "See BLS") +
    statCard("States w/ AFG Funding", fmtNum(totals.afg_states_funded || grants.length)) +
    `</div>` +
    (!blsOk ? `<p class="muted small" style="margin:4px 0 8px;">BLS employment data temporarily unavailable — <a href="https://www.bls.gov/oes/current/oes332011.htm" target="_blank">view on BLS.gov</a></p>` : "");

  // Top states by AFG/SAFER funding
  const topStates = grants.slice(0, 10).map(s => [
    escapeHTML(s.state || ""),
    fmtNum(s.total_awards || 0),
    fmtMoney(s.total_amount || 0),
  ]);
  const stateTable = topStates.length ? simpleTable(["State", "Awards", "Total Amount"], topStates) : "";

  // History trend for firefighter employment
  const hist = (ff.history || []).map(h => h.year + ": " + fmtNum(Number(h.value)));
  const histHTML = hist.length ? `<p class="muted small">Employment trend: ${hist.join(" → ")}</p>` : "";

  return intelPanel("Workforce Intelligence",
    stats +
    `<h4 class="intel-subhead">AFG/SAFER Funding by State (FY25+)</h4>${stateTable}` +
    histHTML +
    `<p class="muted small">Sources: BLS OES + USASpending (programs 97.044 AFG, 97.083 SAFER)</p>`);
}

/* =====================================================================
 * RFP / Solicitations Panel (Field Intel sub-panel)
 * ===================================================================== */
const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];
const RFP_CATEGORIES = ["Equipment", "Software/Tech", "Services", "Construction/Facilities"];

let _rfpData = [];

function filterRfpTable() {
  const keyword = ($("#rfp-search")?.value || "").toLowerCase();
  const stateVal = $("#rfp-state-filter")?.value || "";
  const catVal   = $("#rfp-cat-filter")?.value || "";

  const filtered = _rfpData.filter((s) => {
    if (keyword) {
      const haystack = (s.title + " " + s.agency + " " + (s.city || "")).toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (stateVal && s.state !== stateVal) return false;
    if (catVal && s.category !== catVal) return false;
    return true;
  });

  const tbody = $("#rfp-table-body");
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No solicitations match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((s) => {
    const val = s.estimated_value ? fmtMoney(s.estimated_value) : "—";
    const due = s.due_date ? fmtDate(s.due_date) : "—";
    const titleCell = s.url
      ? `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener">${escapeHTML(s.title)}</a>`
      : escapeHTML(s.title);
    return `<tr>
      <td>${titleCell}</td>
      <td>${escapeHTML(s.agency || "—")}</td>
      <td>${escapeHTML(s.state || "—")}</td>
      <td>${escapeHTML(s.category || "—")}</td>
      <td>${val}</td>
      <td>${due}</td>
      <td>${escapeHTML(s.source || "—")}</td>
    </tr>`;
  }).join("");
}

async function renderRfpPanel() {
  const grid = $("#fieldintel-grid");
  if (!grid) return;

  const data = await fetchJSON("rfp_intel.json");

  const stateOptions = US_STATES.map((s) => `<option value="${s}">${s}</option>`).join("");
  const catOptions = RFP_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");

  const filterBar = `
    <div class="rfp-filters" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <input id="rfp-search" type="search" placeholder="Search title or agency…"
        style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:13px;">
      <select id="rfp-state-filter"
        style="padding:6px 8px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:13px;">
        <option value="">All States</option>
        ${stateOptions}
      </select>
      <select id="rfp-cat-filter"
        style="padding:6px 8px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:13px;">
        <option value="">All Categories</option>
        ${catOptions}
      </select>
    </div>`;

  if (!data) {
    const emptyHTML = filterBar +
      `<div class="empty-state">No RFP data yet — pipeline populates this file automatically.</div>`;
    const panelEl = document.createElement("div");
    panelEl.innerHTML = intelPanel(
      "Fire Dept RFPs &amp; Solicitations",
      `<span class="badge" style="margin-left:6px;font-size:11px;background:var(--accent,#e55);color:#fff;padding:2px 7px;border-radius:10px;">Live Procurement</span>${emptyHTML}`
    );
    grid.appendChild(panelEl.firstElementChild);
    return;
  }

  // Combine solicitations (SAM/Grants.gov open opps) + recent awards (USASpending)
  const solicitations = data.solicitations || [];
  const awards = data.recent_awards || [];
  _rfpData = [...solicitations, ...awards];
  const sum = data.summary || {};

  const openCount = solicitations.length;
  const awardsCount = awards.length;
  const totalVal  = sum.total_estimated_value ??
    _rfpData.reduce((acc, s) => acc + (Number(s.estimated_value) || 0), 0);
  const statesRep = sum.states_count ??
    new Set(_rfpData.map((s) => s.state).filter(Boolean)).size;

  const samNote = sum.sam_api_active
    ? ""
    : `<div style="font-size:11px;color:var(--muted,#888);margin-bottom:8px;">` +
      `Live SAM.gov solicitations require a <strong>SAM_API_KEY</strong> secret — ` +
      `showing recent contract awards from USASpending.gov in the meantime.</div>`;

  const kpiStrip = `<div class="stat-row">
    ${statCard("Open Grant Opps", fmtNum(openCount))}
    ${statCard("Recent Awards", fmtNum(awardsCount))}
    ${statCard("Total Value", fmtMoney(totalVal))}
    ${statCard("States", fmtNum(statesRep))}
  </div>` + samNote;

  const tableHTML = `
    <table class="intel-table" style="width:100%;">
      <thead><tr>
        <th>Title</th><th>Agency / City</th><th>State</th>
        <th>Category</th><th>Est. Value</th><th>Due Date</th><th>Source</th>
      </tr></thead>
      <tbody id="rfp-table-body"></tbody>
    </table>`;

  const subtitleBadge = `<span class="badge" style="margin-left:6px;font-size:11px;background:var(--accent,#e55);color:#fff;padding:2px 7px;border-radius:10px;">Live Procurement</span>`;

  const panelEl = document.createElement("div");
  panelEl.innerHTML = intelPanel(
    "Fire Dept RFPs &amp; Solicitations",
    subtitleBadge + kpiStrip + filterBar + tableHTML
  );
  grid.appendChild(panelEl.firstElementChild);

  // Populate table and wire filters
  filterRfpTable();
  $("#rfp-search")?.addEventListener("input", filterRfpTable);
  $("#rfp-state-filter")?.addEventListener("change", filterRfpTable);
  $("#rfp-cat-filter")?.addEventListener("change", filterRfpTable);
}

/* =====================================================================
 * Field Intel lazy loader
 * ===================================================================== */
let _fieldIntelLoaded = false;
function loadFieldIntelLazy() {
  if (_fieldIntelLoaded) return;
  _fieldIntelLoaded = true;
  renderFieldIntel();
}

async function renderFieldIntel() {
  const grid = $("#fieldintel-grid");
  if (!grid) return;
  const [fema, wildfire, ecfr, grants, bls] = await Promise.all([
    fetchJSON("fema_intel.json"),
    fetchJSON("wildfire_intel.json"),
    fetchJSON("ecfr_intel.json"),
    fetchJSON("grants_intel.json"),
    fetchJSON("bls_intel.json"),
  ]);
  grid.innerHTML = panelFema(fema) + panelWildfire(wildfire) + panelEcfr(ecfr) + panelGrants(grants) + panelBls(bls);
  await renderRfpPanel();
}

/* ---- Market Intel panels ---- */
function panelSec(d) {
  if (feedHasError(d)) return intelPanel("Competitor SEC Filings", dataUnavailable("SEC data unavailable."));
  const companies = (d.companies || []).filter((c) => (c.recent_filings || []).length);
  if (!companies.length) return intelPanel("Competitor SEC Filings", dataUnavailable("No recent filings in the last 90 days."));
  const blocks = companies.map((c) => {
    const rows = (c.recent_filings || []).slice(0, 8).map((f) => {
      const maBadge = f.is_ma_signal ? ` <span class="badge--ma">M&amp;A</span>` : "";
      return `<li><span class="chip">${escapeHTML(f.form)}</span> ` +
        `<a href="${escapeHTML(f.url)}" target="_blank" rel="noopener">${escapeHTML(f.description || f.form)}</a> ` +
        `<span class="muted small">${fmtDate(f.date)}</span>${maBadge}</li>`;
    }).join("");
    return `<div class="sec-company"><div class="sec-company__name">${escapeHTML(c.name)} ` +
      `<span class="muted small">(${fmtNum(c.filing_count_90d || (c.recent_filings || []).length)} in 90d)</span></div>` +
      `<ul class="intel-list">${rows}</ul></div>`;
  }).join("");
  return intelPanel("Competitor SEC Filings", blocks);
}

function panelPatents(d) {
  if (feedHasError(d)) return intelPanel("Patent Landscape", dataUnavailable("Patent data unavailable."));
  const stats = `<div class="stat-row">` +
    statCard("Patents (180d)", fmtNum(d.total_patents || 0)) +
    statCard("Top Assignees", fmtNum((d.top_assignees || []).length)) +
    statCard("Competitor Patents", fmtNum((d.competitor_patents || []).reduce((n, c) => n + (c.patents || []).length, 0))) +
    `</div>`;

  const chartId = "patent-assignee-chart";
  const assignees = (d.top_assignees || []).slice(0, 10);
  const chartHTML = assignees.length ? `<div id="${chartId}" class="vbar"></div>` : "";

  const compRows = [];
  for (const c of (d.competitor_patents || [])) {
    for (const p of (c.patents || []).slice(0, 5)) {
      compRows.push([
        escapeHTML(c.competitor || ""),
        `<a href="${escapeHTML(p.url)}" target="_blank" rel="noopener">${escapeHTML(p.title || p.number || "")}</a>`,
        fmtDate(p.date),
      ]);
    }
  }
  const compTable = simpleTable(["Competitor", "Patent", "Granted"], compRows.slice(0, 15));

  setTimeout(() => {
    const el = document.getElementById(chartId);
    if (el && assignees.length) renderHBarChart(el, assignees, { labelKey: "name", valueKey: "count", maxItems: 10 });
  }, 0);

  return intelPanel("Patent Landscape",
    stats +
    (chartHTML ? `<h4 class="intel-subhead">Top Assignees</h4>${chartHTML}` : "") +
    `<h4 class="intel-subhead">Recent Competitor Patents</h4>${compTable}`);
}

function panelApps(d) {
  if (feedHasError(d)) return intelPanel("Competitor App Reviews", dataUnavailable("App review data unavailable."));
  const apps = (d.apps || []).filter((a) => (a.reviews || []).length || a.review_count);
  if (!apps.length) return intelPanel("Competitor App Reviews", dataUnavailable("No app reviews collected."));
  const blocks = apps.map((a) => {
    const negFirst = (a.reviews || []).slice().sort((x, y) => (x.rating || 0) - (y.rating || 0)).slice(0, 3);
    const reviews = negFirst.map((r) =>
      `<li>${starRating(r.rating)} <strong>${escapeHTML(r.title || "")}</strong> ` +
      `<span class="muted small">v${escapeHTML(r.version || "?")}</span><br>` +
      `<span class="small">${escapeHTML((r.content || "").slice(0, 220))}</span></li>`
    ).join("");
    return `<div class="app-block"><div class="app-block__head">` +
      `<span class="app-block__name">${escapeHTML(a.name)}</span> ${starRating(a.avg_rating)} ` +
      `<span class="muted small">${fmtNum(a.review_count || 0)} reviews</span></div>` +
      `<ul class="intel-list">${reviews || dataUnavailable("No reviews.")}</ul></div>`;
  }).join("");
  return intelPanel("Competitor App Reviews", blocks);
}

function panelGdelt(d) {
  if (feedHasError(d)) return intelPanel("Trade Press Coverage", dataUnavailable("Trade press data unavailable."));
  const stats = `<div class="stat-row">` +
    statCard("Articles (7d)", fmtNum(d.total_articles || (d.articles || []).length)) +
    statCard("Source Domains", fmtNum((d.top_domains || []).length)) +
    statCard("Queries Run", fmtNum((d.queries_run || []).length)) +
    `</div>`;

  const chartId = "gdelt-domain-chart";
  const domains = (d.top_domains || []).slice(0, 10);
  const chartHTML = domains.length ? `<div id="${chartId}" class="vbar"></div>` : "";

  const arts = (d.articles || []).slice(0, 15).map((a) =>
    `<li><a href="${escapeHTML(a.url)}" target="_blank" rel="noopener">${escapeHTML(a.title || a.url)}</a> ` +
    `<span class="chip">${escapeHTML(a.domain || "")}</span> ` +
    `<span class="muted small">${fmtDate(a.published_at)}</span></li>`
  ).join("");
  const artHTML = arts ? `<ul class="intel-list">${arts}</ul>` : dataUnavailable("No articles.");

  setTimeout(() => {
    const el = document.getElementById(chartId);
    if (el && domains.length) renderHBarChart(el, domains, { labelKey: "domain", valueKey: "count", maxItems: 10 });
  }, 0);

  return intelPanel("Trade Press Coverage",
    stats +
    (chartHTML ? `<h4 class="intel-subhead">Top Source Domains</h4>${chartHTML}` : "") +
    `<h4 class="intel-subhead">Recent Articles</h4>${artHTML}`);
}

/* ============================================================
   INCIDENT COMMAND INTEL TAB
   ============================================================ */
let _icmdLoaded = false;
function loadIcmdLazy() {
  if (_icmdLoaded) return;
  _icmdLoaded = true;
  renderIcmd();
}

// Static gap map data derived from Sept-2026 VOC research brief
const ICMD_GAP_MAP = [
  { capability: "Unified ICS board + live CAD feed",      current: "Manual whiteboard or siloed app",                     gap: "Auto-updating ICS org chart fed by CAD with crew IDs, time-on-task, air status" },
  { capability: "Cross-agency common operating picture",  current: "Doesn't exist at scene level",                        gap: "Shared map-based COP visible to all agencies regardless of CAD vendor" },
  { capability: "Data channel for routine status",        current: "Everything goes over voice radio",                    gap: "Push notifications for assignments, acknowledgments, status changes — voice for urgent only" },
  { capability: "Integrated fire + EMS command",          current: "Parallel structures, no shared view",                  gap: "Unified command interface where fire IC and EMS medical commander see the same picture" },
  { capability: "Personnel accountability (PAR)",         current: "Manual passport/tag systems, error-prone",             gap: "Automated crew check-in with IDLH entry/exit timestamps, air time tracking, auto PAR alerts" },
  { capability: "Pre-plan integrated with live incident", current: "Pre-plans are static PDFs",                           gap: "Tap building on map → floor plan, hazmat, hydrants, access points in incident context" },
  { capability: "Multi-agency resource request tracking", current: "Phone calls, manual re-entry",                        gap: "Mutual aid request flows into both agencies' command views automatically" },
  { capability: "Medical triage status visible to IC",    current: "Verbal radio from medical sector",                    gap: "IC sees patient count, acuity, transport status alongside fire resource assignments" },
  { capability: "Post-incident data for learning",        current: "Separate AAR process, often skipped",                 gap: "Incident timeline auto-captures assignments, PAR times, radio events → exports for AAR" },
];

// Static research brief sections
const ICMD_BRIEF_SECTIONS = [
  { heading: "The Core Dysfunction", body: "NIOSH has tracked the same top causal factors in firefighter LODDs since 2011 without meaningful change: improper risk assessment, lack of effective incident command, lack of accountability, inadequate communications, and failure to follow SOPs. These aren't training failures — they're system failures. The tools don't support the work." },
  { heading: "The Whiteboard Is Still Running Incident Command", body: "The dominant incident command 'tool' at most agencies remains a whiteboard, a marker, and a radio. At multi-alarm scale this breaks entirely. The $31.5M LODD verdict (2026) turned on a missing safety officer assignment and an IC who never established a fixed command post — both NFPA 1561 violations that would have been detectable by software." },
  { heading: "Span of Control Collapses at Scale", body: "At 25+ units, the 'tactical gap' between IC and task-level crews becomes uncrossable by radio alone. The Gabriel House AAR (2025) documented 33 firefighters on scene within 15 minutes managing simultaneous fire suppression, ladder rescues, interior rescues, medical ops, and accountability — with no dedicated command aide. Command collapsed under cognitive load." },
  { heading: "CAD and MDT Are Dispatch Tools, Not Command Tools", body: "MDTs were built for the communications center, not the fireground. At mutual-aid incidents, two CAD systems create two versions of truth — mismatched unit names, status codes that don't translate, and silent integration failures after config changes. The MDT shows dispatch data, not the ICS org chart." },
  { heading: "Fire and EMS Command Are Fragmented", body: "ePCR systems are used for post-incident documentation, not real-time command. Patient care records reach ER physicians for fewer than 50% of EMS patients. At the 2025 Sanxia MCI, multiple EMS units initiated patient contact before a formal triage officer was established — the fireground freelancing problem, applied to medical." },
  { heading: "AI Adoption Is Stalled by Infrastructure", body: "CPSE survey (Sept 2025): 83% of fire chiefs have AI concerns, only 14% have a formal AI policy, only 40% have access to any AI tools. The blocker is data integration with existing CAD/RMS — not skepticism. Departments want AI-compatible infrastructure, not another standalone product." },
  { heading: "The Strategic Gap", body: "No platform has solved the integration problem at the command level. Every vendor solves a slice: CAD (dispatch), RMS (records), ePCR (patient care), pre-plans (prevention). None have built the incident command layer — the real-time operational view integrating crew status, tactical assignments, resource requests, building intelligence, and medical command into a single interface that works when radio is saturated and the whiteboard is full." },
];

async function renderIcmd() {
  // Pull live VOC signals from cards.json filtered to IC category
  let cards = [];
  try {
    const data = await fetchJSON("cards.json");
    cards = (data || []).filter(c =>
      (c.voc_category || "").toLowerCase().includes("incident command") ||
      (c.voc_category || "").toLowerCase().includes("communication & coordination")
    );
  } catch (e) { /* non-fatal */ }

  _renderIcmdKpi(cards);
  _renderIcmdPainBars(cards);
  _renderIcmdSentiment(cards);
  _renderIcmdGapMap();
  _renderIcmdBrief();
  _renderIcmdSignals(cards);

  // Wire up filters
  const personaSel = document.getElementById("icmd-persona-filter");
  const stageSel   = document.getElementById("icmd-stage-filter");
  const refilter = () => _renderIcmdSignals(cards);
  if (personaSel) personaSel.addEventListener("change", refilter);
  if (stageSel)   stageSel.addEventListener("change",   refilter);
}

function _renderIcmdKpi(cards) {
  const el = document.getElementById("icmd-kpi");
  if (!el) return;
  const total       = cards.length;
  const frustrated  = cards.filter(c => (c.sentiment || "") === "frustrated").length;
  const highConf    = cards.filter(c => (c.confidence || 0) >= 75).length;
  const sources     = new Set(cards.map(c => c.domain || c.source)).size;
  el.innerHTML =
    statCard("IC VOC Signals",    total       || "—") +
    statCard("Frustrated",        frustrated  || "—") +
    statCard("High-Confidence",   highConf    || "—") +
    statCard("Unique Sources",    sources     || "—");
}

function _renderIcmdPainBars(cards) {
  const el = document.getElementById("icmd-pain-bars");
  if (!el) return;
  // Count by sub-category or root_cause
  const counts = {};
  cards.forEach(c => {
    const key = c.voc_subcategory || c.root_cause || "Other";
    counts[key] = (counts[key] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!sorted.length) {
    // Fall back to static known pain clusters from the research brief
    const staticPains = [
      ["Command Accountability / PAR", 32],
      ["CAD / MDT Integration Gap",    28],
      ["Span of Control at Scale",     24],
      ["Radio Saturation",             21],
      ["Cross-Agency COP",             18],
      ["ICS Board → Digital",          15],
      ["Fire + EMS Integration",       13],
      ["AI / Data Adoption Barriers",   9],
    ];
    el.innerHTML = _barChart(staticPains, "(static — sourced from VOC research brief)");
    return;
  }
  el.innerHTML = _barChart(sorted, "");
}

function _barChart(pairs, note) {
  const max = Math.max(...pairs.map(p => p[1]), 1);
  const bars = pairs.map(([label, count]) => {
    const pct = Math.round((count / max) * 100);
    return `<div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
        <span>${escapeHTML(label)}</span><span class="muted">${count}</span>
      </div>
      <div style="background:var(--surface-2,#23272e);border-radius:3px;height:10px;">
        <div style="width:${pct}%;background:var(--accent,#e05a2b);height:10px;border-radius:3px;"></div>
      </div>
    </div>`;
  }).join("");
  return bars + (note ? `<p class="muted small" style="margin-top:8px;">${escapeHTML(note)}</p>` : "");
}

function _renderIcmdSentiment(cards) {
  const el = document.getElementById("icmd-sentiment");
  if (!el) return;
  const counts = { frustrated: 0, neutral: 0, positive: 0 };
  const stages = { Frustration: 0, Evaluation: 0, Awareness: 0, Advocacy: 0 };
  cards.forEach(c => {
    if (c.sentiment && counts[c.sentiment] !== undefined) counts[c.sentiment]++;
    if (c.behavioral_stage && stages[c.behavioral_stage] !== undefined) stages[c.behavioral_stage]++;
  });
  const totalSent  = Object.values(counts).reduce((a,b)=>a+b,0) || 1;
  const totalStage = Object.values(stages).reduce((a,b)=>a+b,0) || 1;

  // If no live data, show static from research
  const useStatic = totalSent <= 1;
  const sentData  = useStatic ? { frustrated: 61, neutral: 25, positive: 14 } : counts;
  const stageData = useStatic ? { Frustration: 58, Evaluation: 27, Awareness: 10, Advocacy: 5 } : stages;
  const stTotal   = Object.values(stageData).reduce((a,b)=>a+b,0);

  const sentColors = { frustrated: "#e05a2b", neutral: "#6b7280", positive: "#22c55e" };
  const stageColors = { Frustration: "#e05a2b", Evaluation: "#f59e0b", Awareness: "#3b82f6", Advocacy: "#22c55e" };

  const sentBars = Object.entries(sentData).map(([k,v]) => {
    const pct = Math.round((v / Object.values(sentData).reduce((a,b)=>a+b,0)) * 100);
    return `<div style="margin-bottom:6px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span style="text-transform:capitalize;">${escapeHTML(k)}</span><span class="muted">${pct}%</span></div>
    <div style="background:var(--surface-2,#23272e);border-radius:3px;height:8px;"><div style="width:${pct}%;background:${sentColors[k]||"#6b7280"};height:8px;border-radius:3px;"></div></div></div>`;
  }).join("");

  const stageBars = Object.entries(stageData).map(([k,v]) => {
    const pct = Math.round((v / stTotal) * 100);
    return `<div style="margin-bottom:6px;"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span>${escapeHTML(k)}</span><span class="muted">${pct}%</span></div>
    <div style="background:var(--surface-2,#23272e);border-radius:3px;height:8px;"><div style="width:${pct}%;background:${stageColors[k]||"#6b7280"};height:8px;border-radius:3px;"></div></div></div>`;
  }).join("");

  el.innerHTML =
    `<h4 style="font-size:12px;font-weight:600;margin:0 0 8px;">Sentiment</h4>${sentBars}` +
    `<h4 style="font-size:12px;font-weight:600;margin:14px 0 8px;">Behavioral Stage</h4>${stageBars}` +
    (useStatic ? `<p class="muted small" style="margin-top:10px;">(static baseline from VOC research — will reflect live pipeline signals as they accumulate)</p>` : "");
}

function _renderIcmdGapMap() {
  const el = document.getElementById("icmd-gap-map");
  if (!el) return;
  const rows = ICMD_GAP_MAP.map(row =>
    `<tr>
      <td style="font-weight:600;font-size:12px;">${escapeHTML(row.capability)}</td>
      <td style="font-size:12px;color:var(--text-muted,#9ca3af);">${escapeHTML(row.current)}</td>
      <td style="font-size:12px;color:var(--accent,#e05a2b);">${escapeHTML(row.gap)}</td>
    </tr>`
  ).join("");
  el.innerHTML =
    `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;font-size:11px;color:var(--text-muted,#9ca3af);border-bottom:1px solid var(--border,#2d3138);">
        <th style="padding:6px 8px 6px 0;width:26%;">Capability</th>
        <th style="padding:6px 8px;width:32%;">Current State</th>
        <th style="padding:6px 0 6px 8px;">What's Missing</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small" style="margin-top:10px;">Sources: Versaterm 2025, Gabriel House AAR 2025, $31.5M LODD verdict (Lexipol 2026), NIOSH LODD data, EMS.gov 2024, CPSE AI Scan Sept 2025, Sanxia MCI Report 2025</p>`;
}

function _renderIcmdBrief() {
  const el = document.getElementById("icmd-brief");
  if (!el) return;
  const sections = ICMD_BRIEF_SECTIONS.map(s =>
    `<div style="margin-bottom:16px;">
      <h4 style="font-size:13px;font-weight:700;margin:0 0 4px;color:var(--text,#f3f4f6);">${escapeHTML(s.heading)}</h4>
      <p style="font-size:13px;line-height:1.6;margin:0;color:var(--text-secondary,#d1d5db);">${escapeHTML(s.body)}</p>
    </div>`
  ).join("");
  el.innerHTML = sections +
    `<p class="muted small" style="margin-top:12px;border-top:1px solid var(--border,#2d3138);padding-top:10px;">
      Synthesized Sept 2026 from: NIOSH LODD data, Gabriel House Fire AAR, Lexipol $31.5M verdict, CPSE AI Strategic Scan, EMS.gov Emerging Digital Tech, MIT Emergency Response research, AIDR/AJEM 2024, Sanxia MCI field report, IAFC iChiefs Fall 2025.
    </p>`;
}

function _renderIcmdSignals(allCards) {
  const grid = document.getElementById("icmd-signals-grid");
  if (!grid) return;
  const personaVal = (document.getElementById("icmd-persona-filter")?.value || "").toLowerCase();
  const stageVal   = (document.getElementById("icmd-stage-filter")?.value  || "").toLowerCase();

  let cards = allCards.filter(c => {
    if (personaVal && !(c.persona || "").toLowerCase().includes(personaVal)) return false;
    if (stageVal   && (c.behavioral_stage || "").toLowerCase() !== stageVal) return false;
    return true;
  });

  if (!cards.length) {
    grid.innerHTML = `<div class="empty-state">No signals match the current filters. Pipeline will populate this as it scrapes IC-tagged sources.</div>`;
    return;
  }

  const sentColor = { frustrated: "#e05a2b", neutral: "#6b7280", positive: "#22c55e" };
  grid.innerHTML = cards.slice(0, 60).map(c => {
    const sc = sentColor[c.sentiment] || "#6b7280";
    const stage = c.behavioral_stage ? `<span class="chip" style="background:rgba(255,255,255,.07);">${escapeHTML(c.behavioral_stage)}</span>` : "";
    const conf  = c.confidence ? `<span class="chip">${escapeHTML(String(c.confidence))}%</span>` : "";
    return `<article class="intel-card">
      <div class="intel-card__meta">
        <span class="intel-card__domain">${escapeHTML(c.domain || c.source || "unknown")}</span>
        <span class="intel-card__date muted">${fmtDate(c.date || c.published_at)}</span>
      </div>
      <div class="intel-card__title">
        ${c.url ? `<a href="${escapeHTML(c.url)}" target="_blank" rel="noopener">${escapeHTML(c.title || "Untitled")}</a>` : escapeHTML(c.title || "Untitled")}
      </div>
      <div class="intel-card__summary">${escapeHTML((c.summary || c.insight || "").slice(0, 220))}</div>
      <div class="intel-card__chips">
        <span class="chip" style="color:${sc};border-color:${sc};">${escapeHTML(c.sentiment || "—")}</span>
        ${stage}${conf}
        ${c.persona ? `<span class="chip">${escapeHTML(c.persona)}</span>` : ""}
      </div>
    </article>`;
  }).join("");
}

let _marketIntelLoaded = false;
function loadMarketIntelLazy() {
  if (_marketIntelLoaded) return;
  _marketIntelLoaded = true;
  renderMarketIntel();
}

async function renderMarketIntel() {
  const grid = $("#marketintel-grid");
  if (!grid) return;
  const [sec, patents, apps, gdelt] = await Promise.all([
    fetchJSON("sec_intel.json"),
    fetchJSON("patent_intel.json"),
    fetchJSON("app_store_intel.json"),
    fetchJSON("gdelt_intel.json"),
  ]);
  grid.innerHTML = panelSec(sec) + panelPatents(patents) + panelApps(apps) + panelGdelt(gdelt);
}

/* ---- Intel badge (cross-source pending count) ---- */
async function loadIntelBadge() {
  const status = await fetchJSON("intel_status.json");
  const badge = $("#fieldintel-badge");
  if (!badge) return;
  const n = status?.pending_count || 0;
  if (n > 0) {
    badge.textContent = fmtNum(n);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

/* =====================================================================
 * NFIRS Data tab — choropleth map, datatables, 3-year trends
 * ===================================================================== */
const NFIRS_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const NFIRS_MAP_METRICS = {
  fire_incidents: "Fire Incidents",
  property_loss_usd: "Property Loss",
  combined_loss_usd: "Combined Loss",
  civilian_deaths: "Civilian Deaths",
  civilian_injuries: "Civilian Injuries",
  firefighter_injuries: "Firefighter Injuries",
};
const NFIRS_LOSS_METRICS = new Set(["property_loss_usd", "combined_loss_usd"]);
const NFIRS_QUINTILE_COLORS = ["#dbeafe", "#93c5fd", "#3b82f6", "#1d4ed8", "#1e3a8a"];
const NFIRS_NODATA = "#374151";

let _nfirsLoaded = false;
const NFIRS = {
  data: null,
  year: "2024",
  mapMetric: "fire_incidents",
  typeSort: { key: "c2024", dir: "desc" },
  stateSort: { key: "closs", dir: "desc" },
  stateFilter: "",
};

/* ---- formatters ---- */
function fmtLoss(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${fmtNum(v)}`;
}
function nfirsChg(v) {
  if (v == null || !isFinite(v)) return `<span class="trend-flat">—</span>`;
  const cls = v > 0 ? "trend-up" : v < 0 ? "trend-down" : "trend-flat";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "—";
  return `<span class="${cls}">${arrow} ${v > 0 ? "+" : ""}${v.toFixed(1)}%</span>`;
}

async function loadNfirs() {
  if (_nfirsLoaded) return;
  _nfirsLoaded = true;
  const root = $("#tab-nfirs");
  const data = await fetchJSON("nfirs_intel.json");
  if (!data || data.error || !data.by_year) {
    const body = $("#nfirs-kpi");
    if (body) body.innerHTML = dataUnavailable("NFIRS data unavailable.");
    return;
  }
  NFIRS.data = data;
  renderNfirs(data);
  wireNfirsControls();
}

function renderNfirs(data) {
  renderNfirsKpi();
  renderNfirsMap();
  renderNfirsTypes();
  renderNfirsTrend();
  renderNfirsDetector();
  renderNfirsAes();
  renderNfirsSpread();
  renderNfirsStateTable();
  renderNfirsInsights();
  renderNfirsFalseAlarmSection();
  renderNerisPanel();
}

/* ---- helpers to pull values ---- */
function nfirsNationalTrend(metric) {
  return (NFIRS.data.national_trends || []).find((t) => t.metric === metric) || {};
}
function nfirsYearTotals(year) {
  if (year !== "all") {
    return ((NFIRS.data.by_year || {})[year] || {}).national_totals || {};
  }
  // "All Years" = sum 2022+2023+2024 for additive fields; latest year for rates
  const years = ["2022", "2023", "2024"];
  const additive = new Set(["total_incidents","total_fire_incidents","civilian_deaths",
    "firefighter_deaths","civilian_injuries","firefighter_injuries"]);
  const sumLoss = new Set(["total_property_loss_usd","total_contents_loss_usd","total_combined_loss_usd"]);
  const merged = {};
  for (const yr of years) {
    const t = ((NFIRS.data.by_year || {})[yr] || {}).national_totals || {};
    for (const [k, v] of Object.entries(t)) {
      if (additive.has(k) || sumLoss.has(k)) merged[k] = (merged[k] || 0) + (Number(v) || 0);
      else if (!(k in merged)) merged[k] = v; // keep first for non-summable fields
    }
  }
  return merged;
}

/* ---- Section 1: KPI strip ---- */
function renderNfirsKpi() {
  const el = $("#nfirs-kpi");
  if (!el) return;
  const year = NFIRS.year;
  const totals = nfirsYearTotals(year);
  const showTrend = true; // always show 3yr trend badge
  // metric: [label, totals key, isLoss, badBgisUp]
  const cards = [
    ["Total Incidents", "total_incidents", false],
    ["Fire Incidents", "total_fire_incidents", false],
    ["Property Loss", "total_property_loss_usd", true],
    ["Contents Loss", "total_contents_loss_usd", true],
    ["Combined Loss", "total_combined_loss_usd", true],
    ["Civ Deaths", "civilian_deaths", false],
    ["FF Deaths", "firefighter_deaths", false],
    ["Civ Injuries", "civilian_injuries", false],
    ["FF Injuries", "firefighter_injuries", false],
  ];
  // For "bad-when-rising" metrics (losses, deaths, injuries) an upward 3yr trend is red.
  const badWhenUp = new Set([
    "total_property_loss_usd", "total_contents_loss_usd", "total_combined_loss_usd",
    "civilian_deaths", "firefighter_deaths", "civilian_injuries", "firefighter_injuries",
  ]);
  el.innerHTML = cards.map(([label, key, isLoss]) => {
    const val = totals[key] || 0;
    const valStr = isLoss ? fmtLoss(val) : fmtNum(val);
    const trend = nfirsNationalTrend(key);
    const chg = trend.chg_22_24;
    let badge = "";
    if (showTrend && chg != null && isFinite(chg)) {
      const up = chg > 0;
      const bad = badWhenUp.has(key);
      let cls = "flat";
      if (chg !== 0) cls = up ? (bad ? "up-bad" : "up-good") : (bad ? "down-good" : "down-bad");
      const arrow = chg > 0 ? "↑" : chg < 0 ? "↓" : "→";
      badge = `<span class="nfirs-trend-badge ${cls}">${arrow} ${chg > 0 ? "+" : ""}${chg.toFixed(1)}% '22→'24</span>`;
    }
    return `<div class="stat-card"><div class="stat-card__num">${escapeHTML(valStr)}</div>` +
      `<div class="stat-card__label">${escapeHTML(label)}</div>${badge}</div>`;
  }).join("");
}

/* ---- Section 2: Choropleth map ---- */
function nfirsStateMetricValue(st, metric, year) {
  const y = year === "all" ? "2024" : year;
  const sd = (NFIRS.data.state_trends || {})[st] || {};
  const yr = sd[y] || {};
  // False alarm metrics — only return real state-level data; no national proxy
  if (metric === "false_alarms" || metric === "false_alarm_pct") {
    const fa = Number(yr["false_alarms"]) || 0;
    const faPct = Number(yr["false_alarm_pct"]) || 0;
    if (metric === "false_alarms") return fa;
    if (metric === "false_alarm_pct") return faPct;
  }
  return Number(yr[metric]) || 0;
}

function nfirsQuintiles(values) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [0, 0, 0, 0];
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return [q(0.2), q(0.4), q(0.6), q(0.8)];
}

function nfirsColorFor(value, breaks) {
  if (value <= 0) return NFIRS_NODATA;
  for (let i = 0; i < breaks.length; i++) {
    if (value <= breaks[i]) return NFIRS_QUINTILE_COLORS[i];
  }
  return NFIRS_QUINTILE_COLORS[4];
}

function renderNfirsMap() {
  const svg = $("#nfirs-map");
  if (!svg) return;
  const metric = NFIRS.mapMetric;
  const year = NFIRS.year;
  const paths = $$(".nfirs-state", svg);
  const values = paths.map((p) => nfirsStateMetricValue(p.dataset.state, metric, year));
  const breaks = nfirsQuintiles(values);
  paths.forEach((p) => {
    const v = nfirsStateMetricValue(p.dataset.state, metric, year);
    p.style.fill = nfirsColorFor(v, breaks);
  });
  // year label
  const yl = $("#nfirs-map-year-label");
  if (yl) yl.textContent = `Year: ${year === "all" ? "2024" : year}`;
  renderNfirsMapLegend(breaks, metric);
}

function renderNfirsMapLegend(breaks, metric) {
  const el = $("#nfirs-map-legend");
  if (!el) return;
  const isLoss = NFIRS_LOSS_METRICS.has(metric);
  const fmt = (n) => isLoss ? fmtLoss(n) : fmtNum(n);
  const ranges = [
    `0–${fmt(breaks[0])}`,
    `${fmt(breaks[0])}–${fmt(breaks[1])}`,
    `${fmt(breaks[1])}–${fmt(breaks[2])}`,
    `${fmt(breaks[2])}–${fmt(breaks[3])}`,
    `≥${fmt(breaks[3])}`,
  ];
  let html = NFIRS_QUINTILE_COLORS.map((c, i) =>
    `<span class="map-legend-item"><span class="map-legend-swatch" style="background:${c}"></span>${escapeHTML(ranges[i])}</span>`
  ).join("");
  html += `<span class="map-legend-item"><span class="map-legend-swatch" style="background:${NFIRS_NODATA}"></span>No data</span>`;
  el.innerHTML = html;
}

function nfirsMapTooltipHTML(st) {
  const year = NFIRS.year === "all" ? "2024" : NFIRS.year;
  const sd = (NFIRS.data.state_trends || {})[st] || {};
  const yr = sd[year] || {};
  const faCount = nfirsStateMetricValue(st, "false_alarms", year);
  const faPct = nfirsStateMetricValue(st, "false_alarm_pct", year);
  const rows = [
    ["Fire Incidents", fmtNum(yr.fire_incidents || 0)],
    ["Property Loss", fmtLoss(yr.property_loss_usd || 0)],
    ["Combined Loss", fmtLoss(yr.combined_loss_usd || 0)],
    ["Civ Deaths", fmtNum(yr.civilian_deaths || 0)],
    ["Civ Injuries", fmtNum(yr.civilian_injuries || 0)],
    ["FF Injuries", fmtNum(yr.firefighter_injuries || 0)],
    ["Est. False Alarms", faCount ? fmtNum(faCount) : "—"],
    ["False Alarm %", faPct ? faPct.toFixed(1) + "%" : "—"],
  ];
  return `<div class="map-tooltip__name">${escapeHTML(NFIRS_STATE_NAMES[st] || st)} (${escapeHTML(year)})</div>` +
    rows.map(([l, v]) => `<div class="map-tooltip__row"><span>${escapeHTML(l)}</span><span>${escapeHTML(v)}</span></div>`).join("");
}

function wireNfirsMapInteractions() {
  const svg = $("#nfirs-map");
  const tip = $("#nfirs-map-tooltip");
  if (!svg || !tip) return;
  $$(".nfirs-state", svg).forEach((p) => {
    p.addEventListener("mouseenter", () => {
      tip.innerHTML = nfirsMapTooltipHTML(p.dataset.state);
      tip.hidden = false;
    });
    p.addEventListener("mousemove", (e) => {
      tip.style.left = (e.pageX + 16) + "px";
      tip.style.top = (e.pageY + 16) + "px";
    });
    p.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

/* ---- Section 3a: Incident types table ---- */
function nfirsTypeRows() {
  const t22 = indexBy((NFIRS.data.by_year["2022"] || {}).top_incident_types || []);
  const t23 = indexBy((NFIRS.data.by_year["2023"] || {}).top_incident_types || []);
  const t24 = (NFIRS.data.by_year["2024"] || {}).top_incident_types || [];
  return t24.map((row) => {
    const code = row.code;
    const c2022 = (t22[code] || {}).count || 0;
    const c2023 = (t23[code] || {}).count || 0;
    const c2024 = row.count || 0;
    return {
      code,
      description: row.description || code,
      c2022, c2023, c2024,
      chg: c2022 ? ((c2024 - c2022) / c2022) * 100 : null,
      ploss: row.property_loss_usd || 0,
      deaths: row.civilian_deaths || 0,
    };
  });
}
function indexBy(arr) {
  const o = {};
  for (const r of arr) o[r.code] = r;
  return o;
}

function renderNfirsTypes() {
  const body = $("#nfirs-types-body");
  if (!body) return;
  let rows = nfirsTypeRows();
  const { key, dir } = NFIRS.typeSort;
  rows.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === "code" || key === "description") {
      av = String(av); bv = String(bv);
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv;
    return dir === "asc" ? av - bv : bv - av;
  });
  body.innerHTML = rows.map((r) => {
    const cls = r.code === "111" ? ' class="structure-fire"' : "";
    return `<tr${cls}><td>${escapeHTML(r.code)}</td><td>${escapeHTML(r.description)}</td>` +
      `<td class="num">${fmtNum(r.c2022)}</td><td class="num">${fmtNum(r.c2023)}</td>` +
      `<td class="num">${fmtNum(r.c2024)}</td><td class="num">${nfirsChg(r.chg)}</td>` +
      `<td class="num">${fmtLoss(r.ploss)}</td><td class="num">${fmtNum(r.deaths)}</td></tr>`;
  }).join("");
  markNfirsSortHeader("#nfirs-types-table", NFIRS.typeSort);
}

/* ---- Section 3b: 3-year trend line chart ---- */
function renderNfirsTrend() {
  const el = $("#nfirs-trend-chart");
  const legend = $("#nfirs-trend-legend");
  if (!el) return;
  const series = [
    { key: "total_fire_incidents", label: "Fire Incidents", color: "#4aa3ff" },
    { key: "total_property_loss_usd", label: "Property Loss", color: "#f0a500" },
    { key: "total_combined_loss_usd", label: "Combined Loss", color: "#e05c5c" },
  ];
  const years = ["2022", "2023", "2024"];
  const W = 440, H = 220, padL = 36, padR = 12, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / (years.length - 1);
  const y = (pct) => padT + plotH * (1 - pct / 100);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="3-year national trend">`;
  // y gridlines/labels 0-100
  for (let p = 0; p <= 100; p += 25) {
    svg += `<line x1="${padL}" y1="${y(p)}" x2="${W - padR}" y2="${y(p)}" stroke="#1f2937" stroke-width="1"/>`;
    svg += `<text class="nfirs-axis-label" x="${padL - 6}" y="${y(p) + 3}" text-anchor="end">${p}%</text>`;
  }
  years.forEach((yr, i) => {
    svg += `<text class="nfirs-axis-label" x="${x(i)}" y="${H - 8}" text-anchor="middle">${yr}</text>`;
  });
  series.forEach((s) => {
    const tr = nfirsNationalTrend(s.key);
    const vals = years.map((yr) => Number(tr[yr]) || 0);
    const max = Math.max(...vals) || 1;
    const norm = vals.map((v) => (v / max) * 100);
    const pts = norm.map((p, i) => `${x(i)},${y(p)}`).join(" ");
    svg += `<polyline class="nfirs-trend-line" points="${pts}" stroke="${s.color}"/>`;
    norm.forEach((p, i) => {
      svg += `<circle class="nfirs-trend-dot" cx="${x(i)}" cy="${y(p)}" r="4" fill="${s.color}">` +
        `<title>${s.label} ${years[i]}: ${NFIRS_LOSS_METRICS.has(s.key) ? fmtLoss(vals[i]) : fmtNum(vals[i])}</title></circle>`;
    });
  });
  svg += `</svg>`;
  el.innerHTML = svg;
  if (legend) {
    legend.innerHTML = series.map((s) =>
      `<span class="nfirs-legend-item"><span class="nfirs-legend-swatch" style="background:${s.color}"></span>${escapeHTML(s.label)}</span>`
    ).join("");
  }
}

/* ---- Section 4: grouped horizontal bars (detector / AES) ---- */
const NFIRS_YEAR_COLORS = { "2022": "#93c5fd", "2023": "#3b82f6", "2024": "#1e40af" };
const NFIRS_DETECTOR_LABELS = { "1": "Operated", "2": "Did Not Operate", "N": "None Present", "U": "Unknown" };

function renderNfirsGroupedHbar(elId, breakdownKey, codes, labels) {
  const el = $("#" + elId);
  if (!el) return;
  const years = ["2022", "2023", "2024"];
  // pct values per code per year, from by_year breakdowns
  const pctByYear = {};
  years.forEach((yr) => {
    const arr = ((NFIRS.data.by_year[yr] || {})[breakdownKey]) || [];
    pctByYear[yr] = indexBy(arr);
  });
  let html = "";
  codes.forEach((code) => {
    html += `<div class="nfirs-hbar-group"><div class="nfirs-hbar-group__label">${escapeHTML(labels[code] || code)}</div>`;
    years.forEach((yr) => {
      const pct = ((pctByYear[yr][code] || {}).pct) || 0;
      html += `<div class="nfirs-hbar-row"><span class="nfirs-hbar-year">${yr}</span>` +
        `<span class="nfirs-hbar-track"><span class="nfirs-hbar-fill" style="width:${Math.min(100, pct)}%;background:${NFIRS_YEAR_COLORS[yr]}"></span></span>` +
        `<span class="nfirs-hbar-val">${pct.toFixed(1)}%</span></div>`;
    });
    html += `</div>`;
  });
  el.innerHTML = html;
}

function nfirsBreakdownPct(year, breakdownKey, code) {
  const arr = ((NFIRS.data.by_year[year] || {})[breakdownKey]) || [];
  const row = arr.find((r) => r.code === code);
  return row ? (row.pct || 0) : 0;
}

function renderNfirsDetector() {
  renderNfirsGroupedHbar("nfirs-detector-chart", "smoke_detector_breakdown",
    ["1", "2", "N", "U"], NFIRS_DETECTOR_LABELS);
  const el = $("#nfirs-detector-insight");
  if (el) {
    const none = nfirsBreakdownPct("2024", "smoke_detector_breakdown", "N");
    const unk = nfirsBreakdownPct("2024", "smoke_detector_breakdown", "U");
    el.innerHTML = `<strong>${(none + unk).toFixed(1)}%</strong> of fires had no smoke detector or unknown status in 2024.`;
  }
}

function renderNfirsAes() {
  renderNfirsGroupedHbar("nfirs-aes-chart", "suppression_system_breakdown",
    ["1", "2", "N", "U"], NFIRS_DETECTOR_LABELS);
  const el = $("#nfirs-aes-insight");
  if (el) {
    const operated = nfirsBreakdownPct("2024", "suppression_system_breakdown", "1");
    el.innerHTML = `Only <strong>${operated.toFixed(1)}%</strong> had a suppression system that operated in 2024.`;
  }
}

/* ---- Section 4c: fire spread grouped vertical bars ---- */
const NFIRS_SPREAD_LABELS = {
  "1": "Confined to Object", "2": "Confined to Room", "3": "Confined to Floor",
  "4": "Confined to Building", "5": "Beyond Structure",
};
const NFIRS_SPREAD_COLORS = { "1": "#2ecc71", "2": "#a3d977", "3": "#f0c000", "4": "#f08a00", "5": "#e05c5c" };

function renderNfirsSpread() {
  const el = $("#nfirs-spread-chart");
  if (!el) return;
  const years = ["2022", "2023", "2024"];
  const codes = ["1", "2", "3", "4", "5"];
  const byYear = {};
  years.forEach((yr) => { byYear[yr] = indexBy(((NFIRS.data.by_year[yr] || {}).fire_spread_breakdown) || []); });
  // max pct across all for scaling
  let maxPct = 0;
  codes.forEach((c) => years.forEach((yr) => { maxPct = Math.max(maxPct, (byYear[yr][c] || {}).pct || 0); }));
  maxPct = maxPct || 1;
  let html = `<div class="nfirs-vbar-wrap">`;
  codes.forEach((code) => {
    html += `<div class="nfirs-vbar-group"><div class="nfirs-vbar-bars">`;
    years.forEach((yr) => {
      const pct = (byYear[yr][code] || {}).pct || 0;
      const h = (pct / maxPct) * 100;
      html += `<span class="nfirs-vbar-fill" style="height:${h}%;background:${NFIRS_SPREAD_COLORS[code]};opacity:${yr === "2024" ? 1 : yr === "2023" ? 0.75 : 0.5}" title="${NFIRS_SPREAD_LABELS[code]} ${yr}: ${pct.toFixed(1)}%"></span>`;
    });
    html += `</div><div class="nfirs-vbar-label">${escapeHTML(NFIRS_SPREAD_LABELS[code])}</div></div>`;
  });
  html += `</div>`;
  el.innerHTML = html;
  const ins = $("#nfirs-spread-insight");
  if (ins) {
    const p22 = (byYear["2022"]["5"] || {}).pct || 0;
    const p24 = (byYear["2024"]["5"] || {}).pct || 0;
    const dir = p24 > p22 ? "increased" : p24 < p22 ? "decreased" : "held steady";
    ins.innerHTML = `"Beyond structure" fires ${dir} from <strong>${p22.toFixed(1)}%</strong> (2022) to <strong>${p24.toFixed(1)}%</strong> (2024).`;
  }
}

/* ---- Section 5: state datatable ---- */
function nfirsStateRows() {
  const out = [];
  const st = NFIRS.data.state_trends || {};
  for (const [code, sd] of Object.entries(st)) {
    if (!NFIRS_STATE_NAMES[code]) continue; // only 50 states + DC
    const y22 = sd["2022"] || {}, y23 = sd["2023"] || {}, y24 = sd["2024"] || {};
    const i2022 = y22.incidents || 0, i2024 = y24.incidents || 0;
    out.push({
      state: code,
      name: NFIRS_STATE_NAMES[code],
      i2022, i2023: y23.incidents || 0, i2024,
      chg: i2022 ? ((i2024 - i2022) / i2022) * 100 : null,
      fire: y24.fire_incidents || 0,
      ploss: y24.property_loss_usd || 0,
      closs: y24.combined_loss_usd || 0,
      cdeath: y24.civilian_deaths || 0,
      ffinj: y24.firefighter_injuries || 0,
    });
  }
  return out;
}

function renderNfirsStateTable() {
  const body = $("#nfirs-state-body");
  if (!body) return;
  let rows = nfirsStateRows();
  const f = NFIRS.stateFilter.trim().toLowerCase();
  if (f) rows = rows.filter((r) => r.state.toLowerCase().includes(f) || r.name.toLowerCase().includes(f));
  const { key, dir } = NFIRS.stateSort;
  rows.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === "state") {
      return dir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    }
    av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv;
    return dir === "asc" ? av - bv : bv - av;
  });
  body.innerHTML = rows.map((r) =>
    `<tr data-state="${escapeHTML(r.state)}"><td>${escapeHTML(r.name)} <span class="muted small">${escapeHTML(r.state)}</span></td>` +
    `<td class="num">${fmtNum(r.i2022)}</td><td class="num">${fmtNum(r.i2023)}</td><td class="num">${fmtNum(r.i2024)}</td>` +
    `<td class="num">${nfirsChg(r.chg)}</td><td class="num">${fmtNum(r.fire)}</td>` +
    `<td class="num">${fmtLoss(r.ploss)}</td><td class="num">${fmtLoss(r.closs)}</td>` +
    `<td class="num">${fmtNum(r.cdeath)}</td><td class="num">${fmtNum(r.ffinj)}</td></tr>`
  ).join("");
  markNfirsSortHeader("#nfirs-state-table", NFIRS.stateSort);
  // row click → highlight map + scroll
  $$("#nfirs-state-body tr").forEach((tr) => {
    tr.addEventListener("click", () => nfirsHighlightState(tr.dataset.state, tr));
  });
}

function nfirsHighlightState(st, rowEl) {
  $$(".nfirs-state").forEach((p) => p.classList.toggle("highlighted", p.dataset.state === st));
  $$("#nfirs-state-body tr").forEach((r) => r.classList.toggle("highlighted-row", r === rowEl));
  const map = $("#nfirs-map");
  if (map) map.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---- Section 6: key insights ---- */
function renderNfirsInsights() {
  const el = $("#nfirs-insight-grid");
  if (!el) return;
  const combinedTr = nfirsNationalTrend("total_combined_loss_usd");
  const fireTr = nfirsNationalTrend("total_fire_incidents");
  const ffInjTr = nfirsNationalTrend("firefighter_injuries");
  const none = nfirsBreakdownPct("2024", "smoke_detector_breakdown", "N");
  const unk = nfirsBreakdownPct("2024", "smoke_detector_breakdown", "U");
  // highest combined loss state 2024
  let topState = null, topVal = -1;
  for (const r of nfirsStateRows()) {
    if (r.closs > topVal) { topVal = r.closs; topState = r; }
  }
  const cards = [
    {
      title: "Losses Up Despite Fewer Fires",
      big: `${combinedTr.chg_22_24 > 0 ? "+" : ""}${(combinedTr.chg_22_24 || 0).toFixed(1)}%`,
      sub: `Combined loss vs ${(fireTr.chg_22_24 || 0).toFixed(1)}% fire incidents, 2022→2024`,
    },
    {
      title: "Firefighter Injury Surge",
      big: `${(ffInjTr.chg_22_24 || 0) > 0 ? "+" : ""}${(ffInjTr.chg_22_24 || 0).toFixed(1)}%`,
      sub: "Firefighter injuries, 2022→2024",
    },
    {
      title: "Smoke Detector Gap",
      big: `${(none + unk).toFixed(1)}%`,
      sub: "of 2024 fires had no detector or unknown status",
    },
    {
      title: "Highest Risk State",
      big: topState ? escapeHTML(topState.name) : "—",
      sub: topState ? `${fmtLoss(topState.closs)} combined loss in 2024` : "",
    },
  ];
  el.innerHTML = cards.map((c) =>
    `<div class="nfirs-insight-card"><div class="nfirs-insight-card__title">${escapeHTML(c.title)}</div>` +
    `<div class="nfirs-insight-card__big">${c.big}</div>` +
    `<div class="nfirs-insight-card__sub">${c.sub}</div></div>`
  ).join("");
}

/* ---- sort header marking ---- */
function markNfirsSortHeader(tableSel, sortState) {
  $$(`${tableSel} thead th`).forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === sortState.key) {
      th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

/* ---- controls wiring ---- */
function wireNfirsControls() {
  // year toggle
  $$("#nfirs-year-toggle .nfirs-year-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#nfirs-year-toggle .nfirs-year-btn").forEach((b) => b.classList.toggle("active", b === btn));
      NFIRS.year = btn.dataset.year;
      renderNfirsKpi();
      renderNfirsMap();
      renderNfirsFalseAlarmKpi();
      renderNfirsFalseAlarmChart();
      renderNfirsFalseAlarmTrend();
    });
  });
  // map metric
  const metricSel = $("#nfirs-map-metric");
  if (metricSel) metricSel.addEventListener("change", () => {
    NFIRS.mapMetric = metricSel.value;
    renderNfirsMap();
  });
  // type table sort
  $$("#nfirs-types-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (NFIRS.typeSort.key === k) NFIRS.typeSort.dir = NFIRS.typeSort.dir === "asc" ? "desc" : "asc";
      else NFIRS.typeSort = { key: k, dir: (k === "code" || k === "description") ? "asc" : "desc" };
      renderNfirsTypes();
    });
  });
  // state table sort
  $$("#nfirs-state-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (NFIRS.stateSort.key === k) NFIRS.stateSort.dir = NFIRS.stateSort.dir === "asc" ? "desc" : "asc";
      else NFIRS.stateSort = { key: k, dir: k === "state" ? "asc" : "desc" };
      renderNfirsStateTable();
    });
  });
  // state search
  const search = $("#nfirs-state-search");
  if (search) search.addEventListener("input", () => {
    NFIRS.stateFilter = search.value || "";
    renderNfirsStateTable();
  });
  // map interactions
  wireNfirsMapInteractions();
}


/* =====================================================================
 * NFIRS: False Alarm / False Call section (Section 7)
 * ===================================================================== */

const FA_CODE_COLORS = {
  "710": "#e05c5c",
  "714": "#f87171",
  "720": "#fb923c",
  "721": "#f0a500",
  "722": "#4aa3ff",
  "730": "#a78bfa",
  "740": "#34d399",
};

function nfirsFalseAlarmData(year) {
  const y = year === "all" ? "2024" : year;
  return ((NFIRS.data.by_year || {})[y] || {}).false_alarm_data || null;
}

function renderNfirsFalseAlarmKpi() {
  const el = $("#nfirs-false-alarm-kpi");
  if (!el) return;
  const year = NFIRS.year;
  const fa = nfirsFalseAlarmData(year);
  if (!fa) { el.innerHTML = dataUnavailable("False alarm data unavailable."); return; }
  const cards = [
    { label: "Est. False Alarms (National)", val: fmtNum(fa.false_alarms_est || 0) },
    { label: "Good Intent Calls (National)", val: fmtNum(fa.good_intent_calls_est || 0) },
    { label: "% of All Dept Responses", val: (fa.false_alarm_pct_of_responses || 0).toFixed(1) + "%" },
    { label: "Total Dept Responses", val: fmtNum(fa.total_fire_dept_responses_est || 0) },
    { label: "Est. Economic Impact", val: fmtLoss(fa.economic_impact_est_usd || 0) },
    { label: "Avg Cost / Run", val: "$" + (fa.response_cost_per_run_usd || 0).toLocaleString() },
  ];
  el.innerHTML = cards.map((c) =>
    `<div class="stat-card"><div class="stat-card__num">${escapeHTML(c.val)}</div>` +
    `<div class="stat-card__label">${escapeHTML(c.label)}</div></div>`
  ).join("");
}

function renderNfirsFalseAlarmChart() {
  const el = $("#nfirs-false-alarm-chart");
  if (!el) return;
  const years = ["2022", "2023", "2024"];
  // Gather all codes across years
  const allCodes = new Set();
  years.forEach((yr) => {
    const fa = nfirsFalseAlarmDataByYear(yr);
    (fa ? (fa.by_code_pct || fa.by_code || []) : []).forEach((r) => allCodes.add(r.code));
  });
  const codes = [...allCodes].sort((a, b) => {
    // Sort by 2024 count desc
    const fa = nfirsFalseAlarmDataByYear("2024");
    const aCount = fa ? ((fa.by_code_pct || fa.by_code || []).find((r) => r.code === a) || {}).pct_of_false_alarms || 0 : 0;
    const bCount = fa ? ((fa.by_code_pct || fa.by_code || []).find((r) => r.code === b) || {}).pct_of_false_alarms || 0 : 0;
    return bCount - aCount;
  });
  // Build per-code, per-year pct lookup
  const pcByYearCode = {};
  years.forEach((yr) => {
    const fa = nfirsFalseAlarmDataByYear(yr);
    pcByYearCode[yr] = {};
    (fa ? (fa.by_code_pct || fa.by_code || []) : []).forEach((r) => { pcByYearCode[yr][r.code] = r.pct_of_false_alarms ?? r.pct ?? 0; });
  });

  const FA_CODE_LABELS = {
    "710": "Malicious False Call",
    "711": "Municipal Box, No Emergency",
    "712": "Direct Tie to FD",
    "714": "Central Station Malicious",
    "720": "Unintentional False Alarm",
    "721": "Smoke Detector Malfunction",
    "722": "Sprinkler System Malfunction",
    "730": "System / Detector Malfunction",
    "740": "Unintentional (cooking/steam)",
  };

  let html = "";
  codes.forEach((code) => {
    const color = FA_CODE_COLORS[code] || "#6b7280";
    html += `<div class="nfirs-hbar-group">` +
      `<div class="nfirs-hbar-group__label" style="color:${color}">${escapeHTML(FA_CODE_LABELS[code] || code)} <span class="muted" style="font-size:10px">(${escapeHTML(code)})</span></div>`;
    years.forEach((yr) => {
      const pct = (pcByYearCode[yr][code]) || 0;
      html += `<div class="nfirs-hbar-row"><span class="nfirs-hbar-year">${yr}</span>` +
        `<span class="nfirs-hbar-track"><span class="nfirs-hbar-fill" style="width:${Math.min(100, pct)}%;background:${color};opacity:${yr === "2024" ? 1 : yr === "2023" ? 0.75 : 0.5}"></span></span>` +
        `<span class="nfirs-hbar-val">${pct.toFixed(1)}%</span></div>`;
    });
    html += `</div>`;
  });
  el.innerHTML = html;
}

function nfirsFalseAlarmDataByYear(yr) {
  return ((NFIRS.data.by_year || {})[yr] || {}).false_alarm_data || null;
}

function renderNfirsFalseAlarmTrend() {
  const el = $("#nfirs-false-alarm-trend");
  if (!el) return;
  const years = ["2022", "2023", "2024"];
  const series = [
    { key: "false_alarms_est", label: "False Alarms (Nat. Est.)", color: "#fb923c" },
    { key: "good_intent_calls_est", label: "Good Intent Calls (Nat. Est.)", color: "#a78bfa" },
    { key: "false_alarm_pct_of_responses", label: "% of All Responses", color: "#4aa3ff" },
  ];
  const W = 300, H = 160, padL = 32, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (plotW * i) / (years.length - 1);
  const y = (pct) => padT + plotH * (1 - pct / 100);

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="false-alarm-trend-svg" role="img" aria-label="False alarm 3-year trend">`;
  for (let p = 0; p <= 100; p += 25) {
    svg += `<line x1="${padL}" y1="${y(p)}" x2="${W - padR}" y2="${y(p)}" stroke="#1f2937" stroke-width="1"/>`;
  }
  years.forEach((yr, i) => {
    svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">${yr}</text>`;
  });
  series.forEach((s) => {
    const vals = years.map((yr) => {
      const fa = nfirsFalseAlarmDataByYear(yr);
      return fa ? (fa[s.key] || 0) : 0;
    });
    const max = Math.max(...vals) || 1;
    const norm = vals.map((v) => (v / max) * 100);
    const pts = norm.map((p, i) => `${x(i)},${y(p)}`).join(" ");
    svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    norm.forEach((p, i) => {
      svg += `<circle cx="${x(i)}" cy="${y(p)}" r="4" fill="${s.color}">` +
        `<title>${escapeHTML(s.label)} ${years[i]}: ${escapeHTML(String(vals[i].toLocaleString()))}</title></circle>`;
    });
  });
  svg += `</svg>`;
  svg += `<div class="nfirs-legend" style="margin-top:6px;">` +
    series.map((s) => `<span class="nfirs-legend-item"><span class="nfirs-legend-swatch" style="background:${s.color}"></span>${escapeHTML(s.label)}</span>`).join("") +
    `</div>`;
  el.innerHTML = svg;

  // insight
  const ins = $("#nfirs-false-alarm-insight");
  if (ins) {
    const fa24 = nfirsFalseAlarmDataByYear("2024");
    const fa22 = nfirsFalseAlarmDataByYear("2022");
    if (fa24 && fa22) {
      const chg = ((fa24.false_alarms_est - fa22.false_alarms_est) / fa22.false_alarms_est * 100).toFixed(1);
      const top = (fa24.by_code_pct || []).reduce((a, b) => (b.pct_of_false_alarms > a.pct_of_false_alarms ? b : a), (fa24.by_code_pct || [])[0] || {});
      ins.innerHTML = `Nationally, <strong>${(fa24.false_alarm_pct_of_responses || 7.8).toFixed(1)}%</strong> of all fire dept responses are false alarms ` +
        `(~<strong>${fmtNum(fa24.false_alarms_est)}</strong> est. in 2024 across ~${fmtNum(fa24.total_fire_dept_responses_est)} total calls). ` +
        `Largest driver: <strong>${escapeHTML(top.description || "")}</strong> (${(top.pct_of_false_alarms || 0).toFixed(1)}% of false alarms). ` +
        `Est. economic impact: <strong>${fmtLoss(fa24.economic_impact_est_usd)}</strong>/yr. ` +
        `<span class="muted small">Note: false alarms are reported separately from the fire+hazmat NFIRS PDR dataset.</span>`;
    }
  }
}

function renderNfirsFalseAlarmSection() {
  renderNfirsFalseAlarmKpi();
  renderNfirsFalseAlarmChart();
  renderNfirsFalseAlarmTrend();
}

/* =====================================================================
 * NFIRS: NERIS Transition Panel (Section 8)
 * ===================================================================== */

function renderNerisPanel() {
  const neris = (NFIRS.data || {}).neris;
  if (!neris) return;

  // Status bar
  const sb = $("#neris-status-bar");
  if (sb) {
    const items = [
      { label: "System Status", val: neris.status === "beta_active" ? "LIVE — Beta Active" : neris.status, cls: "live" },
      { label: "Transition Date", val: neris.transition_date || "—", cls: "" },
      { label: "Current Phase", val: neris.phase || "—", cls: "" },
      { label: "API Access", val: "Dept Credentials Required", cls: "warn" },
      { label: "Schemas Released", val: (neris.schemas || []).length + " schemas (May 2024)", cls: "" },
    ];
    sb.innerHTML = items.map((item) =>
      `<div class="neris-status-bar__item">` +
      `<span class="neris-status-bar__label">${escapeHTML(item.label)}</span>` +
      `<span class="neris-status-bar__val ${escapeHTML(item.cls)}">${escapeHTML(item.val)}</span>` +
      `</div>`
    ).join("");
  }

  // Changes list
  const cl = $("#neris-changes-list");
  if (cl) {
    cl.innerHTML = `<ul class="neris-changes-list">` +
      (neris.key_changes_from_nfirs || []).map((c) =>
        `<li>${escapeHTML(c)}</li>`
      ).join("") +
      `</ul>`;
  }

  // False alarm mapping table
  const mb = $("#neris-mapping-body");
  if (mb) {
    mb.innerHTML = (neris.false_alarm_neris_codes || []).map((row) => {
      const color = FA_CODE_COLORS[row.nfirs_equiv] || "#6b7280";
      return `<tr>` +
        `<td><code style="font-size:11px;color:${color}">${escapeHTML(row.neris_code)}</code></td>` +
        `<td class="num">${escapeHTML(row.nfirs_equiv)}</td>` +
        `<td>${escapeHTML(row.description)}</td>` +
        `</tr>`;
    }).join("");
  }

  // Resource links
  const lk = $("#neris-links");
  if (lk && neris.public_resources) {
    const links = [
      { url: neris.public_resources.github_framework, label: "GitHub Framework" },
      { url: neris.public_resources.usfa_page, label: "USFA NERIS Page" },
      { url: neris.public_resources.fsri_api_announcement, label: "API Announcement" },
      { url: neris.public_resources.incident_type_mapping, label: "Incident Type Map" },
    ];
    lk.innerHTML = `<div class="neris-links">` +
      links.filter((l) => l.url).map((l) =>
        `<a href="${escapeHTML(l.url)}" target="_blank" rel="noopener" class="neris-link-btn">` +
        `&#x2197; ${escapeHTML(l.label)}</a>`
      ).join("") +
      `</div>`;
  }
}

/* =====================================================================
 * AI Intel tab
 * ===================================================================== */
let _aiIntelLoaded = false;
const AI_INTEL = {
  data: null,
  companyFilter: "all",
  modelTag: "all",
  modelSort: "downloads",
  paperDateAsc: false,
  paperSearch: "",
};

const AI_COMPANY_COLORS = {
  OpenAI: "#10b981",
  Anthropic: "#f97316",
  Google: "#3b82f6",
  Mistral: "#a855f7",
  HuggingFace: "#eab308",
  Other: "#6b7280",
};

const AI_TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "via",
  "using", "based", "towards", "toward", "from", "by", "is", "are", "as", "at",
  "we", "our", "this", "that", "can", "be", "new", "into", "than",
  "agent", "agents", "agentic", "llm", "llms", "model", "models", "language",
  "large", "ai", "learning", "framework", "system", "systems", "approach",
]);

function aiCompanyKey(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("openai")) return "OpenAI";
  if (n.includes("anthropic")) return "Anthropic";
  if (n.includes("google") || n.includes("deepmind")) return "Google";
  if (n.includes("mistral")) return "Mistral";
  if (n.includes("hugging")) return "HuggingFace";
  return "Other";
}

function aiCompanyDotClass(key) {
  return "company-dot-" + key.toLowerCase();
}

async function loadAiIntel() {
  if (_aiIntelLoaded) return;
  _aiIntelLoaded = true;
  const data = await fetchJSON("agentic_ai_intel.json");
  if (!data || data.error) {
    const strip = $("#ai-stat-strip");
    if (strip) {
      strip.innerHTML = dataUnavailable(
        "AI Intel data unavailable — will populate on next pipeline run"
      );
    }
    return;
  }
  AI_INTEL.data = data;
  renderAiIntel(data);
  wireAiIntelControls();
}

function renderAiIntel(data) {
  renderAiStatStrip(data.summary || {});
  renderAiTimeline();
  renderAiRepos(data.trending_repos || []);
  renderAiPapers();
  renderAiModels();
  renderAiCallouts(data);
}

/* ---- Section 1: command strip ---- */
function renderAiStatStrip(summary) {
  const el = $("#ai-stat-strip");
  if (!el) return;
  const cards = [
    ["New Models (30d)", summary.new_models_30d || 0],
    ["New Papers (30d)", summary.new_papers_30d || 0],
    ["Trending Repos", (AI_INTEL.data.trending_repos || []).length],
    ["Company Releases", (AI_INTEL.data.company_releases || []).length],
  ];
  el.innerHTML = cards.map(([label, val]) =>
    `<div class="stat-card"><div class="stat-card__num">${fmtNum(val)}</div>` +
    `<div class="stat-card__label">${escapeHTML(label)}</div></div>`
  ).join("");
}

/* ---- Section 2a: company release timeline ---- */
function aiTimelineItems() {
  const releases = (AI_INTEL.data.company_releases || []).map((r) => ({
    company: aiCompanyKey(r.company),
    title: r.title,
    url: r.url,
    date: r.date,
    summary: r.summary || "",
  }));
  const news = (AI_INTEL.data.news_articles || []).map((n) => ({
    company: aiCompanyKey(n.source || n.title),
    title: n.title,
    url: n.url,
    date: n.date,
    summary: n.source || "",
  }));
  let items = releases.concat(news);
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (AI_INTEL.companyFilter !== "all") {
    items = items.filter((i) => i.company === AI_INTEL.companyFilter);
  }
  return items.slice(0, 20);
}

function renderAiTimeline() {
  const el = $("#ai-timeline");
  if (!el) return;
  const items = aiTimelineItems();
  if (!items.length) {
    el.innerHTML = dataUnavailable("No releases match this filter.");
    return;
  }
  el.innerHTML = items.map((i) => {
    const dot = aiCompanyDotClass(i.company);
    const link = i.url
      ? `<a href="${escapeHTML(i.url)}" target="_blank" rel="noopener">${escapeHTML(i.title)}</a>`
      : escapeHTML(i.title);
    return (
      `<div class="ai-timeline-item">` +
      `<span class="ai-company-badge ${dot}"></span>` +
      `<div class="ai-timeline-content">` +
      `<div class="ai-timeline-title">${link}</div>` +
      `<div class="ai-timeline-meta">${escapeHTML(i.company)} · ${escapeHTML(i.date || "")}</div>` +
      (i.summary ? `<div class="ai-timeline-summary">${escapeHTML(i.summary)}</div>` : "") +
      `</div></div>`
    );
  }).join("");
}

/* ---- Section 2b: GitHub repos ---- */
function renderAiRepos(repos) {
  const el = $("#ai-repo-grid");
  if (!el) return;
  const sorted = repos.slice().sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 12);
  if (!sorted.length) {
    el.innerHTML = dataUnavailable("No trending repos.");
    return;
  }
  el.innerHTML = sorted.map((r) => {
    const topics = (r.topics || []).slice(0, 5)
      .map((t) => `<span class="topic-chip">${escapeHTML(t)}</span>`).join("");
    return (
      `<div class="repo-card">` +
      `<div class="repo-card__name"><a href="${escapeHTML(r.url)}" target="_blank" rel="noopener">${escapeHTML(r.full_name || r.name)}</a></div>` +
      `<div class="repo-card__desc">${escapeHTML(r.description || "")}</div>` +
      `<div class="repo-card__stats"><span>★ ${fmtNum(r.stars || 0)}</span>` +
      `<span>⑂ ${fmtNum(r.forks || 0)}</span>` +
      `<span>${escapeHTML((r.last_pushed || "").slice(0, 10))}</span></div>` +
      (topics ? `<div class="repo-card__topics">${topics}</div>` : "") +
      `</div>`
    );
  }).join("");
}

/* ---- Section 3: ArXiv papers ---- */
function aiPaperRows() {
  let rows = (AI_INTEL.data.recent_papers || []).slice();
  const q = AI_INTEL.paperSearch.trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      (p.title || "").toLowerCase().includes(q) ||
      (p.authors || []).join(" ").toLowerCase().includes(q)
    );
  }
  rows.sort((a, b) => {
    const cmp = String(a.date).localeCompare(String(b.date));
    return AI_INTEL.paperDateAsc ? cmp : -cmp;
  });
  return rows.slice(0, 25);
}

function renderAiPapers() {
  const body = $("#ai-paper-body");
  if (!body) return;
  const rows = aiPaperRows();
  const th = $("#ai-paper-date-th");
  if (th) th.textContent = "Date " + (AI_INTEL.paperDateAsc ? "▴" : "▾");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5">${dataUnavailable("No papers match.")}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((p, idx) => {
    const authors = (p.authors || []).slice(0, 3).join(", ") +
      ((p.authors || []).length > 3 ? " et al." : "");
    const cats = (p.categories || []).map((c) => `<span class="topic-chip">${escapeHTML(c)}</span>`).join(" ");
    const link = p.url
      ? `<a href="${escapeHTML(p.url)}" target="_blank" rel="noopener">arXiv</a>` : "";
    return (
      `<tr class="ai-paper-row" data-paper="${idx}">` +
      `<td>${escapeHTML(p.title)}</td>` +
      `<td>${escapeHTML(authors)}</td>` +
      `<td>${escapeHTML(p.date || "")}</td>` +
      `<td>${cats}</td>` +
      `<td>${link}</td>` +
      `</tr>` +
      `<tr class="paper-row-abstract" data-abstract="${idx}">` +
      `<td colspan="5">${escapeHTML(p.abstract || "No abstract available.")}</td>` +
      `</tr>`
    );
  }).join("");
  $$(".ai-paper-row", body).forEach((row) => {
    row.addEventListener("click", () => {
      const idx = row.dataset.paper;
      const ab = body.querySelector(`.paper-row-abstract[data-abstract="${idx}"]`);
      if (ab) ab.classList.toggle("open");
    });
  });
}

/* ---- Section 4: HF models ---- */
function aiModelCards() {
  let rows = (AI_INTEL.data.trending_models || []).slice();
  if (AI_INTEL.modelTag !== "all") {
    rows = rows.filter((m) =>
      (m.tags || []).some((t) => String(t).toLowerCase().includes(AI_INTEL.modelTag))
    );
  }
  const sortKey = AI_INTEL.modelSort;
  rows.sort((a, b) => {
    if (sortKey === "recent") {
      return String(b.last_modified).localeCompare(String(a.last_modified));
    }
    return (b[sortKey] || 0) - (a[sortKey] || 0);
  });
  return rows.slice(0, 24);
}

function renderAiModels() {
  const el = $("#ai-model-grid");
  if (!el) return;
  const cards = aiModelCards();
  if (!cards.length) {
    el.innerHTML = dataUnavailable("No models match this filter.");
    return;
  }
  el.innerHTML = cards.map((m) => {
    const tags = (m.tags || []).slice(0, 5)
      .map((t) => `<span class="topic-chip">${escapeHTML(t)}</span>`).join("");
    return (
      `<div class="model-card">` +
      `<div class="model-card__id"><a href="${escapeHTML(m.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${escapeHTML(m.model_id)}</a></div>` +
      `<div class="model-card__author">${escapeHTML(m.author || "")}</div>` +
      `<div class="model-card__stats"><span>↓ ${fmtNum(m.downloads || 0)}</span>` +
      `<span>♥ ${fmtNum(m.likes || 0)}</span>` +
      `<span>${escapeHTML((m.last_modified || "").slice(0, 10))}</span></div>` +
      (tags ? `<div class="model-card__tags">${tags}</div>` : "") +
      `</div>`
    );
  }).join("");
}

/* ---- Section 5: insight callouts ---- */
function aiHottestTopic(papers) {
  const counts = {};
  (papers || []).forEach((p) => {
    (p.title || "").toLowerCase().split(/[^a-z0-9-]+/).forEach((w) => {
      if (w.length < 3 || AI_TITLE_STOPWORDS.has(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : "—";
}

function renderAiCallouts(data) {
  const el = $("#ai-callouts");
  if (!el) return;
  const releases = data.company_releases || [];
  const counts = {};
  releases.forEach((r) => {
    const k = aiCompanyKey(r.company);
    counts[k] = (counts[k] || 0) + 1;
  });
  const activeCompany = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const repos = (data.trending_repos || []).slice().sort((a, b) => (b.stars || 0) - (a.stars || 0));
  const topRepo = repos[0];
  const callouts = [
    ["Most Active Company",
      activeCompany ? `${activeCompany[0]} (${activeCompany[1]} releases / 30d)` : "—"],
    ["Hottest Research Topic", aiHottestTopic(data.recent_papers)],
    ["Most Starred New Repo",
      topRepo ? `${topRepo.name} (★ ${fmtNum(topRepo.stars || 0)})` : "—"],
  ];
  el.innerHTML = callouts.map(([label, val]) =>
    `<div class="ai-callout"><div class="ai-callout__label">${escapeHTML(label)}</div>` +
    `<div class="ai-callout__value">${escapeHTML(val)}</div></div>`
  ).join("");
}

/* ---- controls ---- */
function wireAiIntelControls() {
  const companyBar = $("#ai-company-filter");
  if (companyBar) companyBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".ai-filter-btn");
    if (!btn) return;
    AI_INTEL.companyFilter = btn.dataset.company;
    $$(".ai-filter-btn", companyBar).forEach((b) => b.classList.toggle("active", b === btn));
    renderAiTimeline();
  });

  const modelBar = $("#ai-model-filter");
  if (modelBar) modelBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".ai-filter-btn");
    if (!btn) return;
    AI_INTEL.modelTag = btn.dataset.tag;
    $$(".ai-filter-btn", modelBar).forEach((b) => b.classList.toggle("active", b === btn));
    renderAiModels();
  });

  const sortBar = $("#ai-model-sort");
  if (sortBar) sortBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".ai-filter-btn");
    if (!btn) return;
    AI_INTEL.modelSort = btn.dataset.sort;
    $$(".ai-filter-btn", sortBar).forEach((b) => b.classList.toggle("active", b === btn));
    renderAiModels();
  });

  const dateTh = $("#ai-paper-date-th");
  if (dateTh) dateTh.addEventListener("click", () => {
    AI_INTEL.paperDateAsc = !AI_INTEL.paperDateAsc;
    renderAiPapers();
  });

  const search = $("#ai-paper-search");
  if (search) search.addEventListener("input", debounce(() => {
    AI_INTEL.paperSearch = search.value || "";
    renderAiPapers();
  }, 150));
}

/* =====================================================================
 * Fire Department Map Tab
 * Reads: dept_map_summary.json (always) + dept_map_geojson.json (lazy)
 * Requires Leaflet + MarkerCluster loaded via CDN in <head>
 * ===================================================================== */

let _deptMapLoaded = false;
let _deptMapInstance = null;
let _deptAllFeatures = [];
let _deptFilters = { type: 'all', ems: 'all', state: 'all', personnelMin: 0 };

const DEPT_TYPE_COLOR = {
  career:      '#ef4444',
  volunteer:   '#3b82f6',
  combination: '#a855f7',
  unknown:     '#6b7280',
};

function _deptColor(type) {
  return DEPT_TYPE_COLOR[type] || DEPT_TYPE_COLOR.unknown;
}

function _deptIcon(type, ems) {
  const color = _deptColor(type);
  const inner = ems ? '\u2665' : '\u25cf';
  return L.divIcon({
    className: '',
    html: `<div style="width:10px;height:10px;border-radius:50%;background:${color};border:1.5px solid rgba(0,0,0,0.3);" title="${type}${ems?' (EMS)':''}"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

async function loadDeptMap() {
  if (_deptMapLoaded) return;
  _deptMapLoaded = true;

  const loadingEl = $("#deptmap-loading");
  const kpiEl = $("#deptmap-kpi");
  const resultCountEl = $("#deptmap-result-count");

  // ── Load CDN scripts lazily ──────────────────────────────────────────────
  await _loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  await _loadScript('https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js');

  // ── Load summary (small) ─────────────────────────────────────────────────
  const summary = await fetchJSON('dept_map_summary.json');
  if (!summary || summary.available === false) {
    if (kpiEl) kpiEl.innerHTML = dataUnavailable('Fire department data unavailable — run the pipeline first.');
    return;
  }

  const s = summary.summary || {};
  const stateBreakdown = summary.state_breakdown || [];
  const topCounties = summary.top_counties || [];

  // ── KPI strip ────────────────────────────────────────────────────────────
  if (kpiEl) {
    const tb = s.type_breakdown || {};
    kpiEl.innerHTML = [
      { label: 'Total Stations',   value: (s.total_stations||0).toLocaleString(),    sub: 'HIFLD national dataset' },
      { label: 'Career Stations',  value: (tb.career||0).toLocaleString(),            sub: 'primarily career staffed' },
      { label: 'Volunteer',        value: (tb.volunteer||0).toLocaleString(),         sub: 'volunteer departments' },
      { label: 'EMS Capable',      value: (s.ems_capable||0).toLocaleString(),        sub: `${((s.ems_capable||0)/(s.total_stations||1)*100).toFixed(0)}% of stations` },
      { label: 'Total Personnel',  value: (s.total_personnel||0).toLocaleString(),   sub: 'firefighters reported' },
      { label: 'USFA Depts',       value: (s.total_usfa_depts||0).toLocaleString(),  sub: 'registry records' },
    ].map(k => `<div class="stat-card">
      <div class="stat-num">${k.value}</div>
      <div class="stat-label">${k.label}</div>
      <div class="stat-sub">${k.sub}</div>
    </div>`).join('');
  }

  // ── State filter dropdown ─────────────────────────────────────────────────
  const stateSelect = $("#deptmap-state-filter");
  if (stateSelect && stateBreakdown.length) {
    stateBreakdown.forEach(st => {
      const opt = document.createElement('option');
      opt.value = st.state;
      opt.textContent = `${st.state} (${st.total.toLocaleString()})`;
      stateSelect.appendChild(opt);
    });
  }

  // ── State bar chart ───────────────────────────────────────────────────────
  _deptRenderStateBars(stateBreakdown, 'total');
  const choroplethSelect = $("#deptmap-choropleth-metric");
  if (choroplethSelect) {
    choroplethSelect.addEventListener('change', () => {
      _deptRenderStateBars(stateBreakdown, choroplethSelect.value);
    });
  }

  // ── Type breakdown chart ─────────────────────────────────────────────────
  const typechartEl = $("#deptmap-type-chart");
  if (typechartEl) {
    const tb = s.type_breakdown || {};
    const total = Object.values(tb).reduce((a,b) => a+b, 0);
    const types = [
      { key: 'career', label: 'Career' },
      { key: 'volunteer', label: 'Volunteer' },
      { key: 'combination', label: 'Combination' },
      { key: 'unknown', label: 'Unknown / Not Reported' },
    ];
    typechartEl.innerHTML = types.map(t => `
      <div class="neris-bar-row">
        <span class="neris-bar-label">${t.label}</span>
        <div class="neris-bar-track">
          <div class="neris-bar-fill" style="width:${((tb[t.key]||0)/total*100).toFixed(1)}%;background:${_deptColor(t.key)}"></div>
        </div>
        <span class="neris-bar-value">${(tb[t.key]||0).toLocaleString()} <span class="muted">(${((tb[t.key]||0)/total*100).toFixed(1)}%)</span></span>
      </div>
    `).join('');
  }

  // ── County list ───────────────────────────────────────────────────────────
  const countyEl = $("#deptmap-county-list");
  if (countyEl && topCounties.length) {
    const maxC = topCounties[0].total;
    countyEl.innerHTML = topCounties.slice(0, 15).map(c => `
      <div class="neris-bar-row">
        <span class="neris-bar-label" style="min-width:200px;max-width:200px;">${escapeHTML(c.county)}</span>
        <div class="neris-bar-track"><div class="neris-bar-fill" style="width:${(c.total/maxC*100).toFixed(1)}%"></div></div>
        <span class="neris-bar-value">${c.total}</span>
      </div>
    `).join('');
  }

  // ── Full state table ──────────────────────────────────────────────────────
  const stateBody = $("#deptmap-state-body");
  if (stateBody) {
    stateBody.innerHTML = stateBreakdown.map(st => `
      <tr>
        <td><strong>${escapeHTML(st.state)}</strong></td>
        <td>${st.total.toLocaleString()}</td>
        <td style="color:${DEPT_TYPE_COLOR.career}">${st.career.toLocaleString()}</td>
        <td style="color:${DEPT_TYPE_COLOR.volunteer}">${st.volunteer.toLocaleString()}</td>
        <td style="color:${DEPT_TYPE_COLOR.combination}">${st.combination.toLocaleString()}</td>
        <td style="color:#22c55e">${st.ems.toLocaleString()}</td>
      </tr>
    `).join('');
  }

  // ── Initialize Leaflet map ────────────────────────────────────────────────
  if (loadingEl) loadingEl.textContent = 'Initializing map...';
  const mapEl = $("#deptmap-map");
  if (!mapEl || typeof L === 'undefined') {
    if (loadingEl) loadingEl.textContent = 'Map library failed to load.';
    return;
  }

  _deptMapInstance = L.map('deptmap-map', {
    center: [39.5, -98.35],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri | HIFLD + USFA',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(_deptMapInstance);

  // ── Load GeoJSON (large, lazy) ────────────────────────────────────────────
  if (loadingEl) loadingEl.textContent = 'Loading 53,000 fire stations...';
  const geojson = await fetchJSON('dept_map_geojson.json');
  if (!geojson || !geojson.features) {
    if (loadingEl) loadingEl.textContent = 'GeoJSON not available. Run the pipeline.';
    return;
  }
  _deptAllFeatures = geojson.features;
  if (loadingEl) loadingEl.hidden = true;

  // ── Bind filter controls ──────────────────────────────────────────────────
  $$(".deptmap-chip[data-filter='type']").forEach(btn => {
    btn.addEventListener('click', () => {
      $$(".deptmap-chip[data-filter='type']").forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _deptFilters.type = btn.dataset.value;
      _deptApplyFilters();
    });
  });
  $$(".deptmap-chip[data-filter='ems']").forEach(btn => {
    btn.addEventListener('click', () => {
      $$(".deptmap-chip[data-filter='ems']").forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _deptFilters.ems = btn.dataset.value;
      _deptApplyFilters();
    });
  });
  if (stateSelect) stateSelect.addEventListener('change', () => {
    _deptFilters.state = stateSelect.value;
    _deptApplyFilters();
  });
  const personnelInput = $("#deptmap-personnel-min");
  if (personnelInput) personnelInput.addEventListener('input', debounce(() => {
    _deptFilters.personnelMin = parseInt(personnelInput.value || '0', 10) || 0;
    _deptApplyFilters();
  }, 300));
  const resetBtn = $("#deptmap-reset");
  if (resetBtn) resetBtn.addEventListener('click', () => {
    _deptFilters = { type: 'all', ems: 'all', state: 'all', personnelMin: 0 };
    $$(".deptmap-chip").forEach(b => b.classList.remove('active'));
    $$(".deptmap-chip[data-value='all']").forEach(b => b.classList.add('active'));
    if (stateSelect) stateSelect.value = 'all';
    if (personnelInput) personnelInput.value = '';
    _deptApplyFilters();
  });

  // ── Render initial map ────────────────────────────────────────────────────
  _deptApplyFilters();
}

let _deptClusterGroup = null;

function _deptApplyFilters() {
  const { type, ems, state, personnelMin } = _deptFilters;
  const filtered = _deptAllFeatures.filter(f => {
    const p = f.properties;
    if (type !== 'all' && p.type !== type) return false;
    if (ems === 'yes' && !p.ems) return false;
    if (ems === 'no'  && p.ems) return false;
    if (state !== 'all' && p.state !== state) return false;
    if (personnelMin > 0 && (p.personnel || 0) < personnelMin) return false;
    return true;
  });

  const countEl = $("#deptmap-result-count");
  if (countEl) countEl.textContent = `${filtered.length.toLocaleString()} stations shown`;

  if (!_deptMapInstance) return;

  // Remove old cluster group
  if (_deptClusterGroup) _deptMapInstance.removeLayer(_deptClusterGroup);

  _deptClusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 40,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: (cluster) => {
      const count = cluster.getChildCount();
      const size = count > 1000 ? 40 : count > 100 ? 32 : 24;
      return L.divIcon({
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:rgba(239,68,68,0.85);border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:${size < 30 ? 10 : 12}px;font-weight:700;color:#fff;">${count > 999 ? Math.round(count/1000)+'k' : count}</div>`,
        className: '',
        iconSize: [size, size],
        iconAnchor: [size/2, size/2],
      });
    },
  });

  filtered.forEach(f => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const marker = L.circleMarker([lat, lng], {
      radius: 5,
      fillColor: _deptColor(p.type),
      color: 'rgba(0,0,0,0.4)',
      weight: 1,
      fillOpacity: 0.85,
    });
    marker.bindPopup(`
      <div style="min-width:200px;font-size:13px;">
        <strong>${escapeHTML(p.name || 'Unknown')}</strong><br>
        <span style="color:#9ca3af;">${escapeHTML(p.city || '')}, ${escapeHTML(p.state || '')}</span><br>
        <span style="color:#9ca3af;font-size:11px;">${escapeHTML(p.county || '')} County</span><br>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <span style="background:${_deptColor(p.type)};color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;">${p.type_raw || p.type}</span>
          ${p.ems ? '<span style="background:#22c55e;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;">EMS</span>' : ''}
        </div>
        <table style="margin-top:8px;font-size:12px;width:100%;">
          ${p.personnel ? `<tr><td style="color:#9ca3af;">Personnel</td><td><strong>${p.personnel}</strong></td></tr>` : ''}
          ${p.career_ff ? `<tr><td style="color:#9ca3af;">Career FF</td><td><strong>${p.career_ff}</strong></td></tr>` : ''}
          ${p.volunteer_ff ? `<tr><td style="color:#9ca3af;">Volunteer FF</td><td><strong>${p.volunteer_ff}</strong></td></tr>` : ''}
          ${p.trucks ? `<tr><td style="color:#9ca3af;">Trucks</td><td><strong>${p.trucks}</strong></td></tr>` : ''}
          ${p.fdid ? `<tr><td style="color:#9ca3af;">FDID</td><td><code>${p.fdid}</code></td></tr>` : ''}
        </table>
      </div>
    `);
    _deptClusterGroup.addLayer(marker);
  });

  _deptMapInstance.addLayer(_deptClusterGroup);
}

function _deptRenderStateBars(stateBreakdown, metric) {
  const el = $("#deptmap-state-bars");
  if (!el) return;
  const sorted = [...stateBreakdown].sort((a,b) => (b[metric]||0) - (a[metric]||0));
  const maxVal = sorted[0] ? (sorted[0][metric] || 1) : 1;
  el.innerHTML = sorted.slice(0, 30).map(st => `
    <div class="neris-bar-row">
      <span class="neris-bar-label" style="min-width:50px;max-width:50px;">${escapeHTML(st.state)}</span>
      <div class="neris-bar-track">
        <div class="neris-bar-fill" style="width:${((st[metric]||0)/maxVal*100).toFixed(1)}%;background:${
          metric === 'career' ? DEPT_TYPE_COLOR.career
          : metric === 'volunteer' ? DEPT_TYPE_COLOR.volunteer
          : metric === 'ems' ? '#22c55e'
          : '#3b82f6'
        }"></div>
      </div>
      <span class="neris-bar-value">${(st[metric]||0).toLocaleString()}</span>
    </div>
  `).join('');
}

async function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* =====================================================================
 * NERIS Public Intelligence Tab — Full National Map
 * 16.3M incidents · 30,765 departments · 24,586 jurisdiction polygons
 *
 * Incident API (16.3M records, query on-demand):
 *   INC_SVC = https://lPbcyJOcoLyZmvo6.svcs5.arcgis.com/.../NERIS Public Incident Basics/FeatureServer/0
 *
 * Dept/Jurisdiction API:
 *   DEPT_SVC = https://services5.arcgis.com/lPbcyJOcoLyZmvo6/.../NERIS Public Fire Departments/FeatureServer
 *     /0 = Department (points)   /2 = DepartmentJurisdiction (polygons)
 * ===================================================================== */

const INC_SVC =
  "https://lPbcyJOcoLyZmvo6.svcs5.arcgis.com/lPbcyJOcoLyZmvo6" +
  "/arcgis/rest/services/NERIS%20Public%20Incident%20Basics/FeatureServer/0";
const DEPT_SVC_BASE =
  "https://services5.arcgis.com/lPbcyJOcoLyZmvo6" +
  "/arcgis/rest/services/NERIS%20Public%20Fire%20Departments/FeatureServer";

// Category → color mapping
const NERIS_COLORS = {
  FIRE:        "#e74c3c",
  MEDICAL:     "#3498db",
  HAZSIT:      "#f39c12",
  RESCUE:      "#9b59b6",
  PUBSERV:     "#2ecc71",
  NOEMERG:     "#95a5a6",
  LAWENFORCE:  "#1abc9c",
  UNKNOWN:     "#bdc3c7",
};

function _nerisColor(type1) {
  if (!type1) return NERIS_COLORS.UNKNOWN;
  const cat = type1.split("||")[0].trim();
  return NERIS_COLORS[cat] || NERIS_COLORS.UNKNOWN;
}
function _nerisCat(type1) {
  if (!type1) return "UNKNOWN";
  return type1.split("||")[0].trim();
}
function _nerisSub(type1) {
  if (!type1) return "";
  const parts = type1.split("||");
  return parts.slice(1).join(" › ");
}

let _nerisLoaded = false;
let _nerisMap = null;
let _nerisIncidentLayer = null;
let _nerisDeptLayer = null;
let _nerisJurisdLayer = null;
let _nerisDeptData = null;
let _nerisIntelData = null;
let _nerisAllDepts = []; // for filter dropdowns
let _nerisStationIndex = null; // by_dept index from neris_station_summary.json

async function _nerisEnsureStations() {
  if (_nerisStationIndex !== null) return;
  try {
    const sd = await fetchJSON("neris_station_summary.json");
    _nerisStationIndex = sd?.by_dept || {};
  } catch(e) { _nerisStationIndex = {}; }
}

async function _nerisEnsureDepts() {
  if (_nerisAllDepts.length > 0) return; // already loaded
  const statusEl = $("#neris-map-status");
  if (statusEl) statusEl.textContent = "Loading department data…";
  // Try lean file first; fall back to full summary
  let deptData;
  try { deptData = await fetchJSON("neris_dept_map.json"); }
  catch(e) { deptData = await fetchJSON("neris_dept_summary.json"); }
  _nerisDeptData = deptData;
  _nerisAllDepts = (deptData?.departments || []);
  // Populate dept-table state filter now that we have data
  const deptSel = $("#neris-dept-state-filter");
  if (deptSel && deptSel.options.length <= 1) {
    const states = [...new Set(_nerisAllDepts.map((d) => d.state).filter(Boolean))].sort();
    states.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      deptSel.appendChild(opt);
    });
  }
  if (statusEl) statusEl.textContent = "";
}

async function loadNeris() {
  if (_nerisLoaded) return;
  _nerisLoaded = true;

  // Only load the small intel summary upfront (~50KB) — NOT the 12.6MB dept file
  const intelData = await fetchJSON("neris_public_intel.json");
  _nerisIntelData = intelData;

  // KPI strip
  _nerisRenderKpi(intelData);

  // Populate state dropdowns from intel data (no dept file needed)
  _nerisPopulateStateDropdowns(intelData);

  // Sub-tab navigation
  document.querySelectorAll(".neris-subbtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".neris-subbtn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const sub = btn.dataset.subtab;
      document.querySelectorAll(".neris-subtab").forEach((el) => { el.hidden = true; });
      const panel = $(`#neris-sub-${sub}`);
      if (panel) panel.hidden = false;
      if (sub === "depts") { await _nerisEnsureDepts(); _nerisRenderDeptTable(""); }
      if (sub === "stats") _nerisRenderStats();
      if (sub === "map" && !_nerisMap) _nerisInitMap();
    });
  });

  // Init map shell (no data fetch yet — user clicks Load Map)
  _nerisInitMap();

  // Load map button — fetches dept data on demand
  const loadBtn = $("#neris-load-map-btn");
  if (loadBtn) loadBtn.addEventListener("click", async () => {
    await _nerisEnsureDepts();
    _nerisLoadMapData();
  });
}

// ── KPI strip ─────────────────────────────────────────────────────────────────

function _nerisRenderKpi(data) {
  const el = $("#neris-kpi");
  if (!el || !data) return;
  const meta = data.meta || {};
  const incTotal = meta.total_incidents;
  const incVal = incTotal ? incTotal.toLocaleString() : "N/A";
  const stats = [
    { label: "Total Incidents", val: incVal },
    { label: "Departments", val: (meta.total_departments || 0).toLocaleString() },
    { label: "States", val: meta.states_reporting || 0 },
    { label: "Jurisdiction Boundaries", val: "24,586" },
  ];
  el.innerHTML = stats.map((s) =>
    `<div class="stat-item"><div class="stat-val">${s.val}</div><div class="stat-label">${escapeHTML(s.label)}</div></div>`
  ).join("");
  // Show notice if incident record-level queries are disabled
  if (meta.inc_svc_status === "count_only") {
    el.insertAdjacentHTML("beforeend",
      `<div style="grid-column:1/-1;font-size:11px;color:var(--muted);margin-top:4px;padding:4px 8px;background:rgba(241,196,15,0.08);border-radius:4px;border-left:3px solid #f1c40f;">
        ⚠️ NERIS incident record queries are currently restricted by the API — state incident counts and type breakdowns unavailable. Department, station, and unit data are current.
      </div>`
    );
  }
}

// ── State dropdowns ────────────────────────────────────────────────────────────

function _nerisPopulateStateDropdowns(data) {
  const states = (data?.state_summary || []).map((s) => s.state).sort();

  // Map filter state select
  const mapSel = $("#neris-state-select");
  if (mapSel) {
    states.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      mapSel.appendChild(opt);
    });
    mapSel.addEventListener("change", _nerisOnStateChange);
  }

  // Stats detail select
  const detailSel = $("#neris-state-detail-select");
  if (detailSel) {
    states.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      detailSel.appendChild(opt);
    });
    detailSel.addEventListener("change", () => _nerisRenderStateDetail(detailSel.value));
  }

  // Dept table state filter
  const deptSel = $("#neris-dept-state-filter");
  if (deptSel) {
    states.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      deptSel.appendChild(opt);
    });
    deptSel.addEventListener("change", _nerisDeptFilter);
  }
}

// ── Map init ────────────────────────────────────────────────────────────────

function _nerisInitMap() {
  if (_nerisMap) return;
  const mapEl = document.getElementById("neris-map");
  if (!mapEl || typeof L === "undefined") return;

  _nerisMap = L.map("neris-map", {
    center: [39.5, -98.35],
    zoom: 4,
    preferCanvas: true,
  });

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri", maxZoom: 18 }
  ).addTo(_nerisMap);

  _nerisIncidentLayer = L.layerGroup().addTo(_nerisMap);
  _nerisDeptLayer = L.layerGroup().addTo(_nerisMap);
  _nerisJurisdLayer = L.layerGroup().addTo(_nerisMap);

  // Layer toggles
  $("#neris-layer-incidents")?.addEventListener("change", (e) => {
    if (e.target.checked) _nerisMap.addLayer(_nerisIncidentLayer);
    else _nerisMap.removeLayer(_nerisIncidentLayer);
  });
  $("#neris-layer-depts")?.addEventListener("change", (e) => {
    if (e.target.checked) _nerisMap.addLayer(_nerisDeptLayer);
    else _nerisMap.removeLayer(_nerisDeptLayer);
  });
  $("#neris-layer-jurisdictions")?.addEventListener("change", (e) => {
    if (e.target.checked) _nerisMap.addLayer(_nerisJurisdLayer);
    else _nerisMap.removeLayer(_nerisJurisdLayer);
  });
}

// ── State change → populate dept dropdown ─────────────────────────────────────

function _nerisOnStateChange() {
  const state = $("#neris-state-select")?.value || "";
  const deptSel = $("#neris-dept-select");
  if (!deptSel) return;

  deptSel.innerHTML = '<option value="">— All Departments —</option>';

  if (!state) {
    deptSel.disabled = true;
    return;
  }

  const stateDepts = _nerisAllDepts
    .filter((d) => d.state === state && d.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  stateDepts.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.neris_id || d.name;
    opt.textContent = d.name;
    opt.dataset.name = d.name;
    deptSel.appendChild(opt);
  });
  deptSel.disabled = false;
}

// ── Load incident + dept data onto map ────────────────────────────────────────

async function _nerisLoadMapData() {
  if (!_nerisMap) _nerisInitMap();

  const state = $("#neris-state-select")?.value || "";
  const deptId = $("#neris-dept-select")?.value || "";
  const deptName = $("#neris-dept-select")?.selectedOptions?.[0]?.dataset?.name || "";
  const typeFilter = $("#neris-type-select")?.value || "";
  const showIncidents = $("#neris-layer-incidents")?.checked !== false;
  const showDepts = $("#neris-layer-depts")?.checked;
  const showJurisd = $("#neris-layer-jurisdictions")?.checked;

  const statusEl = $("#neris-map-status");
  if (statusEl) statusEl.textContent = "Loading…";

  // Clear existing layers
  _nerisIncidentLayer.clearLayers();
  _nerisDeptLayer.clearLayers();
  _nerisJurisdLayer.clearLayers();

  // Build WHERE clause for incidents
  const whereParts = [];
  if (state) whereParts.push(`department_state='${state}'`);
  if (deptId && deptName) whereParts.push(`department_name='${deptName.replace(/'/g, "''")}'`);
  if (typeFilter) whereParts.push(`type_1 LIKE '${typeFilter}%'`);
  const where = whereParts.length ? whereParts.join(" AND ") : "1=1";

  // For large queries (no dept filter) limit to 2000 pts with a recent date filter
  let recordLimit = 2000;
  let finalWhere = where;
  const resultsEl = $("#neris-map-results");

  try {
    // 1. NERIS incident live queries are disabled (API restriction as of 2026-09)
    //    Show a notice in the results strip instead of a hanging request.
    if (showIncidents) {
      if (resultsEl) resultsEl.innerHTML =
        `<span style="color:#f1c40f;">⚠ NERIS incident record queries are currently restricted by the API.
        Incident map layer is unavailable. Use the Stats tab for aggregate data.</span>`;
      if (statusEl) statusEl.textContent = "";
    }

    // 2. Load department HQ points from our pre-fetched dept summary
    if (showDepts && state) {
      const stateDepts = _nerisAllDepts.filter((d) => d.state === state && d.lat && d.lon);
      stateDepts.forEach((d) => {
        const marker = L.circleMarker([d.lat, d.lon], {
          radius: 7,
          fillColor: "#f1c40f",
          color: "#333",
          weight: 1.5,
          opacity: 1,
          fillOpacity: 0.9,
        });
        marker.bindPopup(
          `<b>${escapeHTML(d.name || "")}</b><br>` +
          `${escapeHTML(d.city || "")}, ${escapeHTML(d.state || "")}<br>` +
          `Type: ${escapeHTML(d.dept_type || "?")}<br>` +
          `Stations: ${d.stations ?? "?"} · Units: ${d.units ?? "?"}<br>` +
          (d.population ? `Population: ${d.population.toLocaleString()}<br>` : "") +
          (d.website ? `<a href="${escapeHTML(d.website)}" target="_blank" rel="noopener">Website ↗</a>` : "")
        );
        _nerisDeptLayer.addLayer(marker);
      });
    }

    // 3. Load jurisdiction boundaries
    if (showJurisd && state) {
      if (statusEl) statusEl.textContent = "Loading jurisdictions…";
      const jurisdWhere = state ? `state='${state}'` : "1=1";
      // Fetch jurisdiction polygons from ArcGIS — paginate up to 500 for a state
      const jurResp = await fetch(
        `${DEPT_SVC_BASE}/2/query?` + new URLSearchParams({
          where: "1=1",
          outFields: "neris_id,name,department_type,region_type",
          geometry: _nerisStateBbox(state),
          geometryType: "esriGeometryEnvelope",
          spatialRel: "esriSpatialRelIntersects",
          returnGeometry: "true",
          resultRecordCount: 500,
          outSR: "4326",
          f: "geojson",
        })
      );
      const jurData = await jurResp.json();
      if (jurData.features?.length) {
        L.geoJSON(jurData, {
          style: (feat) => ({
            color: "#e67e22",
            fillColor: "#e67e22",
            fillOpacity: 0.08,
            weight: 1.2,
            dashArray: "4 3",
          }),
          onEachFeature: (feat, layer) => {
            const p = feat.properties || {};
            layer.bindPopup(
              `<b>${escapeHTML(p.name || "Jurisdiction")}</b><br>` +
              `Type: ${escapeHTML(p.department_type || "?")}<br>` +
              `Region: ${escapeHTML(p.region_type || "?")}`
            );
          },
        }).addTo(_nerisJurisdLayer);
      }
      if (statusEl) statusEl.textContent = "";
    }

    // 4. Render legend
    _nerisRenderLegend(typeFilter);

  } catch (err) {
    if (statusEl) statusEl.textContent = "Error loading data — try a more specific filter";
    console.error("[neris map]", err);
  }
}

// ── State bounding boxes for jurisdiction spatial filter ──────────────────────

const STATE_BBOXES = {
  AL: [-88.47,30.22,-84.89,35.01], AK: [-179.15,51.21,-129.97,71.35], AZ: [-114.82,31.33,-109.04,37.00],
  AR: [-94.62,33.00,-89.64,36.50], CA: [-124.41,32.53,-114.13,42.01], CO: [-109.05,36.99,-102.04,41.00],
  CT: [-73.73,40.99,-71.79,42.05], DE: [-75.79,38.45,-75.05,39.84], FL: [-87.63,24.52,-80.03,31.00],
  GA: [-85.61,30.36,-80.84,35.00], HI: [-160.25,18.91,-154.81,22.23], ID: [-117.24,41.99,-111.04,49.00],
  IL: [-91.51,36.97,-87.02,42.51], IN: [-88.10,37.77,-84.78,41.76], IA: [-96.64,40.38,-90.14,43.50],
  KS: [-102.05,36.99,-94.59,40.00], KY: [-89.57,36.50,-81.96,39.15], LA: [-94.04,28.93,-88.82,33.02],
  ME: [-71.09,43.06,-66.95,47.46], MD: [-79.49,37.91,-75.05,39.72], MA: [-73.50,41.24,-69.93,42.89],
  MI: [-90.42,41.70,-82.42,48.19], MN: [-97.24,43.50,-89.49,49.38], MS: [-91.66,30.17,-88.10,35.00],
  MO: [-95.77,35.99,-89.10,40.61], MT: [-116.05,44.36,-104.04,49.00], NE: [-104.05,40.00,-95.31,43.00],
  NV: [-120.00,35.00,-114.04,42.00], NH: [-72.56,42.70,-70.70,45.31], NJ: [-75.56,38.93,-73.89,41.36],
  NM: [-109.05,31.33,-103.00,37.00], NY: [-79.76,40.50,-71.86,45.01], NC: [-84.32,33.84,-75.46,36.59],
  ND: [-104.05,45.94,-96.55,49.00], OH: [-84.82,38.40,-80.52,42.33], OK: [-103.00,33.62,-94.43,37.00],
  OR: [-124.57,41.99,-116.46,46.26], PA: [-80.52,39.72,-74.69,42.27], RI: [-71.91,41.15,-71.12,42.02],
  SC: [-83.36,32.04,-78.54,35.22], SD: [-104.06,42.48,-96.44,45.95], TN: [-90.31,34.98,-81.65,36.68],
  TX: [-106.65,25.84,-93.51,36.50], UT: [-114.05,37.00,-109.04,42.00], VT: [-73.44,42.73,-71.50,45.02],
  VA: [-83.68,36.54,-75.24,39.47], WA: [-124.73,45.54,-116.92,49.00], WV: [-82.64,37.20,-77.72,40.64],
  WI: [-92.89,42.49,-86.80,47.08], WY: [-111.06,41.00,-104.05,45.01],
};

function _nerisStateBbox(state) {
  const bb = STATE_BBOXES[state];
  if (!bb) return null;
  return `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`;
}

// ── Legend ────────────────────────────────────────────────────────────────────

function _nerisRenderLegend(typeFilter) {
  const el = $("#neris-map-legend");
  if (!el) return;
  const categories = typeFilter
    ? [[typeFilter, NERIS_COLORS[typeFilter] || NERIS_COLORS.UNKNOWN]]
    : Object.entries(NERIS_COLORS).filter(([k]) => k !== "UNKNOWN");
  el.innerHTML =
    categories.map(([cat, color]) =>
      `<span style="display:flex;align-items:center;gap:4px;">` +
      `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;"></span>` +
      `<span style="color:var(--text-muted)">${escapeHTML(cat)}</span></span>`
    ).join("") +
    `<span style="display:flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:50%;background:#f1c40f;border:1.5px solid #333;display:inline-block;"></span><span style="color:var(--text-muted)">Dept HQ</span></span>` +
    `<span style="display:flex;align-items:center;gap:4px;"><span style="width:14px;height:3px;background:#e67e22;border:1px dashed #e67e22;display:inline-block;"></span><span style="color:var(--text-muted)">Jurisdiction</span></span>`;
}

// ── Department table ──────────────────────────────────────────────────────────

function _nerisDeptFilter() {
  const q = ($("#neris-dept-search")?.value || "").toLowerCase();
  _nerisRenderDeptTable(q);
}

function _nerisRenderDeptTable(query) {
  const stateFilter = $("#neris-dept-state-filter")?.value || "";
  const typeFilter = $("#neris-dept-type-filter")?.value || "";
  const tbody = $("#neris-dept-tbody");
  if (!tbody) return;

  let depts = _nerisAllDepts;
  if (stateFilter) depts = depts.filter((d) => d.state === stateFilter);
  if (typeFilter) depts = depts.filter((d) => (d.dept_type || "").includes(typeFilter));
  if (query) depts = depts.filter((d) =>
    (d.name || "").toLowerCase().includes(query) ||
    (d.city || "").toLowerCase().includes(query)
  );

  // Show first 200
  const slice = depts.slice(0, 200);
  const countEl = $("#neris-dept-count");
  if (countEl) countEl.textContent = `${depts.length.toLocaleString()} departments${depts.length > 200 ? " (showing 200)" : ""}`;

  // Pre-fetch station index silently so drilldown is ready
  _nerisEnsureStations();

  tbody.innerHTML = slice.map((d, i) =>
    `<tr class="neris-dept-row" data-idx="${i}" data-neris-id="${escapeHTML(d.neris_id || "")}" style="cursor:pointer;" title="Click to see stations">
      <td>${escapeHTML(d.name || "")}</td>
      <td>${escapeHTML(d.state || "")}</td>
      <td>${escapeHTML(d.city || "")}</td>
      <td><span class="pill ${d.dept_type === "CAREER" ? "pill-blue" : d.dept_type === "VOLUNTEER" ? "pill-green" : "pill-accent"}">${escapeHTML(d.dept_type || "?")}</span></td>
      <td>${d.stations_live ?? d.stations ?? "—"}</td>
      <td>${d.units_live ?? d.units ?? "—"}</td>
      <td>${d.population ? d.population.toLocaleString() : "—"}</td>
      <td>${d.ff_career ?? "—"}</td>
      <td>${d.ff_volunteer ?? "—"}</td>
    </tr>`
  ).join("");

  // Station drilldown on row click
  tbody.querySelectorAll(".neris-dept-row").forEach((row, i) => {
    row.addEventListener("click", async () => {
      // Remove any existing drilldown rows
      tbody.querySelectorAll(".neris-station-drilldown").forEach(r => r.remove());
      const existingExpanded = tbody.querySelector(".neris-dept-row.expanded");
      const isThisRow = existingExpanded === row;
      if (existingExpanded) existingExpanded.classList.remove("expanded");
      if (isThisRow) return; // toggle off
      row.classList.add("expanded");

      await _nerisEnsureStations();
      const deptId = row.dataset.nerisId;
      const stations = (_nerisStationIndex?.[deptId] || []);
      const drillRow = document.createElement("tr");
      drillRow.className = "neris-station-drilldown";
      if (!stations.length) {
        drillRow.innerHTML = `<td colspan="9" style="padding:8px 16px;font-size:12px;color:var(--muted);">└ No station data yet (available after next pipeline run)</td>`;
      } else {
        const rows = stations.map(st =>
          `<tr><td style="padding:2px 8px;">${escapeHTML(st.name || st.neris_id || "")}</td>` +
          `<td style="padding:2px 8px;">${escapeHTML(st.city || "")}, ${escapeHTML(st.state || "")}</td>` +
          `<td style="padding:2px 8px;text-align:right">${st.unit_count ?? "—"} units</td></tr>`
        ).join("");
        drillRow.innerHTML = `<td colspan="9" style="padding:8px 16px;font-size:12px;">
          <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="color:var(--muted);font-size:11px;"><td>Station</td><td>Location</td><td>Units</td></tr></thead>
          <tbody>${rows}</tbody></table></td>`;
      }
      row.after(drillRow);
    });
  });

  // Wire up search after render
  const searchEl = $("#neris-dept-search");
  if (searchEl && !searchEl._wired) {
    searchEl.addEventListener("input", _nerisDeptFilter);
    searchEl._wired = true;
  }
  const typeEl = $("#neris-dept-type-filter");
  if (typeEl && !typeEl._wired) {
    typeEl.addEventListener("change", _nerisDeptFilter);
    typeEl._wired = true;
  }
}

// ── National Stats ────────────────────────────────────────────────────────────

function _nerisRenderStats() {
  if (!_nerisIntelData) return;
  const meta = _nerisIntelData.meta || {};
  const incDisabled = meta.inc_svc_status === "count_only";

  // State bar chart — dual metric: departments + total firefighters (career+volunteer)
  const stateChart = $("#neris-state-chart");
  if (stateChart) {
    // Sort by total firefighter headcount for a meaningful ranking
    const states = [...(_nerisIntelData.state_summary || [])]
      .map(s => ({ ...s, total_ff: (s.ff_career || 0) + (s.ff_volunteer || 0) }))
      .sort((a, b) => b.total_ff - a.total_ff)
      .slice(0, 25);
    const maxFF   = Math.max(...states.map(s => s.total_ff), 1);
    const maxDept = Math.max(...states.map(s => s.dept_count || 0), 1);

    stateChart.innerHTML =
      `<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">Ranked by firefighter headcount — <span style="color:#4aa3ff;">&#9632;</span> Career &nbsp; <span style="color:#f5a623;">&#9632;</span> Volunteer</div>` +
      states.map((s) => {
        const ffTotal = s.total_ff;
        const careerPct = ffTotal ? Math.round((s.ff_career || 0) / maxFF * 100) : 0;
        const volPct    = ffTotal ? Math.round((s.ff_volunteer || 0) / maxFF * 100) : 0;
        const deptW = Math.round((s.dept_count || 0) / maxDept * 100);
        return `<div style="margin-bottom:5px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="min-width:28px;text-align:right;font-size:11px;color:var(--muted);">${escapeHTML(s.state)}</span>
            <div style="flex:1;background:var(--border);border-radius:3px;height:10px;overflow:hidden;display:flex;">
              <div style="width:${careerPct}%;height:100%;background:#4aa3ff;"></div>
              <div style="width:${volPct}%;height:100%;background:#f5a623;"></div>
            </div>
            <span style="min-width:90px;font-size:10px;color:var(--text);">${ffTotal.toLocaleString()} FF &middot; ${(s.dept_count||0).toLocaleString()}d</span>
          </div>
        </div>`;
      }).join("");
  }

  // ── Incident Types panel — uses NFIRS 2024 data (NERIS INC_SVC is read-only count-only)
  const catChart = $("#neris-cat-chart");
  if (catChart) {
    // Pull NFIRS 2024 top incident types — real breakdown data
    const nfirsTypes = (NFIRS?.data?.by_year?.["2024"]?.top_incident_types ||
                        NFIRS?.data?.by_year?.["2023"]?.top_incident_types || []);
    const nfirsYear  = NFIRS?.data?.by_year?.["2024"] ? "2024" : "2023";

    // Workforce composition from NERIS state_summary
    const ss = _nerisIntelData?.state_summary || [];
    const totalCareer = ss.reduce((a, s) => a + (s.ff_career || 0), 0);
    const totalVol    = ss.reduce((a, s) => a + (s.ff_volunteer || 0), 0);
    const totalFF     = totalCareer + totalVol;
    const totalStations = ss.reduce((a, s) => a + (s.station_count || 0), 0);
    const totalUnits    = ss.reduce((a, s) => a + (s.unit_count || 0), 0);
    const careerPct  = totalFF ? Math.round(totalCareer / totalFF * 100) : 0;
    const volPct     = totalFF ? Math.round(totalVol    / totalFF * 100) : 0;

    const incidentRows = nfirsTypes.length
      ? (() => {
          const maxCount = Math.max(...nfirsTypes.map(t => t.count), 1);
          return nfirsTypes.slice(0, 10).map(t => {
            const pct = Math.round(t.count / maxCount * 100);
            const loss = t.property_loss_usd ? `$${(t.property_loss_usd/1e9).toFixed(1)}B loss` : "";
            const deaths = t.civilian_deaths ? `<span style="color:#e74c3c;"> · ${t.civilian_deaths} civ deaths</span>` : "";
            return `<div style="margin-bottom:6px;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;">
                <span style="font-size:11px;color:var(--text);font-weight:600;">${escapeHTML(t.description)}</span>
                <span style="font-size:10px;color:var(--muted);">${t.count.toLocaleString()}${deaths}</span>
              </div>
              <div style="background:var(--border);border-radius:3px;height:10px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:#e74c3c;border-radius:3px;opacity:.85;"></div>
              </div>
              ${loss ? `<div style="font-size:9px;color:var(--muted);margin-top:1px;">${loss}</div>` : ""}
            </div>`;
          }).join("");
        })()
      : `<div style="font-size:11px;color:var(--muted);">NFIRS data not loaded</div>`;

    catChart.innerHTML = `
      <div style="margin-bottom:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:2px;">Top Incident Types <span style="color:var(--muted);font-weight:400;">— NFIRS ${nfirsYear} (NERIS incident API is count-only)</span></div>
        ${incidentRows}
      </div>
      <div style="padding-top:10px;border-top:1px solid var(--border);">
        <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:8px;">National Workforce — NERIS (${totalFF.toLocaleString()} firefighters)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
          ${[
            ["Career FF", totalCareer.toLocaleString(), "#4aa3ff"],
            ["Volunteer FF", totalVol.toLocaleString(), "#f5a623"],
            ["Stations", totalStations.toLocaleString(), "#4caf84"],
            ["Units", totalUnits.toLocaleString(), "#a78bfa"],
          ].map(([label, val, col]) =>
            `<div style="background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:6px;padding:8px 6px;text-align:center;">
              <div style="font-size:15px;font-weight:700;color:${col};">${val}</div>
              <div style="font-size:9px;color:var(--muted);margin-top:2px;">${label}</div>
            </div>`
          ).join("")}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">${careerPct}% career · ${volPct}% volunteer</div>
        <div style="background:var(--border);border-radius:4px;height:12px;overflow:hidden;display:flex;">
          <div style="width:${careerPct}%;background:#4aa3ff;"></div>
          <div style="flex:1;background:#f5a623;"></div>
        </div>
      </div>`;
  }
}

// ── State detail panel ────────────────────────────────────────────────────────

function _nerisRenderStateDetail(state) {
  if (!state || !_nerisIntelData) return;
  const detail = (_nerisIntelData.state_details || {})[state];

  const typesEl = $("#neris-state-types");
  if (typesEl) {
    // types[] is always empty because NERIS INC_SVC is restricted —
    // show state aggregate from state_summary instead (stations/units/ff counts)
    const summ = (_nerisIntelData.state_summary || []).find((s) => s.state === state) || {};
    const incNotice = `<div style="font-size:11px;color:#f1c40f;margin-bottom:8px;padding:6px 8px;background:rgba(241,196,15,0.08);border-radius:4px;border-left:3px solid #f1c40f;">
      ⚠ Incident type breakdown unavailable (NERIS API restricted). Showing operational data below.
    </div>`;
    const rows = [
      ["Departments",  summ.dept_count?.toLocaleString()  || "—"],
      ["Stations",     summ.station_count?.toLocaleString() || "—"],
      ["Units",        summ.unit_count?.toLocaleString()   || "—"],
      ["Career FF",    summ.ff_career?.toLocaleString()    || "—"],
      ["Volunteer FF", summ.ff_volunteer?.toLocaleString() || "—"],
      ["Population",   summ.population?.toLocaleString()  || "—"],
    ];
    typesEl.innerHTML = incNotice +
      `<div class="small muted" style="margin-bottom:6px;font-weight:600;">Operational Snapshot — ${escapeHTML(state)}</div>` +
      `<table class="table" style="font-size:12px;"><tbody>` +
      rows.map(([label, val]) =>
        `<tr><td style="color:var(--muted);width:120px;">${label}</td><td><strong>${val}</strong></td></tr>`
      ).join("") + `</tbody></table>`;
  }

  const deptsEl = $("#neris-state-topdepts");
  if (deptsEl) {
    if (!detail?.top_depts?.length) {
      deptsEl.innerHTML = '<div class="empty-state small">No department data available for this state.</div>';
    } else {
      deptsEl.innerHTML = `<div class="small muted" style="margin-bottom:6px;font-weight:600;">Top Departments by Size (Stations &amp; Units)</div>` +
        `<table class="table" style="font-size:12px;"><thead><tr><th>Department</th><th>City</th><th>Stations</th><th>Units</th><th>FF Career</th></tr></thead><tbody>` +
        detail.top_depts.map((d) =>
          `<tr><td>${escapeHTML(d.name)}</td><td>${escapeHTML(d.city || "—")}</td><td>${d.stations ?? "—"}</td><td>${d.units ?? "—"}</td><td>${d.ff_career ?? "—"}</td></tr>`
        ).join("") +
        `</tbody></table>`;
    }
  }
}

/* =====================================================================
 * End NERIS Module
 * ===================================================================== */

document.addEventListener("DOMContentLoaded", async () => {
  initTabs();
  await loadDomain();

  // Boot: only load the Intel tab essentials. Heavy tabs are lazy — triggered on first click.
  // loadOptionalCharts() is called via setTimeout inside loadIntel() after ALL_CARDS is set.
  // loadFieldIntelLazy(), loadMarketIntelLazy(), loadPMHubLazy() fire on tab click (see initTabs).
  // loadNeris() is also lazy — triggered only when NERIS tab is clicked.
  await Promise.all([
    loadIntel(),
    loadCompetitive(),
    loadSources(),
    loadTrends(),
    loadSettingsBadge(),
    loadIntelBadge(),
  ]);
});
