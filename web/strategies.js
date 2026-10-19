// Browser port of benchmark/strategies.py — query builders mapping
// (queryText, size, fields) -> a raw OpenSearch searchQuery DSL object.
//
// MUST stay in sync with benchmark/strategies.py for the STRATEGIES exports below (used
// by the Benchmark tab). The standing guard is the benchmark parity check: the live
// scoreboard's per-strategy MRR/Recall/Hit must match `python3 benchmark/run.py tools`
// within rounding (see README / plan).
//
// The playground (side-by-side comparison) no longer picks from a fixed recipe list —
// `buildQuery()` exposes every lever (type, operator, fuzziness, minimum_should_match,
// slop, tie_breaker, field boosts) independently, since that's what a real comparison
// needs. STRATEGIES below are just fixed lever combos, kept for the benchmark's golden-set
// scoring where a small, stable, named set is what you want to track over time.
//
// All clauses use the verbose object form (Synapse's JSON adapter rejects shorthand).

// Drop the `^weight` so a query matches all fields equally.
function unboosted(fields) {
  return fields.map((f) => f.split("^", 1)[0]);
}

// Every "search type" the playground can build, grouped for the type select. The first
// group matches against the whole boosted field list; the other two check exactly one
// field (named by the `field` lever) — the classic single-column MATCH shape, and the
// term-level exact/pattern family (term/terms/prefix/wildcard/fuzzy), which is how
// "exact keyword" search (the `.keyword` sub-field case) and typed wildcard patterns work.
//
// The vector field a SearchIndex exposes once at least one of its columns is flagged
// `semantic` on a ColumnAnalyzerOverrideEntry. It is not a column of the source table and is
// never returned on a hit, so it isn't in the discovered column list either.
const SEMANTIC_FIELD = "semantic_search";

export const TYPES = [
  { key: "frontend_default", name: "Default site search", group: "Multi-field (boosted fields list)" },
  { key: "frontend_default_tunable", name: "Default site search (editable)", group: "Multi-field (boosted fields list)" },
  { key: "simple_query_string", name: "Google-style (simple_query_string)", group: "Multi-field (boosted fields list)" },
  { key: "query_string", name: "Lucene syntax (query_string)", group: "Multi-field (boosted fields list)" },
  { key: "best_fields", name: "Multi-match — best field", group: "Multi-field (boosted fields list)" },
  { key: "most_fields", name: "Multi-match — most fields", group: "Multi-field (boosted fields list)" },
  { key: "cross_fields", name: "Multi-match — cross fields", group: "Multi-field (boosted fields list)" },
  { key: "phrase", name: "Multi-match — exact phrase", group: "Multi-field (boosted fields list)" },
  { key: "phrase_prefix", name: "Multi-match — as-you-type", group: "Multi-field (boosted fields list)" },
  { key: "bool_prefix", name: "Multi-match — bool prefix", group: "Multi-field (boosted fields list)" },
  { key: "semantic", name: "Semantic — vector similarity", group: "Semantic (vector)" },
  { key: "hybrid_semantic", name: "Hybrid — keyword + semantic", group: "Semantic (vector)" },
  { key: "match", name: "Match", group: "Single field — text" },
  { key: "match_phrase", name: "Match phrase", group: "Single field — text" },
  { key: "match_phrase_prefix", name: "Match phrase prefix — as-you-type", group: "Single field — text" },
  { key: "match_bool_prefix", name: "Match bool prefix", group: "Single field — text" },
  { key: "term", name: "Term — exact value", group: "Single field — exact / pattern" },
  { key: "terms", name: "Terms — any of several exact values (comma-separated)", group: "Single field — exact / pattern" },
  { key: "prefix", name: "Prefix", group: "Single field — exact / pattern" },
  { key: "wildcard", name: "Wildcard — supports * and ?", group: "Single field — exact / pattern" },
  { key: "fuzzy", name: "Fuzzy — edit-distance match", group: "Single field — exact / pattern" },
  { key: "match_all", name: "Match all — every row, query text ignored", group: "All rows" },
];
export const TYPE_ORDER = TYPES.map((t) => t.key);

// term-level exact/pattern queries take a bare `value` (or, for `terms`, a bare array) —
// no analysis, no operator/fuzziness-as-multi_match-knows-it.
const TERM_LEVEL_TYPES = new Set(["term", "terms", "prefix", "wildcard", "fuzzy"]);
// single-column MATCH-family queries — same text-analysis levers as multi_match, but
// against one named field instead of a boosted list.
const MATCH_FAMILY_TYPES = new Set(["match", "match_phrase", "match_phrase_prefix", "match_bool_prefix"]);
const SINGLE_FIELD_TYPES = new Set([...MATCH_FAMILY_TYPES, ...TERM_LEVEL_TYPES]);
// Types that rank by vector similarity: a `neural` clause, which the backend accepts only
// inside `hybrid.queries`. `hybrid_semantic` blends that clause with a keyword one.
const SEMANTIC_TYPES = new Set(["semantic", "hybrid_semantic"]);
const HYBRID_TYPES = new Set(["hybrid_semantic"]);

// Every non-semantic type can be the keyword leg of a hybrid query.
export const KEYWORD_TYPES = TYPES.filter((t) => !SEMANTIC_TYPES.has(t.key));

// Where a semantic/hybrid query's search pipeline comes from: an inline literal built from
// the levers, a saved NamedSearchPipeline by `$ref`, or none sent — the index's
// SearchConfiguration default, else the system default.
export const PIPELINE_SOURCES = ["inline", "ref", "default"];
export const DEFAULT_KEYWORD_LEG = "best_fields";

// The type whose keyword levers (operator, fuzziness, boosts, …) apply: the keyword leg's
// type for a hybrid query, otherwise the selected type itself.
export const keywordLeverType = (levers) =>
  HYBRID_TYPES.has(levers.type) ? levers.keywordType || DEFAULT_KEYWORD_LEG : levers.type;

// Inline normalization-processor techniques a hybrid query can pick (the first is the default).
export const NORMALIZATIONS = ["min_max", "l2", "z_score"];
export const COMBINATIONS = ["arithmetic_mean", "harmonic_mean", "geometric_mean"];
// OpenSearch refuses any combination but arithmetic_mean after z_score (a 400).
export const combinationsFor = (normalization) => (normalization === "z_score" ? ["arithmetic_mean"] : COMBINATIONS);

// Which lever each type actually uses — OpenSearch silently ignores the rest (e.g.
// `slop` on best_fields, `tie_breaker` on cross_fields). Drives which lever inputs the
// playground greys out per selected type, and which keys buildQuery emits.
export const LEVER_SUPPORT = {
  field: SINGLE_FIELD_TYPES,
  operator: new Set(["simple_query_string", "query_string", "best_fields", "frontend_default_tunable", "most_fields", "cross_fields", "bool_prefix", "match", "match_bool_prefix"]),
  fuzziness: new Set(["best_fields", "frontend_default_tunable", "most_fields", "cross_fields", "bool_prefix", "match", "match_bool_prefix", "fuzzy"]),
  minimumShouldMatch: new Set(["simple_query_string", "query_string", "best_fields", "frontend_default_tunable", "most_fields", "cross_fields", "bool_prefix", "match", "match_bool_prefix"]),
  slop: new Set(["phrase", "phrase_prefix", "match_phrase", "match_phrase_prefix"]),
  tieBreaker: new Set(["best_fields", "frontend_default_tunable", "most_fields", "phrase", "phrase_prefix", "bool_prefix"]),
  boosts: new Set(["simple_query_string", "query_string", "best_fields", "frontend_default_tunable", "most_fields", "cross_fields", "phrase", "phrase_prefix", "bool_prefix"]),
  caseInsensitive: new Set(["term", "prefix", "wildcard"]),
  semanticCutoff: SEMANTIC_TYPES,
  keywordType: HYBRID_TYPES,
  semanticWeight: HYBRID_TYPES,
  pipelineSource: SEMANTIC_TYPES,
  pipeline: HYBRID_TYPES,
};

// The body of a single-field clause, e.g. { match: { <field>: <this> } } — shape depends
// on the family: term-level queries take a bare value (terms takes a bare array), the
// match family takes the same text-analysis levers multi_match does.
function singleFieldBody(type, q, levers) {
  if (type === "terms") return q.split(",").map((s) => s.trim()).filter(Boolean);
  if (TERM_LEVEL_TYPES.has(type)) {
    const body = { value: q };
    if (levers.caseInsensitive && LEVER_SUPPORT.caseInsensitive.has(type)) body.case_insensitive = true;
    if (type === "fuzzy" && levers.fuzziness) body.fuzziness = levers.fuzziness;
    return body;
  }
  const body = { query: q };
  if (levers.operator && LEVER_SUPPORT.operator.has(type)) body.operator = levers.operator;
  if (levers.fuzziness && LEVER_SUPPORT.fuzziness.has(type)) body.fuzziness = levers.fuzziness;
  if (levers.minimumShouldMatch && LEVER_SUPPORT.minimumShouldMatch.has(type)) body.minimum_should_match = levers.minimumShouldMatch;
  if (levers.slop != null && levers.slop !== "" && LEVER_SUPPORT.slop.has(type)) body.slop = Number(levers.slop);
  return body;
}

// The body of a multi_match clause. `mmType` is what goes in its own `type` key (null to
// omit it, i.e. OpenSearch's implicit best_fields); which levers apply is decided by
// `levers.type`.
function multiMatchBody(q, fields, levers, mmType) {
  const type = levers.type;
  const mm = { query: q };
  // Only the playground's boosts toggle ever sets useBoosts to a real boolean (readLevers()
  // always reads a checkbox, so it's true or false, never undefined). The benchmark's fixed
  // STRATEGIES below never set it at all — so `undefined` keeps the old behavior (send an
  // explicit, unweighted field list) while an explicit `false` (boosts turned off) omits
  // `fields` entirely, same as frontend_default: search every field, no manual list needed.
  if (levers.useBoosts !== false) mm.fields = levers.useBoosts ? fields : unboosted(fields);
  if (mmType) mm.type = mmType;
  if (levers.operator && LEVER_SUPPORT.operator.has(type)) mm.operator = levers.operator;
  if (levers.fuzziness && LEVER_SUPPORT.fuzziness.has(type)) mm.fuzziness = levers.fuzziness;
  if (levers.minimumShouldMatch && LEVER_SUPPORT.minimumShouldMatch.has(type)) mm.minimum_should_match = levers.minimumShouldMatch;
  if (levers.slop != null && levers.slop !== "" && LEVER_SUPPORT.slop.has(type)) mm.slop = Number(levers.slop);
  if (levers.tieBreaker != null && levers.tieBreaker !== "" && LEVER_SUPPORT.tieBreaker.has(type)) mm.tie_breaker = Number(levers.tieBreaker);
  return mm;
}

// Weights must sum to 1.0 or the request is refused, so round away binary-float dust
// (1 - 0.7 is 0.30000000000000004) before serializing the pair.
const round2 = (n) => Math.round(n * 100) / 100;

// Read a numeric lever, falling back when it's blank or out of range. A blank input is
// absent, not zero — Number("") is 0, which would read as a real threshold or weight and
// silently change the query (a semantic weight of 0 drops the semantic leg entirely).
const numberOr = (raw, fallback, min, max) => {
  const n = Number(raw);
  return raw === "" || raw == null || !Number.isFinite(n) || n < min || n > max ? fallback : n;
};

// A `hybrid` body. `neural` — semantic (vector) matching, where the platform embeds
// `query_text` with its own model — is accepted ONLY inside `hybrid.queries`, so even a
// semantic-only search goes out as a one-clause hybrid, and `query` is absent (exactly one
// of `query` and `hybrid` is allowed). An inline `search_pipeline` is always sent so the
// normalization is explicit rather than whatever the index's SearchConfiguration defaults to.
//
// A semantic-only search keeps the documented defaults (min_max, arithmetic_mean) — with one
// clause they change the score values, not the order. A hybrid search exposes the keyword
// leg's type, the normalization and combination techniques, and the split between the two
// legs. A blended score is normalized against this request's own candidates, so it is not
// comparable across requests or pages.
function semanticQuery(q, size, fields, levers) {
  // k, min_score and max_distance are mutually exclusive, so exactly one is ever sent.
  const neural = { query_text: q };
  if (levers.semanticCutoff === "min_score") {
    neural.min_score = numberOr(levers.semanticCutoffValue, 0.5, 0, 1);
  } else {
    neural.k = Math.round(numberOr(levers.semanticCutoffValue, size, 1, Infinity));
  }

  const queries = [{ neural: { [SEMANTIC_FIELD]: neural } }];
  const normalization = { technique: NORMALIZATIONS[0] };
  const combination = { technique: COMBINATIONS[0] };
  if (HYBRID_TYPES.has(levers.type)) {
    // Weights are positional over hybrid.queries, so the keyword leg goes in front and the
    // semantic weight is the second entry.
    queries.unshift(buildQuery(q, size, fields, { ...levers, type: keywordLeverType(levers) }).query);
    if (NORMALIZATIONS.includes(levers.normalization)) normalization.technique = levers.normalization;
    if (COMBINATIONS.includes(levers.combination)) combination.technique = levers.combination;
    const w = numberOr(levers.semanticWeight, 0.5, 0, 1);
    combination.parameters = { weights: [round2(1 - w), round2(w)] };
  }
  const body = { hybrid: { queries }, size };
  if (levers.pipelineSource === "ref") body.search_pipeline = { $ref: (levers.pipelineRef || "").trim() };
  else if (levers.pipelineSource !== "default") {
    body.search_pipeline = { phase_results_processors: [{ "normalization-processor": { normalization, combination } }] };
  }
  return body;
}

// levers: { type, field, operator, fuzziness, minimumShouldMatch, slop, tieBreaker,
// caseInsensitive, semanticCutoff, semanticCutoffValue, keywordType, normalization,
// combination, semanticWeight, pipelineSource, pipelineRef }. Only the levers the
// selected type supports are ever written into the DSL — an unsupported value is silently
// dropped rather than sent (and possibly rejected or ignored) by OpenSearch.
export function buildQuery(q, size, fields, levers = {}) {
  const type = levers.type || "best_fields";
  if (type === "frontend_default") {
    // EXACT shape the live Synapse frontend sends today: no field list, no boosts, no
    // explicit type. Not lever-configurable — it's the fixed production baseline every
    // other combination is measured against.
    return { query: { multi_match: { query: q, fuzziness: "AUTO" } }, size };
  }

  if (SINGLE_FIELD_TYPES.has(type)) {
    const field = levers.field || unboosted(fields)[0] || "";
    return { query: { [type]: { [field]: singleFieldBody(type, q, levers) } }, size };
  }

  if (SEMANTIC_TYPES.has(type)) return semanticQuery(q, size, fields, levers);

  if (type === "match_all") return { query: { match_all: {} }, size };

  // query_string takes the same field list / operator / msm keys as simple_query_string,
  // but parses `q` as strict Lucene syntax (AND/OR/NOT, grouping, field:value, ranges).
  if (type === "simple_query_string" || type === "query_string") {
    const sqs = { query: q };
    if (levers.useBoosts !== false) sqs.fields = levers.useBoosts ? fields : unboosted(fields);
    if (levers.operator) sqs.default_operator = levers.operator.toUpperCase();
    if (levers.minimumShouldMatch) sqs.minimum_should_match = levers.minimumShouldMatch;
    return { query: { [type]: sqs }, size };
  }

  // frontend_default_tunable is the editable copy of Default site search: same underlying
  // best_fields shape (OpenSearch's implicit default when `type` is omitted), but routed
  // through this generic path so operator/fuzziness/minimum_should_match/tie_breaker/boosts
  // are all live instead of hardcoded. Omit `type` for it too, so an untouched copy is
  // byte-identical to frontend_default's DSL rather than just behaviorally equivalent.
  const mmType = type === "frontend_default_tunable" ? null : type;
  return { query: { multi_match: multiMatchBody(q, fields, levers, mmType) }, size };
}

// Fixed lever combos scored by the Benchmark tab — MUST produce byte-identical DSL to
// benchmark/strategies.py's STRATEGIES (the parity guard). Unlike the playground, the
// benchmark needs a small, stable, named set to track over time rather than the full
// open lever surface.
export const STRATEGIES = {
  frontend_default: (q, size) => buildQuery(q, size, [], { type: "frontend_default" }),
  simple_query_string: (q, size, fields) => buildQuery(q, size, unboosted(fields), { type: "simple_query_string" }),
  multi_match_best: (q, size, fields) => buildQuery(q, size, unboosted(fields), { type: "best_fields" }),
  multi_match_boosted: (q, size, fields) => buildQuery(q, size, fields, { type: "best_fields", useBoosts: true }),
  multi_match_cross: (q, size, fields) => buildQuery(q, size, fields, { type: "cross_fields", useBoosts: true }),
  boosted_fuzzy: (q, size, fields) => buildQuery(q, size, fields, { type: "best_fields", fuzziness: "AUTO", useBoosts: true }),
  phrase_prefix: (q, size, fields) => buildQuery(q, size, fields, { type: "phrase_prefix", useBoosts: true }),
};

// Stable display order (matches strategies.py STRATEGIES insertion order).
export const STRATEGY_ORDER = Object.keys(STRATEGIES);

// Strategies that pass the (editable) per-field boosts through as-is, i.e. the ones the
// Benchmark tab's boost hint applies to.
export const BOOSTED_KEYS = new Set(["multi_match_boosted", "multi_match_cross", "boosted_fuzzy", "phrase_prefix"]);
