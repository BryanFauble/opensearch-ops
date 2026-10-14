// Synapse Portal Search Lab — wiring for the playground (two independent, fully
// configurable search boxes side by side) and the in-browser benchmark scoreboard.
// Works against ANY Synapse SearchIndex: curated tables (e.g. nf-tools) ship a golden
// set + hand-tuned boosts in data/<table>.json; any other index is loaded by synID, its
// schema discovered live, and its boosts auto-generated.
// Logic/data mirror the Python harness (synapse.js / strategies.js / score.js).

import { search, hitDict, hitId, indexName, indexColumns, listSearchIndexes, configure } from "./synapse.js";
import {
  STRATEGIES, STRATEGY_ORDER, BOOSTED_KEYS, TYPES, PROD_TYPES, KEYWORD_TYPES, DEFAULT_KEYWORD_LEG, NORMALIZATIONS, COMBINATIONS,
  combinationsFor, LEVER_SUPPORT, keywordLeverType, buildQuery,
} from "./strategies.js";
import { scoreCase, aggregate } from "./score.js";
import { generateFieldBoosts } from "./boostgen.js";
import { strategyLabel, LEVER_HELP, METRIC_LABELS, toolTypeIcon } from "./labels.js";

// Shared SearchIndex collection project (children = every portal's index). See README.
// repo-staging reads the same data, so this is the default on both environments.
const DEFAULT_PROJECT = "syn74909065";
const TOOLS_INDEX = "syn75081636";  // nf-tools — the only index with per-type icons
const DISCOVERED = new Map();  // synID -> name, for indexes listed from the project

const METRIC_KEYS = ["mrr", "recall_at_k", "hit_at_1", "hit_at_k", "rt_ms_median", "rt_ms_p95"];
// Generic display-field preference (curated nf-tools columns first, then common fallbacks).
const NAME_KEYS = ["resourceName", "name", "title", "studyName", "label"];
const DESC_KEYS = ["description", "summary", "abstract", "overview"];
const TYPE_KEYS = ["resourceType", "type", "studyStatus", "category"];

const COL_KEYS = ["A", "B"];
// B defaults to cross_fields+AND — the fix discussed for multi-word queries getting
// diluted by OR — compared against the unmodified front-end baseline in A. Field boosts
// default off for both; flip "Use field boosts" on to layer them in.
const DEFAULT_LEVERS = {
  A: { type: "frontend_default" },
  B: { type: "cross_fields", operator: "and", useBoosts: false },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pick = (d, keys) => { for (const k of keys) if (d[k]) return d[k]; return null; };
const col = (key) => $(`.col[data-col="${key}"]`);
const typeName = (key) => (TYPES.find((t) => t.key === key) || {}).name || key;

let DATA = null;                 // { index, index_name, k, id_field, fields, cases, precomputed, generated? }
const BOOSTS = { A: [], B: [] };       // [{ field, boost }] editable per column, seeded from DATA.fields
const LEVERS = { A: {}, B: {} };       // { type, operator, fuzziness, minimumShouldMatch, slop, tieBreaker } per column
const LAST_RESULT = { A: null, B: null }; // { hits, total, next, pages } | { error } | null (hasn't searched yet)
const LAST_DSL = { A: null, B: null };    // the exact searchQuery DSL object sent for the last search, per column
const SEQ = { A: 0, B: 0 };               // per-column request counter — a response for an older request is dropped

// ---------------------------------------------------------------- connection
// Which Synapse environment the whole page talks to (prod or staging), plus an optional
// project override and token, kept in localStorage so they survive a reload. A change
// reloads rather than re-wiring in place: every index listing, discovered schema and
// result on the page belongs to the previous environment.
const CONN_KEY = "searchlab.connection";

const loadConn = () => {
  try { return JSON.parse(localStorage.getItem(CONN_KEY)) || {}; } catch { return {}; }
};
const CONN = loadConn();  // { env, project, token }
// Hybrid / semantic search is only live on staging, so only staging offers it.
const STAGING = CONN.env === "staging";
const project = () => CONN.project || DEFAULT_PROJECT;
const saveConn = (conn) => { localStorage.setItem(CONN_KEY, JSON.stringify(conn)); location.reload(); };

function setupConnection() {
  $("#envPick").value = STAGING ? "staging" : "prod";
  $("#envBadge").hidden = !STAGING;
  $("#envPick").addEventListener("change", () => saveConn({ ...CONN, env: $("#envPick").value }));
  $("#connProject").value = CONN.project || "";
  $("#connToken").value = CONN.token || "";
  $("#connSummary").textContent =
    `${STAGING ? "repo-staging" : "repo-prod"} · ${CONN.token ? "token set" : "anonymous"}`;
  $("#connApply").addEventListener("click", () => saveConn({
    env: CONN.env,
    project: $("#connProject").value.trim(),
    token: $("#connToken").value.trim(),
  }));
  $("#connReset").addEventListener("click", () => saveConn({ env: CONN.env }));
}

// ---------------------------------------------------------------- bootstrap
init().catch((e) => {
  $("main").insertAdjacentHTML("afterbegin", `<div class="errbox">Couldn’t start: ${esc(e.message)}</div>`);
});

async function init() {
  configure({ env: CONN.env, token: CONN.token });
  setupConnection();
  const manifest = await fetch("data/manifest.json").then((r) => (r.ok ? r.json() : { tables: [] })).catch(() => ({ tables: [] }));
  setupTabs();
  setupColumns();
  setupBenchmarkControls();
  setupIndexSelector(manifest);
  if (manifest.generated_at) $("#genStamp").textContent = `Built ${manifest.generated_at}.`;

  const first = (manifest.tables || [])[0];
  if (first) await loadTable(first.table);
  else { $("#indexPick").value = "custom"; $("#customWrap").hidden = false; setStatus("pick or paste a SearchIndex to begin"); }
}

const parseBoost = (f) => { const [field, w] = f.split("^"); return { field, boost: w ? Number(w) : 1 }; };
const buildFields = (c) => BOOSTS[c].map(({ field, boost }) => (boost === 1 ? field : `${field}^${boost}`));
const setStatus = (html, cls = "") => { const el = $("#indexStatus"); el.className = `inst-status ${cls}`; el.innerHTML = html; };

// ---------------------------------------------------------------- index selector
function setupIndexSelector(manifest) {
  const sel = $("#indexPick");
  const curatedIds = new Set((manifest.tables || []).map((t) => t.index));
  const curatedOpts = (manifest.tables || []).map((t) =>
    `<option value="t:${esc(t.table)}">${esc(t.index_name || t.table)}</option>`).join("");
  sel.innerHTML =
    (curatedOpts ? `<optgroup label="Curated — with golden set">${curatedOpts}</optgroup>` : "") +
    `<option value="custom">Other SearchIndex by ID…</option>`;

  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v === "custom") { $("#customWrap").hidden = false; $("#customId").focus(); return; }
    $("#customWrap").hidden = true;
    if (v.startsWith("t:")) loadTable(v.slice(2));
    else if (v.startsWith("i:")) loadCustomIndex(v.slice(2), DISCOVERED.get(v.slice(2)));
  });
  const go = () => loadCustomIndex($("#customId").value.trim());
  $("#loadCustom").addEventListener("click", go);
  $("#customId").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });

  listSearchIndexes(project()).then((rows) => {
    const others = rows.filter((r) => !curatedIds.has(r.id));
    if (!others.length) return;
    others.forEach((r) => DISCOVERED.set(r.id, r.name));
    const og = document.createElement("optgroup");
    og.label = `All SearchIndexes in project (${rows.length})`;
    og.innerHTML = others.map((r) => `<option value="i:${esc(r.id)}">${esc(r.name)}</option>`).join("");
    sel.insertBefore(og, sel.querySelector('option[value="custom"]'));
  }).catch(() => {});
}

async function loadTable(table) {
  setStatus("loading…");
  try {
    const data = await fetch(`data/${table}.json`).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
    $("#indexPick").value = `t:${table}`;
    applyData(data);
  } catch (e) { setStatus(`couldn’t load ${esc(table)} (${esc(e.message)})`, "err"); }
}

async function loadCustomIndex(synId, knownName = null) {
  if (!/^syn\d+$/i.test(synId)) { setStatus("enter a valid synID, e.g. syn75081633", "err"); return; }
  $("#loadCustom").disabled = true;
  setStatus(`discovering ${esc(synId)}…`);
  try {
    const [name, columns] = await Promise.all([
      knownName ? Promise.resolve(knownName) : indexName(synId),
      indexColumns(synId),
    ]);
    if (!columns.length) throw new Error("no columns found — is this a public SearchIndex?");
    applyData({
      index: synId, index_name: name, k: 10, id_field: "rowId",
      fields: generateFieldBoosts(columns), cases: [], precomputed: null, columns, generated: true,
    });
    const sel = $("#indexPick");
    const opt = sel.querySelector(`option[value="i:${synId}"]`);
    sel.value = opt ? `i:${synId}` : "custom";
  } catch (e) {
    setStatus(`couldn’t load ${esc(synId)}: ${esc(e.message)}`, "err");
  } finally { $("#loadCustom").disabled = false; }
}

function updateSearchPlaceholder(data) {
  const examples = (data.cases || []).slice(0, 3).map((c) => c.query).filter(Boolean);
  const ph = examples.length
    ? `Search ${data.index_name} — e.g. ${examples.map((e) => `“${e}”`).join(", ")}…`
    : `Search ${data.index_name}…`;
  $$(".col-q").forEach((el) => { el.placeholder = ph; });
}

// (re)render everything that depends on the loaded index
function applyData(data) {
  DATA = data;
  const golden = data.cases.length ? `${data.cases.length} golden cases` : "no golden set";
  const fields = data.columns
    ? `${data.columns.length} columns (${(data.fields || []).length} boostable)`
    : `${(data.fields || []).length} boostable fields`;
  const gen = data.generated ? ` · <span class="ok">auto-boosts</span>` : "";
  setStatus(`<span class="ok">${esc(data.index_name)}</span> · ${esc(data.index)} · ${fields} · ${golden}${gen}`);
  updateSearchPlaceholder(data);
  $("#sizeInput").value = data.k || 10;

  // Field-lever autocomplete: every discovered column when known, else just the boosted list.
  const fieldSuggestions = data.columns ? data.columns.map((cl) => cl.name) : (data.fields || []).map((f) => f.split("^")[0]);
  const fieldOptionsHtml = fieldSuggestions.map((f) => `<option value="${esc(f)}"></option>`).join("");

  COL_KEYS.forEach((c) => {
    BOOSTS[c] = (data.fields || []).map(parseBoost);
    LEVERS[c] = { ...DEFAULT_LEVERS[c] };
    LAST_RESULT[c] = null;
    LAST_DSL[c] = null;
    $(`#fieldOptions-${c}`).innerHTML = fieldOptionsHtml;
    refreshColumnUI(c);
    $(".results", col(c)).innerHTML = "";
    $(".col-meta", col(c))?.remove();
    $(".query-json", col(c)).hidden = true;
    $(".query-json", col(c)).textContent = "";
    $(".show-query", col(c)).textContent = "Show query";
  });
  $("#compareSummary").hidden = true;
  setBenchMode();
}

// ---------------------------------------------------------------- tabs
function setupTabs() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => { t.classList.toggle("is-active", t === tab); t.setAttribute("aria-selected", t === tab); });
    $$(".panel-tab").forEach((p) => { const on = p.id === tab.dataset.tab; p.classList.toggle("is-active", on); p.hidden = !on; });
  }));
}

// ---------------------------------------------------------------- playground columns
// Types as <optgroup>s for a <select>, in TYPES order — multi-field recipes first, then
// semantic (staging only), then the two single-field families (match-family text queries,
// then term-level exact/pattern queries).
function typeOptionsHtml(types) {
  const byGroup = new Map();
  types.forEach((t) => byGroup.set(t.group, [...(byGroup.get(t.group) || []), t]));
  return [...byGroup].map(([name, items]) =>
    `<optgroup label="${esc(name)}">${items.map((t) => `<option value="${t.key}">${esc(t.name)}</option>`).join("")}</optgroup>`).join("");
}
const optionsHtml = (values) => values.map((v) => `<option value="${v}">${v}</option>`).join("");

function leverRowHtml(c) {
  const help = (k) => esc(LEVER_HELP[k] || "");
  return `
    <div class="lever-grid">
      <label title="${help("type")}">Search type
        <select class="lv-type">${typeOptionsHtml(STAGING ? TYPES : PROD_TYPES)}</select>
      </label>
      <label title="${help("keywordType")}">Keyword leg type
        <select class="lv-kwtype">${typeOptionsHtml(KEYWORD_TYPES)}</select>
      </label>
      <label title="${help("field")}">Field <small>(single-field types)</small>
        <input class="lv-field" type="text" list="fieldOptions-${c}" placeholder="e.g. resourceName">
      </label>
      <label title="${help("operator")}">Operator
        <select class="lv-operator"><option value="">Default (OR)</option><option value="or">OR</option><option value="and">AND</option></select>
      </label>
      <label title="${help("fuzziness")}">Fuzziness
        <select class="lv-fuzziness"><option value="">Off</option><option value="AUTO">AUTO</option><option value="1">1</option><option value="2">2</option></select>
      </label>
      <label title="${help("minimumShouldMatch")}">Min. should match
        <input class="lv-msm" type="text" placeholder="e.g. 75%">
      </label>
      <label title="${help("slop")}">Slop
        <input class="lv-slop" type="number" min="0" max="20" placeholder="0">
      </label>
      <label title="${help("tieBreaker")}">Tie breaker
        <input class="lv-tie" type="number" min="0" max="1" step="0.1" placeholder="0.0">
      </label>
      <label class="lever-check" title="${help("caseInsensitive")}"><input type="checkbox" class="lv-ci"> Case insensitive</label>
      <label title="${help("semanticCutoff")}">Semantic cutoff
        <select class="lv-semcut"><option value="k">Top-k nearest</option><option value="min_score">Min. similarity</option></select>
      </label>
      <label title="${help("semanticCutoffValue")}">Cutoff value
        <input class="lv-semval" type="number" min="0" step="0.05" placeholder="k = results per side">
      </label>
      <label title="${help("pipelineSource")}">Search pipeline
        <select class="lv-pipesrc">
          <option value="inline">Inline</option>
          <option value="ref">Saved pipeline ($ref)</option>
          <option value="default">Index default (none sent)</option>
        </select>
      </label>
      <label title="${help("pipelineRef")}">Pipeline $ref
        <input class="lv-piperef" type="text" spellcheck="false" placeholder="organizationName-name">
      </label>
      <label title="${help("normalization")}">Normalization
        <select class="lv-norm">${optionsHtml(NORMALIZATIONS)}</select>
      </label>
      <label title="${help("combination")}">Combination
        <select class="lv-comb">${optionsHtml(COMBINATIONS)}</select>
      </label>
      <label title="${help("semanticWeight")}">Semantic weight
        <input class="lv-semw" type="number" min="0" max="1" step="0.05" placeholder="0.5">
      </label>
    </div>
    <datalist id="fieldOptions-${c}"></datalist>`;
}

function columnTemplate(c) {
  const openByDefault = c === "B";
  return `
    <form class="col-search">
      <input type="search" class="col-q" placeholder="Search…" aria-label="Search query for column ${c}">
      <button type="submit" class="go">Search</button>
    </form>
    <div class="col-head">
      <div class="col-headline">
        <span class="boost-ref"></span>
        <button type="button" class="show-query link-btn">Show query</button>
      </div>
    </div>
    <pre class="query-json" hidden></pre>
    <details class="col-levers"${openByDefault ? " open" : ""}>
      <summary>Levers &amp; field boosts</summary>
      ${leverRowHtml(c)}
      <label class="boost-toggle-row" title="${esc(LEVER_HELP.useBoosts)}">
        <input type="checkbox" class="lv-boosts"> Use field boosts <small>(off by default)</small>
      </label>
      <p class="adv-note">
        A boost multiplies how much a match in that field counts toward the score — a higher
        number floats matches in that field to the top. Off (the default): the multi-field
        types search every field on the index, same as Default site search. On: the query is
        restricted to just the fields below, weighted as shown. Only the
        <strong>multi-field</strong> search types can use them; the single-field types use the
        <strong>Field</strong> input instead and check exactly that one column. Index-side
        settings (analyzers, synonyms) need an admin rebuild and aren’t adjustable here.
      </p>
      <details class="type-note">
        <summary>
          <svg class="disclosure-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          Which column types can be boosted?
        </summary>
        <p>
          Only free-text columns are eligible match targets: <code>STRING</code>, <code>STRING_LIST</code>,
          <code>LARGETEXT</code>, <code>MEDIUMTEXT</code>. Everything else — <code>ENTITYID</code>, <code>DATE</code>,
          <code>INTEGER</code>, <code>DOUBLE</code>, <code>BOOLEAN</code>, <code>FILEHANDLEID</code>, <code>USERID</code>,
          and their <code>*_LIST</code> variants — isn’t text to match against, so it's left out automatically. This
          only applies to auto-discovered indexes; curated tables ship a hand-picked field list.
        </p>
      </details>
      <div class="boost-editor"></div>
      <div class="adv-row"><button type="button" class="link-btn reset-boosts">Reset boosts to 1</button></div>
    </details>
    <ul class="results"></ul>`;
}

// disable lever inputs OpenSearch would ignore for the currently selected type, so users
// can't be misled into thinking an inert value is doing something. The keyword levers
// follow the keyword leg's type when the selected type is a hybrid. The semantic and hybrid
// levers are hidden, not disabled, outside their own types.
function applyLeverAvailability(colEl, levers) {
  const type = keywordLeverType(levers);
  const set = (selector, supported) => {
    const el = $(selector, colEl);
    el.disabled = !supported;
    el.closest("label").classList.toggle("is-off", !supported);
  };
  const show = (selector, supported) => { $(selector, colEl).closest("label").hidden = !supported; };
  set(".lv-field", LEVER_SUPPORT.field.has(type));
  set(".lv-operator", LEVER_SUPPORT.operator.has(type));
  set(".lv-fuzziness", LEVER_SUPPORT.fuzziness.has(type));
  set(".lv-msm", LEVER_SUPPORT.minimumShouldMatch.has(type));
  set(".lv-slop", LEVER_SUPPORT.slop.has(type));
  set(".lv-tie", LEVER_SUPPORT.tieBreaker.has(type));
  set(".lv-ci", LEVER_SUPPORT.caseInsensitive.has(type));
  set(".lv-boosts", LEVER_SUPPORT.boosts.has(type));
  show(".lv-semcut", LEVER_SUPPORT.semanticCutoff.has(levers.type));
  show(".lv-semval", LEVER_SUPPORT.semanticCutoff.has(levers.type));
  show(".lv-kwtype", LEVER_SUPPORT.keywordType.has(levers.type));
  // The pipeline levers only build an inline pipeline, so they're hidden for a $ref or none.
  const inline = (levers.pipelineSource || "inline") === "inline";
  show(".lv-pipesrc", LEVER_SUPPORT.pipelineSource.has(levers.type));
  show(".lv-piperef", LEVER_SUPPORT.pipelineSource.has(levers.type) && levers.pipelineSource === "ref");
  show(".lv-norm", LEVER_SUPPORT.pipeline.has(levers.type) && inline);
  show(".lv-comb", LEVER_SUPPORT.pipeline.has(levers.type) && inline);
  show(".lv-semw", LEVER_SUPPORT.semanticWeight.has(levers.type) && inline);
  // A semantic-only query has one clause, so an inline pipeline has nothing to set.
  $(".lv-pipesrc option[value=inline]", colEl).textContent = LEVER_SUPPORT.pipeline.has(levers.type)
    ? "Inline (normalization & weight)" : "Inline (defaults; one clause, nothing to weight)";
  const allowed = combinationsFor(levers.normalization || NORMALIZATIONS[0]);
  $$(".lv-comb option", colEl).forEach((o) => { o.disabled = !allowed.includes(o.value); });
}

function renderBoostEditor(c) {
  const boostsActive = LEVER_SUPPORT.boosts.has(keywordLeverType(LEVERS[c])) && LEVERS[c].useBoosts;
  $(".boost-editor", col(c)).innerHTML = BOOSTS[c].map((b, i) =>
    `<label class="boost-field"><code>${esc(b.field)}</code>
       <input type="number" min="0" max="20" step="1" value="${b.boost}" data-i="${i}"${boostsActive ? "" : " disabled"}></label>`).join("");
}

// Push LEVERS[c]/BOOSTS[c] state out to the DOM — used both at setup and whenever a new
// index is loaded (resetting both columns to their defaults).
function refreshColumnUI(c) {
  const colEl = col(c);
  const lv = LEVERS[c];
  $(".lv-type", colEl).value = lv.type;
  $(".lv-field", colEl).value = lv.field || "";
  $(".lv-operator", colEl).value = lv.operator || "";
  $(".lv-fuzziness", colEl).value = lv.fuzziness || "";
  $(".lv-msm", colEl).value = lv.minimumShouldMatch || "";
  $(".lv-slop", colEl).value = lv.slop ?? "";
  $(".lv-tie", colEl).value = lv.tieBreaker ?? "";
  $(".lv-ci", colEl).checked = !!lv.caseInsensitive;
  $(".lv-boosts", colEl).checked = !!lv.useBoosts;
  $(".lv-semcut", colEl).value = lv.semanticCutoff || "k";
  $(".lv-semval", colEl).value = lv.semanticCutoffValue ?? "";
  $(".lv-kwtype", colEl).value = lv.keywordType || DEFAULT_KEYWORD_LEG;
  $(".lv-norm", colEl).value = lv.normalization || NORMALIZATIONS[0];
  $(".lv-comb", colEl).value = lv.combination || COMBINATIONS[0];
  $(".lv-semw", colEl).value = lv.semanticWeight ?? "";
  $(".lv-pipesrc", colEl).value = lv.pipelineSource || "inline";
  $(".lv-piperef", colEl).value = lv.pipelineRef || "";
  applyLeverAvailability(colEl, lv);
  renderBoostEditor(c);
  const boosted = LEVER_SUPPORT.boosts.has(keywordLeverType(lv)) && lv.useBoosts;
  const ref = $(".boost-ref", colEl);
  ref.textContent = boosted ? "boosts applied" : "boosts off";
  ref.classList.toggle("is-boosted", boosted);
}

function setupColumns() {
  COL_KEYS.forEach((c) => {
    const colEl = col(c);
    colEl.innerHTML = columnTemplate(c);
    LEVERS[c] = { ...DEFAULT_LEVERS[c] };

    const readLevers = () => ({
      type: $(".lv-type", colEl).value,
      field: $(".lv-field", colEl).value.trim() || undefined,
      operator: $(".lv-operator", colEl).value || undefined,
      fuzziness: $(".lv-fuzziness", colEl).value || undefined,
      minimumShouldMatch: $(".lv-msm", colEl).value.trim() || undefined,
      slop: $(".lv-slop", colEl).value,
      tieBreaker: $(".lv-tie", colEl).value,
      caseInsensitive: $(".lv-ci", colEl).checked,
      useBoosts: $(".lv-boosts", colEl).checked,
      semanticCutoff: $(".lv-semcut", colEl).value,
      semanticCutoffValue: $(".lv-semval", colEl).value,
      keywordType: $(".lv-kwtype", colEl).value,
      normalization: $(".lv-norm", colEl).value,
      combination: $(".lv-comb", colEl).value,
      semanticWeight: $(".lv-semw", colEl).value,
      pipelineSource: $(".lv-pipesrc", colEl).value,
      pipelineRef: $(".lv-piperef", colEl).value,
    });
    const onLeverChange = () => {
      // switching into a single-field type with no field chosen yet — default to the
      // top-boosted field rather than leaving it empty (buildQuery would send field: "").
      const type = keywordLeverType({ type: $(".lv-type", colEl).value, keywordType: $(".lv-kwtype", colEl).value });
      const fieldInput = $(".lv-field", colEl);
      if (LEVER_SUPPORT.field.has(type) && !fieldInput.value.trim()) fieldInput.value = BOOSTS[c][0]?.field || "";
      // Selecting the editable copy of Default site search should start out an actual
      // copy — reset the levers it exposes to the frozen baseline's fixed values instead
      // of leaving behind whatever the previously selected type had set.
      // A row count and a 0–1 similarity floor aren't interchangeable — carrying "10" over
      // from top-k into min. similarity would ask for hits above similarity 10, i.e. none.
      // Clear it on a mode switch so each mode's own default applies.
      const cutoffMode = $(".lv-semcut", colEl).value;
      if (cutoffMode !== (LEVERS[c].semanticCutoff || "k")) $(".lv-semval", colEl).value = "";
      if (type === "frontend_default_tunable" && keywordLeverType(LEVERS[c]) !== "frontend_default_tunable") {
        $(".lv-operator", colEl).value = "";
        $(".lv-fuzziness", colEl).value = "AUTO";
        $(".lv-msm", colEl).value = "";
        $(".lv-tie", colEl).value = "";
        $(".lv-boosts", colEl).checked = false;
      }
      const allowed = combinationsFor($(".lv-norm", colEl).value);
      if (!allowed.includes($(".lv-comb", colEl).value)) $(".lv-comb", colEl).value = allowed[0];
      LEVERS[c] = readLevers();
      applyLeverAvailability(colEl, LEVERS[c]);
      refreshColumnUI(c);
      if (LAST_RESULT[c]) runColumn(c);
      else if (!$(".query-json", colEl).hidden) updateQueryPreview(c);
    };
    $(".lv-type", colEl).addEventListener("change", onLeverChange);
    $(".lv-field", colEl).addEventListener("input", onLeverChange);
    $(".lv-operator", colEl).addEventListener("change", onLeverChange);
    $(".lv-fuzziness", colEl).addEventListener("change", onLeverChange);
    $(".lv-msm", colEl).addEventListener("input", onLeverChange);
    $(".lv-slop", colEl).addEventListener("input", onLeverChange);
    $(".lv-tie", colEl).addEventListener("input", onLeverChange);
    $(".lv-ci", colEl).addEventListener("change", onLeverChange);
    $(".lv-boosts", colEl).addEventListener("change", onLeverChange);
    $(".lv-semcut", colEl).addEventListener("change", onLeverChange);
    $(".lv-semval", colEl).addEventListener("input", onLeverChange);
    $(".lv-kwtype", colEl).addEventListener("change", onLeverChange);
    $(".lv-norm", colEl).addEventListener("change", onLeverChange);
    $(".lv-comb", colEl).addEventListener("change", onLeverChange);
    $(".lv-semw", colEl).addEventListener("input", onLeverChange);
    $(".lv-pipesrc", colEl).addEventListener("change", onLeverChange);
    $(".lv-piperef", colEl).addEventListener("input", onLeverChange);

    $(".boost-editor", colEl).addEventListener("input", (e) => {
      const i = e.target.dataset.i;
      if (i != null) BOOSTS[c][i].boost = Math.max(0, Number(e.target.value) || 0);
      if (!$(".query-json", colEl).hidden) updateQueryPreview(c);
    });
    $(".reset-boosts", colEl).addEventListener("click", () => {
      BOOSTS[c] = BOOSTS[c].map(({ field }) => ({ field, boost: 1 }));
      renderBoostEditor(c);
      if (!$(".query-json", colEl).hidden) updateQueryPreview(c);
    });

    $(".col-search", colEl).addEventListener("submit", (e) => { e.preventDefault(); runColumn(c); });

    $(".col-q", colEl).addEventListener("input", () => {
      if (!$(".query-json", colEl).hidden) updateQueryPreview(c);
    });

    $(".show-query", colEl).addEventListener("click", () => {
      const pre = $(".query-json", colEl);
      const showing = pre.hidden;
      if (showing) updateQueryPreview(c);
      pre.hidden = !showing;
      $(".show-query", colEl).textContent = pre.hidden ? "Show query" : "Hide query";
    });

    $(".results", colEl).addEventListener("click", (e) => {
      if (e.target.closest(".next-page")) { nextPage(c); return; }
      const btn = e.target.closest(".hit-expand");
      if (!btn) return;
      const detail = $(".hit-detail", btn.closest(".hit"));
      const opening = detail.hidden;
      detail.hidden = !opening;
      btn.setAttribute("aria-expanded", String(opening));
      btn.textContent = opening ? "Hide all fields ▴" : "Show all fields ▾";
    });

    refreshColumnUI(c);
  });

  $("#sizeInput").addEventListener("input", () => {
    COL_KEYS.forEach((c) => { if (!$(".query-json", col(c)).hidden) updateQueryPreview(c); });
  });
}

// ---------------------------------------------------------------- playground search
// Builds the DSL from the column's current query text/size/levers/boosts and refreshes
// the (possibly already-visible) query-json preview — live as the box is typed into, not
// just a snapshot of the last executed search.
function updateQueryPreview(c) {
  const colEl = col(c);
  const q = $(".col-q", colEl).value.trim();
  const size = Math.max(1, Number($("#sizeInput").value) || 10);
  LAST_DSL[c] = buildQuery(q, size, buildFields(c), LEVERS[c]);
  $(".query-json", colEl).textContent = JSON.stringify(LAST_DSL[c], null, 2);
}

async function runColumn(c) {
  const colEl = col(c);
  const q = $(".col-q", colEl).value.trim();
  if (!q || !DATA) return;
  if (LEVERS[c].pipelineSource === "ref" && !(LEVERS[c].pipelineRef || "").trim()) {
    LAST_RESULT[c] = { error: "Enter a Pipeline $ref ({organizationName}-{name}), or pick another Search pipeline." };
    renderAll();
    return;
  }
  const size = Math.max(1, Number($("#sizeInput").value) || 10);
  const fields = buildFields(c);
  const dsl = buildQuery(q, size, fields, LEVERS[c]);
  LAST_DSL[c] = dsl;
  $(".query-json", colEl).textContent = JSON.stringify(dsl, null, 2);
  $(".results", colEl).innerHTML = `<li class="loading">searching…</li>`;
  $(".go", colEl).disabled = true;

  const seq = ++SEQ[c];
  let result;
  try {
    const res = await search(DATA.index, dsl, { responseParts: ["HITS", "TOTAL_HITS"] });
    result = { hits: res.hits || [], total: res.totalHits, next: res.nextSearchAfter, pages: 1 };
  } catch (err) {
    result = { error: err.message };
  }
  if (seq !== SEQ[c]) return;
  LAST_RESULT[c] = result;
  $(".go", colEl).disabled = false;
  renderAll();
}

// Fetch the page after the last one shown — the same DSL plus the previous response's
// nextSearchAfter cursor — and append its hits, so paging can be checked for rows that
// repeat or go missing across pages.
async function nextPage(c) {
  const prev = LAST_RESULT[c];
  const dsl = { ...LAST_DSL[c], search_after: prev.next };
  $(".query-json", col(c)).textContent = JSON.stringify(dsl, null, 2);
  $(".next-page", col(c)).disabled = true;
  const seq = ++SEQ[c];
  let result;
  try {
    const res = await search(DATA.index, dsl, { responseParts: ["HITS", "TOTAL_HITS"] });
    result = { ...prev, hits: [...prev.hits, ...(res.hits || [])], next: res.hits?.length ? res.nextSearchAfter : null, pages: prev.pages + (res.hits?.length ? 1 : 0) };
  } catch (err) {
    result = { error: `page ${prev.pages + 1}: ${err.message}` };
  }
  if (seq !== SEQ[c]) return;
  LAST_RESULT[c] = result;
  renderAll();
}

function rankMap(result) {
  const m = new Map();
  if (result && result.hits) result.hits.forEach((h, i) => m.set(hitId(h, DATA.id_field), i + 1));
  return m;
}

function renderAll() {
  const other = { A: "B", B: "A" };
  COL_KEYS.forEach((c) => {
    const r = LAST_RESULT[c];
    if (!r) return;
    renderColumn({ col: col(c), ...r }, rankMap(LAST_RESULT[other[c]]));
  });
  renderCompareSummary();
}

function columnLabel(c) {
  const lv = LEVERS[c];
  const bits = [typeName(lv.type)];
  if (LEVER_SUPPORT.keywordType.has(lv.type)) bits.push(typeName(keywordLeverType(lv)), `${lv.normalization} + ${lv.combination}`);
  if (lv.operator) bits.push(lv.operator.toUpperCase());
  if (lv.fuzziness) bits.push(`fuzzy ${lv.fuzziness}`);
  return bits.join(" · ");
}

// How much the two columns' result sets overlap (shown above the comparison).
function renderCompareSummary() {
  const box = $("#compareSummary");
  const a = LAST_RESULT.A, b = LAST_RESULT.B;
  if (!a || !b || a.error || b.error || !a.hits?.length || !b.hits?.length) { box.hidden = true; return; }
  const A = rankMap(a), B = rankMap(b);
  const labels = [columnLabel("A"), columnLabel("B")];
  const shared = [...A.keys()].filter((id) => B.has(id));
  const sameSpot = shared.filter((id) => A.get(id) === B.get(id)).length;
  const onlyA = A.size - shared.length;
  const onlyB = B.size - shared.length;
  const n = Math.max(A.size, B.size);
  const stat = (v, label) => `<span class="cs-stat"><b>${v}</b> ${label}</span>`;
  box.hidden = false;
  box.innerHTML =
    `<span class="cs-lead">${shared.length} of ${n} results in common</span>` +
    stat(sameSpot, "in the same position") +
    stat(onlyA, `only in <em>${esc(labels[0])}</em>`) +
    stat(onlyB, `only in <em>${esc(labels[1])}</em>`);
}

function renderColumn({ col: colEl, hits, total, error, next, pages }, otherRanks) {
  const ul = $(".results", colEl);
  let meta = $(".col-meta", colEl);
  if (!meta) { meta = document.createElement("p"); meta.className = "col-meta"; $(".col-head", colEl).appendChild(meta); }
  if (error) { ul.innerHTML = `<li class="errbox">Query failed: ${esc(error)}</li>`; meta.textContent = ""; return; }
  const dupes = hits.length - new Set(hits.map((h) => h.rowId)).size;
  meta.textContent = `${hits.length} shown · ${total ?? "?"} total matches` +
    (pages > 1 ? ` · ${pages} pages` : "") + (dupes ? ` · ⚠ ${dupes} rows repeated across pages` : "");
  if (!hits.length) { ul.innerHTML = `<li class="empty">No results.</li>`; return; }

  ul.innerHTML = hits.map((h, i) => {
    const d = hitDict(h);
    const rank = i + 1;
    const id = hitId(h, DATA.id_field);
    const delta = deltaBadge(rank, otherRanks.get(id));
    const name = pick(d, NAME_KEYS) || `(row ${esc(h.rowId ?? "?")})`;
    const type = pick(d, TYPE_KEYS);
    const desc = pick(d, DESC_KEYS);
    const isTools = DATA.index === TOOLS_INDEX;
    const typeChip = type ? `<span class="chip type-chip">${isTools ? toolTypeIcon(type) : ""}${esc(type)}</span>` : "";
    const chips = [typeChip, d.rrid ? `<span class="chip">${esc(d.rrid)}</span>` : ""].join("");
    return `<li class="hit" style="animation-delay:${i * 28}ms">
      <span class="rank">${rank}</span>${delta}
      <div class="name">${esc(name)}</div>
      <div class="sub">${chips}<span class="score">score ${fmtScore(h.score)}</span></div>
      ${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
      <div class="rid">${esc(id ?? "")}</div>
      <button type="button" class="hit-expand" aria-expanded="false">Show all fields ▾</button>
      ${hitDetailHtml(h, d)}
    </li>`;
  }).join("") + (next ? `<li class="more"><button type="button" class="next-page mini-go">Next page</button></li>` : "");
}

// Every field the hit actually carries (not just the curated name/type/desc subset above)
// — shown on demand so a comparison can be checked against the row's full data.
function hitDetailHtml(h, d) {
  const rows = Object.entries(d)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<div class="field-row"><span class="field-name">${esc(k)}</span><span class="field-value">${esc(Array.isArray(v) ? v.join(", ") : v)}</span></div>`)
    .join("");
  const scoreRow = `<div class="field-row"><span class="field-name">score</span><span class="field-value">${fmtScore(h.score)}</span></div>`;
  const rowIdRow = h.rowId != null ? `<div class="field-row"><span class="field-name">rowId</span><span class="field-value">${esc(h.rowId)}</span></div>` : "";
  return `<div class="hit-detail" hidden>${rowIdRow}${scoreRow}${rows}</div>`;
}

function deltaBadge(rank, oRank) {
  if (oRank == null) return "";
  const diff = oRank - rank;
  if (diff === 0) return `<span class="delta same" title="same position">=</span>`;
  return `<span class="delta ${diff > 0 ? "up" : "down"}" title="vs other side">${diff > 0 ? "▲" : "▼"}${Math.abs(diff)}</span>`;
}
const fmtScore = (s) => (typeof s === "number" ? s.toFixed(2) : "—");

// ---------------------------------------------------------------- benchmark
function setupBenchmarkControls() {
  const picker = $("#stratPicker");
  picker.insertAdjacentHTML("beforeend", `<div class="strat-grid">${STRATEGY_ORDER.map((k) =>
    `<label class="strat-chip on"><input type="checkbox" value="${k}" checked>${esc(strategyLabel(k).name)}</label>`).join("")}</div>`);
  picker.addEventListener("change", (e) => { e.target.closest(".strat-chip")?.classList.toggle("on", e.target.checked); updateEstimate(); });
  $("#runBench").addEventListener("click", runBenchmark);
}

// enable/disable benchmarking for the loaded index (needs a golden set)
function setBenchMode() {
  const hasGolden = DATA.cases.length > 0;
  $(".bench-controls").hidden = !hasGolden;
  $("#benchProgress").hidden = true;
  $("#benchResult").innerHTML = "";
  const notice = $("#benchNotice");
  notice.hidden = hasGolden;
  if (!hasGolden) {
    notice.innerHTML =
      `<svg class="notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
            stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.8 5.8l12.4 12.4"/></svg>
       <span>No golden set for <strong>${esc(DATA.index_name)}</strong> — benchmarking needs curated
       queries with known-correct results. Try the <strong>Search playground</strong> instead.</span>`;
    return;
  }
  updateEstimate();
  if (DATA.precomputed) {
    const bench = { ...DATA.precomputed, k: DATA.precomputed.k || DATA.k, live: false };
    renderBench(bench, `Showing the precomputed baseline (${esc(DATA.precomputed.label || "baseline")}). Run live to recompute with your boost settings.`);
  }
}

const selectedStrategies = () => $$('#stratPicker input:checked').map((i) => i.value);
function updateEstimate() {
  const n = selectedStrategies().length * (DATA?.cases.length || 0);
  $("#benchEst").textContent = n ? `${n} queries (~${Math.ceil(n / 6)}s)` : "select at least one recipe";
}

async function runBenchmark() {
  const keys = selectedStrategies();
  if (!keys.length || !DATA.cases.length) return;
  const k = DATA.k || 10;
  const size = Math.max(k, 10);
  // benchmark scoring uses column A's boost configuration (the benchmark tab isn't a
  // side-by-side comparison — it scores one configuration against the golden set).
  const fields = buildFields("A");
  const tasks = [];
  keys.forEach((sk) => DATA.cases.forEach((c) => tasks.push({ sk, c })));

  const acc = Object.fromEntries(keys.map((sk) => [sk, { caseScores: [], rts: [], perCase: {} }]));
  $("#benchProgress").hidden = false;
  $("#runBench").disabled = true;
  let done = 0;
  const tick = () => {
    const pct = Math.round((done / tasks.length) * 100);
    $("#progressFill").style.width = `${pct}%`;
    $("#progressText").textContent = `${done} / ${tasks.length} queries · ${pct}%`;
  };
  tick();

  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const { sk, c } = tasks[cursor++];
      const t0 = performance.now();
      let ranked = [];
      try {
        const res = await search(DATA.index, STRATEGIES[sk](c.query, size, fields), { responseParts: ["HITS", "TOTAL_HITS"] });
        ranked = (res.hits || []).map((h) => hitId(h, DATA.id_field));
      } catch { /* terminal failure → counts as a miss */ }
      const rt = performance.now() - t0;
      const sc = scoreCase(ranked, c.relevant, k);
      sc.rt_ms = rt;
      acc[sk].caseScores.push(sc); acc[sk].rts.push(rt); acc[sk].perCase[c.id] = sc;
      done++; tick();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const strategies = {}, per_case = {};
  keys.forEach((sk) => { strategies[sk] = aggregate(acc[sk].caseScores, acc[sk].rts); per_case[sk] = acc[sk].perCase; });
  const bench = { strategies, per_case, k, live: true };
  $("#benchProgress").hidden = true;
  $("#runBench").disabled = false;
  renderBench(bench, `Live run · ${tasks.length} queries against ${esc(DATA.index_name)} · k=${k}.`);
}

// `reverse` flips the metric's natural "best first" direction — toggled by clicking the
// already-sorted column again, so a second click does something instead of re-sorting
// into the exact same order.
let sortState = { key: "mrr", reverse: false };
function renderBench(bench, note) {
  const k = bench.k;
  const rows = Object.entries(bench.strategies);
  const dir = (key) => (METRIC_LABELS[key].dir === "up" ? -1 : 1) * (sortState.reverse ? -1 : 1);
  rows.sort((a, b) => (a[1][sortState.key] - b[1][sortState.key]) * dir(sortState.key));

  const best = {};
  METRIC_KEYS.forEach((key) => {
    const vals = rows.map((r) => r[1][key]).filter((v) => typeof v === "number");
    best[key] = METRIC_LABELS[key].dir === "up" ? Math.max(...vals) : Math.min(...vals);
  });

  const head = METRIC_KEYS.map((key) => {
    const m = METRIC_LABELS[key];
    const cls = sortState.key === key ? `sorted${sortState.reverse ? " reverse" : ""}` : "";
    return `<th data-key="${key}" title="${esc(m.help)}" class="${cls}">${esc(m.name.replace("@k", `@${k}`))}</th>`;
  }).join("");

  const body = rows.map(([name, a]) => {
    const cells = METRIC_KEYS.map((key) => {
      const v = a[key] ?? 0;
      const isBest = typeof v === "number" && Math.abs(v - best[key]) < 1e-9;
      const txt = key.startsWith("rt_ms") ? Math.round(v) : v.toFixed(3);
      return `<td class="metric ${isBest ? "best" : ""}">${txt}</td>`;
    }).join("");
    return `<tr><td class="stratname">${esc(strategyLabel(name).name)}<small>${esc(name)}</small></td>${cells}</tr>`;
  }).join("");

  $("#benchResult").innerHTML =
    `<h2>Scoreboard</h2>
     <table class="scoreboard">
       <thead><tr><th>Recipe</th>${head}</tr></thead>
       <tbody>${body}</tbody>
     </table>
     <p class="score-note">${note}
       <svg class="note-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
       marks the best recipe per column. Click a column header to re-sort.</p>
     ${bench.per_case ? casesSection(bench) : ""}`;

  $$(".scoreboard thead th[data-key]").forEach((th) => th.addEventListener("click", () => {
    sortState.reverse = sortState.key === th.dataset.key ? !sortState.reverse : false;
    sortState.key = th.dataset.key;
    renderBench(bench, note);
  }));
}

function casesSection(bench) {
  const keys = Object.keys(bench.strategies);
  const head = keys.map((k) => `<th title="${esc(k)}">${esc(strategyLabel(k).name)}</th>`).join("");
  const rows = DATA.cases.map((c) => {
    const cells = keys.map((sk) => {
      const r = bench.per_case[sk]?.[c.id]?.first_rel_rank;
      return `<td class="${rankClass(r)}">${r ? `<span class="rankcell ${rankClass(r)}">${r}</span>` : "—"}</td>`;
    }).join("");
    return `<tr><td class="q">${esc(c.query)}<br><small>${esc(c.type || "")}</small></td>${cells}</tr>`;
  }).join("");
  return `<details class="cases-toggle"><summary>Per-case detail — rank of the first correct result (lower is better)</summary>
    <div style="overflow:auto"><table class="case-table">
      <thead><tr><th>Query</th>${head}</tr></thead><tbody>${rows}</tbody>
    </table></div></details>`;
}
const rankClass = (r) => (!r ? "miss" : r === 1 ? "r1" : r <= 3 ? "good" : r <= 10 ? "mid" : "miss");
