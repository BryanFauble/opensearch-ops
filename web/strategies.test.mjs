// Guard on buildQuery()'s DSL shapes: `node web/strategies.test.mjs` (no deps).
//
// The semantic/hybrid cases pin the shape asserted by
// Synapse-Repository-Services ITSearchQueryTest.testAsyncQueryWithSemanticHybridClause —
// a wrong key or a weight pair that doesn't sum to 1.0 is a 400 from the backend, which is
// hard to tell apart from an index that simply has no vectors. The keyword cases pin the
// refactor that routed multi_match through a shared builder: byte-identical DSL is the
// standing parity guard against benchmark/strategies.py.
import assert from "node:assert/strict";
import { buildQuery, KEYWORD_TYPES, NORMALIZATIONS, COMBINATIONS, combinationsFor } from "./strategies.js";

const FIELDS = ["resourceName^5", "description"];

// --- keyword shapes must not have moved -------------------------------------------------
assert.deepEqual(
  buildQuery("schwann", 10, FIELDS, { type: "frontend_default" }),
  { query: { multi_match: { query: "schwann", fuzziness: "AUTO" } }, size: 10 },
  "frontend_default is the frozen production baseline",
);
assert.deepEqual(
  buildQuery("schwann", 10, FIELDS, { type: "cross_fields", operator: "and", useBoosts: true }),
  { query: { multi_match: { query: "schwann", fields: FIELDS, type: "cross_fields", operator: "and" } }, size: 10 },
);
// boosts explicitly off -> no `fields` at all (search every field, like frontend_default)
assert.deepEqual(
  buildQuery("schwann", 10, FIELDS, { type: "best_fields", useBoosts: false }),
  { query: { multi_match: { query: "schwann", type: "best_fields" } }, size: 10 },
);
// an untouched editable copy of Default site search omits `type`, same as the frozen one
assert.deepEqual(
  buildQuery("schwann", 10, FIELDS, { type: "frontend_default_tunable", fuzziness: "AUTO", useBoosts: false }),
  { query: { multi_match: { query: "schwann", fuzziness: "AUTO" } }, size: 10 },
);

// --- semantic: a one-clause hybrid, never a bare `query` --------------------------------
const sem = buildQuery("genetic risk factors for tumours", 7, FIELDS, { type: "semantic" });
assert.equal(sem.query, undefined, "query and hybrid are mutually exclusive");
assert.deepEqual(sem, {
  hybrid: { queries: [{ neural: { semantic_search: { query_text: "genetic risk factors for tumours", k: 7 } } }] },
  search_pipeline: {
    phase_results_processors: [{
      "normalization-processor": {
        normalization: { technique: "min_max" },
        combination: { technique: "arithmetic_mean" },
      },
    }],
  },
  size: 7,
}, "a neural clause is only accepted inside hybrid; semantic-only keeps the fixed pipeline");

// k / min_score / max_distance are mutually exclusive — exactly one is ever sent
const floor = buildQuery("q", 10, FIELDS, { type: "semantic", semanticCutoff: "min_score", semanticCutoffValue: "0.8" });
assert.deepEqual(floor.hybrid.queries[0].neural.semantic_search, { query_text: "q", min_score: 0.8 });
const defaulted = buildQuery("q", 10, FIELDS, { type: "semantic", semanticCutoff: "min_score", semanticCutoffValue: "" });
assert.deepEqual(defaulted.hybrid.queries[0].neural.semantic_search, { query_text: "q", min_score: 0.5 });

// --- hybrid: keyword leg first, positional weights summing to exactly 1.0 ---------------
const hyb = buildQuery("q", 10, FIELDS, {
  type: "hybrid_semantic", useBoosts: true, operator: "and", semanticWeight: "0.7",
});
assert.deepEqual(hyb.hybrid.queries[0], { multi_match: { query: "q", fields: FIELDS, type: "best_fields", operator: "and" } },
  "the keyword leg defaults to best_fields");
assert.ok(hyb.hybrid.queries[1].neural, "the semantic leg is second, matching the weight order");
const weights = hyb.search_pipeline.phase_results_processors[0]["normalization-processor"]
  .combination.parameters.weights;
assert.deepEqual(weights, [0.3, 0.7]);
assert.equal(weights.reduce((a, b) => a + b).toFixed(6), "1.000000", "weights not summing to 1.0 are rejected");
// an out-of-range or blank weight falls back to an even split rather than a refused request
for (const semanticWeight of ["", "abc", "5"]) {
  const w = buildQuery("q", 10, FIELDS, { type: "hybrid_semantic", semanticWeight })
    .search_pipeline.phase_results_processors[0]["normalization-processor"].combination.parameters.weights;
  assert.deepEqual(w, [0.5, 0.5], `weight ${JSON.stringify(semanticWeight)} should fall back`);
}

// semantic-only ignores the hybrid-only levers
const semIgnores = buildQuery("q", 10, FIELDS, { type: "semantic", normalization: "l2", combination: "geometric_mean" });
assert.deepEqual(semIgnores.search_pipeline, sem.search_pipeline);

// --- hybrid keyword leg: any keyword type, built exactly as it is on its own -----------
for (const { key } of KEYWORD_TYPES) {
  const levers = { type: key, field: "resourceName", operator: "and", fuzziness: "1", useBoosts: true };
  const leg = buildQuery("q", 10, FIELDS, { ...levers, type: "hybrid_semantic", keywordType: key }).hybrid.queries[0];
  assert.deepEqual(leg, buildQuery("q", 10, FIELDS, levers).query, `keyword leg ${key}`);
}

// --- hybrid pipeline techniques pass through; unknown values fall back -----------------
assert.deepEqual(combinationsFor("z_score"), ["arithmetic_mean"], "OpenSearch 400s any other combination after z_score");
for (const normalization of NORMALIZATIONS) {
  for (const combination of combinationsFor(normalization)) {
    const proc = buildQuery("q", 10, FIELDS, { type: "hybrid_semantic", normalization, combination })
      .search_pipeline.phase_results_processors[0]["normalization-processor"];
    assert.equal(proc.normalization.technique, normalization);
    assert.equal(proc.combination.technique, combination);
    assert.deepEqual(proc.combination.parameters.weights, [0.5, 0.5]);
  }
}
const bogus = buildQuery("q", 10, FIELDS, { type: "hybrid_semantic", normalization: "rrf", combination: "" })
  .search_pipeline.phase_results_processors[0]["normalization-processor"];
assert.equal(bogus.normalization.technique, "min_max");
assert.equal(bogus.combination.technique, "arithmetic_mean");

// --- pipeline source: inline (default), a saved pipeline by $ref, or omitted -----------
const byRef = buildQuery("q", 10, FIELDS, { type: "hybrid_semantic", pipelineSource: "ref", pipelineRef: " org-p ", semanticWeight: "0.9" });
assert.deepEqual(byRef.search_pipeline, { $ref: "org-p" }, "a $ref carries no inline weights");
const omitted = buildQuery("q", 10, FIELDS, { type: "semantic", pipelineSource: "default" });
assert.ok(!("search_pipeline" in omitted), "index default = no search_pipeline sent");
assert.deepEqual(buildQuery("genetic risk factors for tumours", 7, FIELDS, { type: "semantic", pipelineSource: "inline" }), sem);

// --- query_string mirrors simple_query_string's keys; match_all ignores the text --------
assert.deepEqual(
  buildQuery("title:wind AND NOT rain", 10, FIELDS, { type: "query_string", operator: "and", useBoosts: true }),
  { query: { query_string: { query: "title:wind AND NOT rain", fields: FIELDS, default_operator: "AND" } }, size: 10 },
);
assert.deepEqual(buildQuery("ignored", 5, FIELDS, { type: "match_all" }), { query: { match_all: {} }, size: 5 });

console.log("ok — buildQuery keyword + semantic/hybrid shapes");
