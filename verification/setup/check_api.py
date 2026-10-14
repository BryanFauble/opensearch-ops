"""API-level checks for the acceptance criteria the Search Lab UI can't reach: resource
CRUD and save-time validation, and request limits the playground never builds.

  python setup/check_api.py        (after setup_fixtures.py)

Prints one PASS/FAIL line per check, writes ../api-results.md, and exits non-zero on any
failure. Every rejection check matches the backend's exact message. Rejected creates
persist nothing, but if validation regressed, a reject_* resource would be created and
could not be deleted.
"""

import asyncio
import datetime
import os
import sys

from common import load_fixtures, login, pipeline_settings, run_query
from synapseclient import Synapse
from synapseclient.models import NamedSearchPipeline, SearchConfiguration, SearchIndex

RESULTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api-results.md")
RESULTS = []  # (ticket, check, passed, detail)


async def check(ticket, name, coro):
    try:
        detail = await coro
        RESULTS.append((ticket, name, True, detail or ""))
    except Exception as e:  # noqa: BLE001 - every failure is reported, not raised
        RESULTS.append((ticket, name, False, f"{type(e).__name__}: {e}"))
    _, _, ok, detail = RESULTS[-1]
    print(f"{'PASS' if ok else 'FAIL'}  {ticket}  {name}" + ("" if ok else f"\n      {detail}"))


async def rejected(coro, needle):
    try:
        await coro
    except Exception as e:  # noqa: BLE001
        if needle in str(e):
            return f"rejected: …{needle}…"
        raise AssertionError(f"rejected, but without {needle!r}: {e}") from None
    raise AssertionError(f"accepted; expected a rejection containing {needle!r}")


def equal(actual, expected, what):
    if actual != expected:
        raise AssertionError(f"{what}: got {actual!r}, expected {expected!r}")
    return f"{what} = {actual!r}"


def names(res):
    return [next((f.value for f in h.fields if f.name == "name"), None) for h in res.hits]


def neural(text, **kw):
    return {"neural": {"semantic_search": {"query_text": text, "k": 10, **kw}}}


async def page_all(index, syn, size, **query):
    """Every row id across search_after pages, in order."""
    ids, cursor = [], None
    for _ in range(100):
        res = await run_query(index, syn, size=size, search_after=cursor, **query)
        if not res.hits:
            return ids
        ids += [h.row_id for h in res.hits]
        cursor = res.next_search_after
        if cursor is None:
            return ids
    raise AssertionError("more than 100 pages")


async def main():
    syn = login()
    anon = Synapse(skip_checks=True)  # same endpoints, never logged in
    fx = load_fixtures()
    org, ex = fx["organization"], fx["expect"]
    idx = {k: SearchIndex(id=v) for k, v in fx["indexes"].items()}
    main_i, novec = idx["main"], idx["novec"]
    ref = lambda name: {"$ref": fx["pipelines"][name]}  # noqa: E731

    # ---------------------------------------------------------------- PLFM-9753
    t = "PLFM-9753"

    async def qs(text, **kw):
        return (await run_query(main_i, syn, query={"query_string": {"query": text, **kw}}, size=50)).total_hits

    await check(t, "column names in the query text are rewritten (name:feline AND NOT summary:tabby)",
                _eq(qs("name:feline AND NOT summary:tabby"), ex["feline_not_tabby"], "hits"))
    await check(t, "fields / default_field are rewritten name→id",
                _eq(qs("tabby", default_field="summary"), 2, "hits"))
    await check(t, "fields over 1024 entries rejected",
                rejected(qs("x", fields=["name"] * 1025), "query_string.fields has 1025 entries; max is 1024"))
    await check(t, "unknown column in fields rejected",
                rejected(qs("x", fields=["nosuchcol"]), "'query_string.fields' references an unknown column: 'nosuchcol'"))
    await check(t, "unknown column in query text rejected",
                rejected(qs("nosuchcol:x"), "'query_string.query' references an unknown column: 'nosuchcol'"))
    await check(t, "malformed Lucene rejected with the parser's reason",
                rejected(qs("(feline AND"), "'query_string.query' is malformed"))
    await check(t, "max_expansions over 50 rejected",
                rejected(qs("felin~", max_expansions=51), "max_expansions is 51; max is 50"))

    # ---------------------------------------------------------------- PLFM-9970
    t = "PLFM-9970"

    async def probe(column):
        return (await run_query(main_i, syn, query={"match": {column: "tumor"}}, size=50)).total_hits

    await check(t, "analyzer-less override entry keeps the SCIENTIFIC default (probe_flagged)",
                _eq(probe("probe_flagged"), ex["probe_matches"], "stemmed 'tumor' hits"))
    await check(t, "control column with no override entry (probe_plain)",
                _eq(probe("probe_plain"), ex["probe_matches"], "stemmed 'tumor' hits"))

    async def paged(size, **query):
        ids = await page_all(main_i, syn, size, **query)
        equal(len(ids) - len(set(ids)), 0, "rows repeated across pages")
        return equal(len(set(ids)), ex["total_rows"], f"distinct rows over pages of {size}")

    await check(t, "match_all + relevance sort pages every row exactly once", paged(7, query={"match_all": {}}))
    await check(t, "sort on a heavily tied column pages every row exactly once",
                paged(7, query={"match_all": {}}, sort=[{"year": "asc"}]))

    async def cursor_tiebreak():
        res = await run_query(main_i, syn, query={"match_all": {}}, size=3)
        return equal(res.next_search_after[-1], res.hits[-1].row_id, "last cursor value (the _row_id tiebreak)")

    await check(t, "a unique trailing key (_row_id) is appended to the sort", cursor_tiebreak())

    # ---------------------------------------------------------------- PLFM-9971
    t = "PLFM-9971"

    async def crud_roundtrip():
        p = await NamedSearchPipeline(id=fx["pipeline_ids"]["crud_roundtrip"]).get_async(synapse_client=syn)
        proc = p.settings["phase_results_processors"][0]["normalization-processor"]
        new = [0.4, 0.6] if proc["combination"]["parameters"]["weights"] == [0.5, 0.5] else [0.5, 0.5]
        old_etag = p.etag
        proc["combination"]["parameters"]["weights"] = new
        await p.store_async(synapse_client=syn)
        again = await NamedSearchPipeline(id=p.id).get_async(synapse_client=syn)
        got = again.settings["phase_results_processors"][0]["normalization-processor"]["combination"]["parameters"]["weights"]
        equal(got, new, "weights after update")
        if again.etag == old_etag:
            raise AssertionError("etag did not change on update")
        listed = {x.name for x in await NamedSearchPipeline.list_async(organization_name=org, synapse_client=syn)}
        missing = {"keyword_only", "semantic_only", "crud_roundtrip"} - listed
        if missing:
            raise AssertionError(f"list is missing {missing}")
        return f"get → update {new} → get, etag changed, list has all 3"

    await check(t, "create / get / update / list round trip with a real pipeline payload", crud_roundtrip())

    def bad(name, settings):
        return NamedSearchPipeline(organization_name=org, name=name, settings=settings).store_async(synapse_client=syn)

    for name, settings, needle in [
        ("reject_sum", pipeline_settings([0.5, 0.4]), "weights must sum to 1.0"),
        ("reject_one", pipeline_settings([1.0]), "weights must contain 2 to 5 entries; found 1"),
        ("reject_six", pipeline_settings([0.5, 0.1, 0.1, 0.1, 0.1, 0.1]), "weights must contain 2 to 5 entries; found 6"),
        ("reject_range", pipeline_settings([1.5, -0.5]), "must be in the range [0.0, 1.0]"),
        ("reject_zscore", pipeline_settings([0.5, 0.5], "z_score", "harmonic_mean"),
         "the 'z_score' normalization technique only supports the 'arithmetic_mean' combination technique"),
        ("1reject_name", pipeline_settings([0.5, 0.5]), "Resource name must start with a letter"),
    ]:
        await check(t, f"invalid pipeline rejected at save: {name}", rejected(bad(name, settings), needle))

    async def rename():
        p = await NamedSearchPipeline(id=fx["pipeline_ids"]["crud_roundtrip"]).get_async(synapse_client=syn)
        p.name = "crud_renamed"
        await p.store_async(synapse_client=syn)

    await check(t, "name is immutable on update", rejected(rename(), "The name cannot be changed"))
    await check(t, "anonymous caller cannot create",
                _raises(NamedSearchPipeline(organization_name=org, name="reject_anon",
                                            settings=pipeline_settings([0.5, 0.5])).store_async(synapse_client=anon)))

    # ---------------------------------------------------------------- PLFM-9972
    t = "PLFM-9972"

    async def config_roundtrip():
        c = await SearchConfiguration(id=fx["configurations"]["main"]).get_async(synapse_client=syn)
        return equal(c.default_search_pipeline, ref("keyword_only"), "defaultSearchPipeline")

    await check(t, "a configuration's default pipeline ($ref) persists and round-trips", config_roundtrip())
    await check(t, "unresolvable default $ref rejected at save",
                rejected(SearchConfiguration(organization_name=org, name="reject_unknown_ref",
                                             default_search_pipeline={"$ref": f"{org}-no_such_pipeline"}
                                             ).store_async(synapse_client=syn),
                         "The following search pipeline name does not exist"))
    await check(t, "inline default pipeline held to the saved-pipeline rules",
                rejected(SearchConfiguration(organization_name=org, name="reject_inline_default",
                                             default_search_pipeline=pipeline_settings([0.5, 0.4])
                                             ).store_async(synapse_client=syn),
                         "defaultSearchPipeline"))
    await check(t, "search_pipeline without hybrid rejected",
                rejected(run_query(main_i, syn, query={"match_all": {}}, search_pipeline=ref("keyword_only")),
                         "body.search_pipeline is only accepted with body.hybrid"))
    await check(t, "unknown $ref on the request rejected",
                rejected(run_query(main_i, syn, hybrid={"queries": [{"match": {"name": "feline"}}]},
                                   search_pipeline={"$ref": f"{org}-no_such_pipeline"}),
                         "names a search pipeline that does not exist"))
    three = {"queries": [{"match": {"name": "feline"}}, {"match": {"summary": "tabby"}}, neural("cat")]}
    await check(t, "more clauses than the saved weights hold rejected",
                rejected(run_query(main_i, syn, hybrid=three, search_pipeline=ref("semantic_only")),
                         "but the search pipeline's weights hold only 2 entries"))
    await check(t, "trimmed weights that sum to 0 rejected (semantic-only × [0.0, 1.0])",
                rejected(run_query(main_i, syn, hybrid={"queries": [neural("kitten")]},
                                   search_pipeline=ref("semantic_only")),
                         "sum to 0, leaving no way to weight them"))

    async def saved_unchanged():
        p = await NamedSearchPipeline(id=fx["pipeline_ids"]["keyword_only"]).get_async(synapse_client=syn)
        w = p.settings["phase_results_processors"][0]["normalization-processor"]["combination"]["parameters"]["weights"]
        return equal(w, [1.0, 0.0], "keyword_only weights after trimmed queries")

    await check(t, "trimming leaves the saved pipeline unchanged", saved_unchanged())

    async def no_pipeline_anywhere():
        res = await run_query(novec, syn, hybrid={"queries": [{"match": {"name": "feline"}}]}, size=50)
        return equal(res.total_hits, ex["feline_rows"], "hits with no request/index pipeline (system default)")

    await check(t, "no pipeline anywhere → system default, not a rejection", no_pipeline_anywhere())

    # ---------------------------------------------------------------- PLFM-9973
    t = "PLFM-9973"
    fails = fx["build_failures"]
    await check(t, "non-embeddable column flagged semantic fails the build",
                _contains(fails.get("badtype", ""), "Column 'year' is of type INTEGER and cannot be flagged 'semantic'"))
    if "ceiling" in fx["indexes"]:
        await check(t, "semantic source over 50,000 rows fails the build",
                    _contains(fails.get("ceiling", ""), "would exceed maximum of 50000 rows. Row count: 50001"))

    async def long_row():
        res = await run_query(main_i, syn, hybrid={"queries": [neural("comet sighting recorded in an observatory logbook")]}, size=10)
        if "Archive logbook record" not in names(res):
            raise AssertionError(f"the ~20k-token row was not found semantically; top hits: {names(res)}")
        return "the over-cap row is embedded and found by meaning"

    await check(t, "joined text over 8,000 tokens is capped, not rejected", long_row())

    async def no_vector_in_hits():
        res = await run_query(main_i, syn, query={"match_all": {}}, size=100)
        leaked = {f.name for h in res.hits for f in h.fields} & {"semantic_search", "_semantic_text"}
        if leaked:
            raise AssertionError(f"hit fields include {leaked}")
        return f"{len(res.hits)} hits, no semantic/embedded-text field"

    await check(t, "embedded text / vector never returned on a hit", no_vector_in_hits())

    # ---------------------------------------------------------------- PLFM-9974
    t = "PLFM-9974"

    async def blend():
        res = await run_query(main_i, syn, size=5, hybrid={"queries": [{"match": {"name": "kitten"}}, neural("kitten")]},
                              search_pipeline=pipeline_settings([0.5, 0.5]))
        top = names(res)[:3]
        if not all(n and n.startswith("Feline") for n in top):
            raise AssertionError(f"top 3 for 'kitten' should be Feline rows: {top}")
        return f"one ranked set, top 3: {top}"

    await check(t, "keyword + semantic blend returns one ranked set", blend())
    await check(t, "more than 5 clauses rejected",
                rejected(run_query(main_i, syn, hybrid={"queries": [{"match": {"name": "x"}}] * 6}),
                         "body.hybrid.queries must hold 1 to 5 clauses; found 6"))
    await check(t, "relevance paging capped at depth 1000",
                rejected(run_query(main_i, syn, hybrid={"queries": [neural("cat")]}, from_=990, size=20),
                         "from + size must not exceed 1000 for a hybrid query"))
    await check(t, "search_after under relevance ranking rejected",
                rejected(run_query(main_i, syn, hybrid={"queries": [neural("cat")]}, search_after=[1.0, 1]),
                         "search_after is not supported on a relevance-ranked hybrid query"))
    await check(t, "neural clause on another field rejected",
                rejected(run_query(main_i, syn, hybrid={"queries": [{"neural": {"summary": {"query_text": "cat", "k": 5}}}]}),
                         "'semantic_search' is the only vector field a neural clause may name; found 'summary'"))
    await check(t, "semantic-only query on an index without vectors rejected",
                rejected(run_query(novec, syn, hybrid={"queries": [neural("kitten")]}),
                         "every clause of body.hybrid.queries is a neural clause, but this search index has no semantic field"))

    if "acl" in fx["indexes"]:
        acl = idx["acl"]
        n_pub, n_all = fx["acl_rows"]["public"], sum(fx["acl_rows"].values())

        async def acl_counts():
            mine = (await run_query(acl, syn, query={"match_all": {}}, size=50)).total_hits
            theirs = (await run_query(acl, anon, query={"match_all": {}}, size=50)).total_hits
            equal(mine, n_all, "owner match_all")
            return equal(theirs, n_pub, "anonymous match_all")

        async def acl_hybrid():
            q = {"hybrid": {"queries": [{"match": {"name": "feline"}}, neural("kitten")]}, "size": 50}
            mine = names(await run_query(acl, syn, **q))
            theirs = names(await run_query(acl, anon, **q))
            if any(n.startswith("Private") for n in theirs):
                raise AssertionError(f"anonymous hybrid saw private rows: {theirs}")
            if not any(n.startswith("Private") for n in mine):
                raise AssertionError(f"owner hybrid saw no private rows: {mine}")
            return f"anonymous {len(theirs)} rows (public only), owner {len(mine)}"

        await check(t, "row-level access: anonymous sees only PUBLIC-benefactor rows", acl_counts())
        await check(t, "row-level access applies to every hybrid clause", acl_hybrid())

    write_results(fx)
    sys.exit(0 if all(ok for _, _, ok, _ in RESULTS) else 1)


async def _eq(coro, expected, what):
    return equal(await coro, expected, what)


async def _contains(text, needle):
    if needle not in text:
        raise AssertionError(f"expected {needle!r} in {text!r}")
    return f"…{needle}…"


async def _raises(coro):
    try:
        await coro
    except Exception as e:  # noqa: BLE001
        return f"rejected: {str(e)[:120]}"
    raise AssertionError("accepted")


def write_results(fx):
    passed = sum(ok for _, _, ok, _ in RESULTS)
    lines = [
        "# API check results",
        "",
        f"Run {datetime.datetime.now().isoformat(timespec='seconds')} against repo-staging, "
        f"organization `{fx['organization']}`, project `{fx['project']}`. "
        f"**{passed}/{len(RESULTS)} passed.**",
        "",
        "| Ticket | Check | Result | Detail |",
        "|---|---|---|---|",
    ]
    for ticket, name, ok, detail in RESULTS:
        cell = detail.replace("|", r"\|")
        lines.append(f"| {ticket} | {name} | {'PASS' if ok else '**FAIL**'} | {cell} |")
    with open(RESULTS_PATH, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\n{passed}/{len(RESULTS)} passed — wrote {os.path.relpath(RESULTS_PATH)}")


if __name__ == "__main__":
    asyncio.run(main())
