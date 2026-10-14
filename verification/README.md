# PLFM search verification runbook

Verifies PLFM-9753, 9970, 9971, 9972, 9973 and 9974 on **repo-staging**. There are two
halves:

- **Setup (Python)** creates the data, configurations and indexes on Synapse. The Search Lab
  UI never writes to Synapse.
- **Verify (UI)** runs queries in the Search Lab. Each check is done two ways: automatically
  with Playwright, which records screenshots and traces as proof, and by hand, following the
  steps below for whoever gives the final sign-off.

Some criteria can't be seen through the query UI: resource CRUD, save-time validation, and
request limits the playground never builds. `setup/check_api.py` checks those against the
API and writes `api-results.md`.

> [!WARNING]
> repo-staging reads and writes the **production database**. Everything here is real and
> visible on synapse.org:
> - Organizations, NamedSearchPipelines, ColumnAnalyzerOverrides and SearchConfigurations
>   **can never be deleted**. They are all named after your username
>   (`<username>.plfmverify`).
> - The row-level access fixture grants **PUBLIC READ** on one folder of synthetic rows
>   (`acl-public`). Pass `--skip-acl` to leave it out; the two access checks then skip.

## Prerequisites

| Need | How |
|---|---|
| `~/.synapseConfig` pointed at staging | an `[endpoints]` section with `repoEndpoint=https://repo-staging.prod.sagebase.org/repo/v1` (plus `authEndpoint` / `fileHandleEndpoint`), and an `authtoken`. The scripts refuse to run against any other stack. |
| A Sage Bionetworks account | Only Sage employees can manage NamedSearchPipelines (PLFM-9971). |
| synapseclient with search pipelines | The `SYNPY-1932` branch: the first with `NamedSearchPipeline`, `hybrid` and `search_pipeline`. `develop` doesn't have them. Below, `$PY` is that checkout's venv, e.g. `PY=~/BryansGreatWorkspaceSc/synapsePythonClient-search-parity/.venv/bin/python`. |
| Node 18+ and Playwright | `cd verification && npm install && npx playwright install chromium` |

## Run it

```bash
cd verification
$PY setup/setup_fixtures.py               # idempotent; add --row-ceiling for the 50,001-row check
$PY setup/check_api.py                    # API-only criteria → api-results.md
npx playwright test                       # UI criteria → playwright-report/
npx playwright show-report                # screenshots + trace per step
```

`setup_fixtures.py` waits for every index to build, which takes a few minutes because the
semantic indexes embed each row. It then writes `fixtures.json`: the synIDs, pipeline
names and expected counts that the specs read. The Playwright run builds `../web` into
`.site/`, serves it on `localhost:3017`, and logs in as you (`SYNAPSE_AUTH_TOKEN`, or the
`authtoken` in `~/.synapseConfig`).

**Proof to attach to each ticket:** `api-results.md` plus the Playwright HTML report (zip
`playwright-report/`). The report has a full-page screenshot for every step and a trace
you can replay.

## What setup creates

| Object | Name | Purpose |
|---|---|---|
| Project | `PLFM search verification (<username>)` | holds everything below |
| Table | `verify-corpus` | 61 synthetic rows: 6 topics × 10, plus one ~20k-token row. The word "kitten" appears nowhere. `probe_flagged` and `probe_plain` hold identical text. `year` is an INTEGER. |
| NamedSearchPipeline | `keyword_only` [1.0, 0.0], `semantic_only` [0.0, 1.0], `crud_roundtrip` | weights are positional over `hybrid.queries`; the playground sends `[keyword, semantic]` |
| SearchConfiguration `verify_main` | semantic on `name, summary, tags, probe_flagged`; `defaultSearchPipeline` = `$ref keyword_only` | |
| SearchIndex `verify-main` | over `verify-corpus` with `verify_main` | the main fixture |
| SearchIndex `verify-novec` | over `verify-corpus`, no configuration | no vectors, no default pipeline |
| SearchIndex `verify-badtype` | `verify_badtype` flags INTEGER `year` semantic | must fail to build |
| Folders `acl-public` (PUBLIC READ) / `acl-private` | 4 child folders each, with a `summary` annotation | rows with different benefactors |
| EntityView `acl-view` + SearchIndex `verify-acl` | folders in both parents; semantic on `name, summary` | row-level access |
| Table `verify-ceiling-rows` + SearchIndex `verify-ceiling` | `--row-ceiling` only: 50,001 rows, `x` flagged semantic | must fail to build |

## Opening the Search Lab by hand

1. `npm run serve` (in `verification/`) and open <http://localhost:3017>.
2. **Environment** → *Staging*. The page reloads and shows a *Staging* badge.
3. Open **Connection**. Set *SearchIndex project* to your project's synID (from
   `fixtures.json`) and *Auth token* to a personal access token, then **Apply & reload**.
4. **SearchIndex** → pick the index by name under *All SearchIndexes in project*. For
   `verify-acl`, which lives inside a folder, use *Other SearchIndex by ID…* and paste its
   synID.
5. On each side, open **Levers & field boosts** to pick a *Search type* and its levers.
   **Show query** displays the exact DSL that was sent.

In the steps below, **A** and **B** are the two columns. Every count comes from
`fixtures.json → expect`.

---

## PLFM-9753 — `query_string` query type

| Acceptance criterion | Verified by |
|---|---|
| query_string is supported as a query type | Playwright `plfm-9753-query-string.spec.ts`; manual 1–2; API checks |
| `fields` / `default_field` / column prefixes in the text are rewritten name→id; unknown names rejected | API: *fields / default_field are rewritten*, *unknown column in fields/query text*; Playwright; manual 3 |
| Walk-time caps | API: *fields over 1024 entries*, *max_expansions over 50*, *malformed Lucene* |

**Manual** (index `verify-main`):
1. A: *Lucene syntax (query_string)*. Search `name:feline AND NOT summary:tabby`.
   → **8** results, all *Feline note …*. The column names in the text resolved to real
   fields, and `NOT` removed the two tabby rows.
2. B: same type. Search `(comet OR sourdough) AND NOT name:archive`.
   → **6** results, all *Astronomy …* or *Baking …*. Grouping and `OR` work.
3. A: search `nosuchcol:feline`.
   → red box: `'query_string.query' references an unknown column: 'nosuchcol'`.

Note: the ticket says column names inside the query text are *not* rewritten. The merged
code does rewrite them (`SearchFieldRewriter`), so step 1 checks the merged behavior.
Leading wildcards have no special rule; they're allowed in every clause.

## PLFM-9970 — analyzer precedence, sort tiebreak

| Acceptance criterion | Verified by |
|---|---|
| Precedence: override analyzer → `defaultAnalyzer` → column-type default | Playwright *analyzer-less override entry…*; manual 1; API *probe_flagged / probe_plain* |
| An override entry with no analyzer doesn't change the column's analyzer | same |
| A unique trailing sort key is appended (except pure-relevance hybrid / caller already sorts on it) | API *a unique trailing key (_row_id)…*; Playwright checks the cursor's last value is an integer row id |
| match_all paged with search_after returns every row exactly once | Playwright *match_all paged…*; manual 2; API (also over a tied column sort, `year`) |
| Unit tests cover both defects | code review (`SearchOpaqueJsonUtilTest`, `OpenSearchManagerImpl` tests) |

**Manual** (index `verify-main`):
1. A: *Match* with *Field* `probe_plain`. B: *Match* with *Field* `probe_flagged`. Search
   `tumor` on both.
   → both show **6** results, and the summary bar says *6 of 6 results in common*.
   Both columns hold "regenerating tumors". Only `probe_flagged` has an override entry,
   which sets `semantic` and no analyzer. Matching `tumor` needs the SCIENTIFIC
   analyzer's stemming. Before the fix, B found 0.
2. *Results per side* = `7`. A: *Match all*, search anything, then click **Next page**
   until the button disappears.
   → the meta line reads `61 shown · 61 total matches · 9 pages`, with no
   *⚠ rows repeated across pages*. Every match_all hit scores the same. Before the fix,
   page 2 came back empty. Click **Show query** to see `search_after` = `[score, <row id>]`.

## PLFM-9971 — NamedSearchPipeline resource

Every criterion here is API-only. The playground consumes pipelines through PLFM-9972 but
never manages them.

| Acceptance criterion | Verified by |
|---|---|
| Create / Get / Update / List endpoints, with Java (and Python) client methods | setup creates 3; API *create / get / update / list round trip* (update changes the etag) |
| Registered for migration + migration test | code review / CI (not observable from a client) |
| DAO round trip with a real payload | API round trip uses real settings (weights, techniques) |
| Manager validation and authorization | API: 6 *invalid pipeline rejected at save* cases (sum, too few, too many, range, z_score+harmonic, bad name), *name is immutable*, *anonymous caller cannot create* |
| Integration test through the Java client | `ITSearchPipelineTest.testCRUDWithPipelineSettings` (backend CI) |

**Manual** (optional, in a Python shell with `$PY`):
`NamedSearchPipeline.list(organization_name="<org>")` lists all three.
`NamedSearchPipeline(id=…).get().settings` shows the weights.

## PLFM-9972 — pipeline carry: inline, by reference, index default

| Acceptance criterion | Verified by |
|---|---|
| A configuration's default pipeline persists and round-trips, as a literal or a `$ref`; an unresolved `$ref` is rejected at save | API: *default pipeline ($ref) persists*, *unresolvable default $ref rejected at save*, *inline default held to saved-pipeline rules* |
| A query may carry its own pipeline (inline or `$ref`), and is rejected without a hybrid | Playwright (`$ref` and inline); API *search_pipeline without hybrid rejected*, *unknown $ref on the request* |
| Precedence: request → index default → system default; nothing rejected for a missing pipeline | Playwright *index's default pipeline applies… request $ref beats it*, *system default*; manual 1–2, 4 |
| Saved weights trimmed to the clauses sent and rescaled; the saved pipeline is unchanged | API *trimming leaves the saved pipeline unchanged*; manual 1 (a 2-weight pipeline used by 2 clauses) |
| Trimmed weights that can't be rescaled are rejected | Playwright *saved weights that trim to nothing…*; manual 3; API (also *more clauses than the saved weights hold*) |
| The two new opaque slots are accounted for under PLFM-9714 | code review |
| Existing query/autocomplete behavior unchanged, integration suite green | backend CI. Every PLFM-9753/9970 check here also runs on the new generic-client search path. |

**Manual** (index `verify-main`, whose configuration defaults to `keyword_only`):
1. A and B: *Hybrid — keyword + semantic*. A: *Search pipeline* = *Index default (none
   sent)*. B: *Saved pipeline ($ref)*, with *Pipeline $ref* = `<org>-keyword_only`. Search
   `sourdough starter` on both.
   → same rows, same order, same scores. **Show query** on A has no `search_pipeline`,
   so the index default was used.
2. B: change the `$ref` to `<org>-semantic_only` and search again.
   → the scores change. The request's pipeline beats the index default.
3. A: *Semantic — vector similarity*, pipeline `$ref` = `<org>-semantic_only`. Search
   `kitten`.
   → red box: `…sum to 0, leaving no way to weight them`. A semantic-only query sends one
   clause, at position 0, and this pipeline weights position 0 at 0.0.
4. Switch the index to `verify-novec`, which has no configuration. A: *Hybrid*, *Index
   default*, search `feline`.
   → **10** results and no error. The system default pipeline applied.

## PLFM-9973 — semantic embedding columns

| Acceptance criterion | Verified by |
|---|---|
| Stack-Builder provisions the model idempotently; the stack resolves it by name | **infra, not client-verifiable.** Indirect evidence: every semantic query here succeeds. |
| A flagged column contributes to one vector per row; joined text capped at 8,000 tokens; never returned on a hit | Playwright *row past the 8,000-token cap…*, *never returned on a hit*; manual 2–3; API equivalents |
| The index records the model and vector dimension | **not client-visible.** Stored in the OpenSearch mapping `_meta.semanticSpec`; check it on the domain or in code review. |
| A non-embeddable type, or a source over the row ceiling, fails the build clearly | Playwright *non-embeddable column…*, *over 50,000 rows* (with `--row-ceiling`); manual 1; API |
| A build is retried, not failed, while the model is unavailable | **not reproducible from a client** (needs the model undeployed); unit tests `SearchIndexLifecycleManagerImplTest` |

**Manual:**
1. Pick `verify-badtype`.
   → the status line says `couldn’t load … Search index build failed: Column 'year' is of
   type INTEGER and cannot be flagged 'semantic'; only [STRING, …] columns can.`
   With `--row-ceiling`, `verify-ceiling` shows
   `…would exceed maximum of 50000 rows. Row count: 50001`.
2. `verify-main`, A: *Semantic*. Search `comet sighting recorded in an observatory logbook`.
   → *Archive logbook record* appears. Its text is ~20k tokens; it was capped and embedded
   rather than rejected.
3. A: *Match all*, *Results per side* `50`. Expand **Show all fields** on any hit.
   → only the table's own columns; no `semantic_search` and no embedded-text field.

## PLFM-9974 — hybrid query

| Acceptance criterion | Verified by |
|---|---|
| A keyword + semantic hybrid returns one ranked set | Playwright *semantic finds by meaning…*; manual 1–2; API *keyword + semantic blend* |
| A semantic clause may only name the vector field | API *neural clause on another field rejected*. The UI always sends `semantic_search`. |
| Access filters apply to the hybrid and every clause | Playwright *row-level access* (owner vs anonymous); manual 4; API |
| Clause count bounded, relevance paging depth capped, cursor paging rejected under relevance | API: *more than 5 clauses*, *capped at depth 1000*, *search_after under relevance ranking*. The UI sends at most 2 clauses and no `from`, and a relevance-ranked hybrid response carries no cursor, so there's no **Next page**. |
| No vectors / different embedding model → rejected, not silently empty | Playwright *index without vectors*; manual 3. A different model isn't reproducible (needs a model swap). |
| Integration tests cover blending, the stored-pipeline fallback, row-level access | backend CI; `SearchIndexLifecycleWorkerAutowireTest.testSearchIndexHybridSemanticBenefactorFilteringDiffersByUser` |

**Manual:**
1. `verify-main`. A: *Multi-match — best field*. B: *Semantic*. Search `kitten` on both.
   → A: *No results.* (the word isn't in the corpus). B: *Feline note …* rows at the top.
2. A: *Hybrid*, *Keyword leg* best field, *Inline*, *Semantic weight* 0.5. Search
   `tabby kitten`.
   → one list with no repeated rows, led by Feline rows.
3. `verify-novec`. A: *Semantic*, search `kitten` → red box `…this search index has no
   semantic field…`. B: *Hybrid*, search `feline` → **10** results. The neural leg was
   dropped silently, which is the server-side skip from Jay Hodgson's feedback on the ticket.
4. Row-level access: `verify-acl` by ID, A: *Match all*.
   → with your token: **8**. Then **Connection → Clear** (anonymous) and reload the same
   index → **4**, all *Public …*. B: *Hybrid* `feline kitten` anonymously → no *Private …*
   row. Each row's benefactor is its parent folder, and only `acl-public` is PUBLIC-readable.

## Troubleshooting

- `Search index is still building` — rerun `setup_fixtures.py`; it waits again.
- A check fails on a count — `fixtures.json → expect` is derived from the corpus in
  `setup_fixtures.py`. An analyzer change upstream (e.g. stop words) would move it.
- Playwright can't log in — set `SYNAPSE_AUTH_TOKEN` explicitly.
