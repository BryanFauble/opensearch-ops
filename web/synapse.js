// Browser port of query.py — run an async SearchIndex query against a Synapse repo API
// and return the SearchQueryResults.
//
// Defaults to repo-prod, where CORS is open (access-control-allow-origin: *) and the
// portal indexes are public, so it works anonymously straight from a static page.
// `configure()` repoints it at repo-staging, which runs the next release against the same
// data — the place in-development search features (hybrid / semantic) are live first.
//
// Keep this in sync with query.py (search / hit_dict). The async job pattern is identical:
//   POST search/query/async/start  -> { token }
//   GET  search/query/async/get/{token}  -> 202 / jobState:PROCESSING while running, else results

export const ENDPOINTS = {
  prod: "https://repo-prod.prod.sagebase.org/repo/v1",
  staging: "https://repo-staging.prod.sagebase.org/repo/v1",
};

let BASE = ENDPOINTS.prod;
let AUTH_TOKEN = null;

// Point every call in this module at a Synapse environment (a key of ENDPOINTS) and/or
// attach a bearer token (a personal access token). An empty/unknown value resets that half
// to the default.
export function configure({ env, token } = {}) {
  BASE = ENDPOINTS[env] || ENDPOINTS.prod;
  AUTH_TOKEN = token || null;
}

// The per-call token wins over the configured one, so a caller can still override it.
const authHeaders = (token) => {
  const t = token || AUTH_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run one query. `searchQuery` is raw OpenSearch DSL, e.g.
//   { query: { multi_match: { query: "schwann", fields: ["resourceName^5"] } }, size: 10 }
export async function search(searchIndexId, searchQuery, {
  responseParts = ["HITS", "TOTAL_HITS", "SELECT_COLUMNS"],
  timeoutMs = 30000,
  pollMs = 150,
  token = null,
  signal = null,
} = {}) {
  const headers = { "Content-Type": "application/json", ...authHeaders(token) };

  const payload = {
    concreteType: "org.sagebionetworks.repo.model.search.table.SearchIndexQuery",
    searchIndexId,
    searchQuery,
  };
  if (responseParts) payload.responseParts = responseParts;

  const startRes = await fetch(`${BASE}/search/query/async/start`, {
    method: "POST", headers, body: JSON.stringify(payload), signal,
  });
  if (startRes.status !== 200 && startRes.status !== 201) {
    // The body carries why it was refused — the DSL validator's message, or for a semantic
    // query things like an index built without vectors. Without it a 400 is unreadable.
    const body = await startRes.json().catch(() => ({}));
    throw new Error(`start failed (${startRes.status})${body.reason ? `: ${body.reason}` : ""}`);
  }
  const { token: jobToken } = await startRes.json();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const getRes = await fetch(`${BASE}/search/query/async/get/${jobToken}`, { headers, signal });
    if (getRes.status === 202) { await sleep(pollMs); continue; }
    const body = await getRes.json().catch(() => ({}));
    if (body && body.jobState === "PROCESSING") { await sleep(pollMs); continue; }
    if (getRes.status >= 400) {
      throw new Error(`query failed (${getRes.status}): ${body.reason || JSON.stringify(body)}`);
    }
    return body;
  }
  throw new Error(`query did not complete within ${timeoutMs}ms`);
}

// The SearchIndex entity's display name (e.g. "nf-studies"); falls back to the synId.
export async function indexName(searchIndexId, { token = null } = {}) {
  const headers = authHeaders(token);
  try {
    const res = await fetch(`${BASE}/entity/${searchIndexId}`, { headers });
    if (res.ok) return (await res.json()).name || searchIndexId;
  } catch { /* fall through */ }
  return searchIndexId;
}

// List every SearchIndex entity under a project, paging through entity/children.
// Returns [{ id, name }] sorted by name. Anonymous on repo-prod (those objects are public);
// a project on another stack may need the configured token.
export async function listSearchIndexes(parentId, { token = null } = {}) {
  const headers = { "Content-Type": "application/json", ...authHeaders(token) };
  const out = [];
  let nextPageToken = null;
  for (let guard = 0; guard < 20; guard++) {  // page cap — safety against a runaway token
    const body = { parentId, includeTypes: ["searchindex"], sortBy: "NAME", sortDirection: "ASC" };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await fetch(`${BASE}/entity/children`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`children failed (${res.status})`);
    const data = await res.json();
    for (const h of data.page || []) out.push({ id: h.id, name: h.name });
    nextPageToken = data.nextPageToken || null;
    if (!nextPageToken) break;
  }
  return out;
}

// Discover an index's columns: [{ name, columnType }]. Runs a match_all asking only for
// SELECT_COLUMNS — the basis for auto-generating a field-boost config (see boostgen.js).
export async function indexColumns(searchIndexId, opts = {}) {
  const res = await search(searchIndexId, { query: { match_all: {} }, size: 0 },
    { responseParts: ["SELECT_COLUMNS"], ...opts });
  return (res.selectColumns || []).map((c) => ({ name: c.name, columnType: c.columnType }));
}

// Flatten a SearchHit's field array into a { column: value } object.
export function hitDict(hit) {
  const out = {};
  for (const f of hit.fields || []) out[f.name] = f.value;
  return out;
}

// The stable identifier for a hit, per the golden's id_field (mirrors run.py hit_id):
// "rowId" keys on the index's own per-row id; otherwise pull the named column.
export function hitId(hit, idField) {
  return idField === "rowId" ? hit.rowId : hitDict(hit)[idField];
}
