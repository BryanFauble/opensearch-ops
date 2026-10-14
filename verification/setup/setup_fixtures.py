"""Create (or reuse) every Synapse object the PLFM search verification needs, wait for the
search indexes to build, and write ../fixtures.json for the Playwright specs.

  python setup/setup_fixtures.py [--skip-acl] [--row-ceiling]

Idempotent: everything is looked up by name and reused, so rerunning only fills in what
is missing. See ../README.md for what each object is for.

Writes land in the production database -- repo-staging reads and writes the same data as
repo-prod -- and Organizations / NamedSearchPipelines / SearchConfigurations can never be
deleted. Everything is named after your username so it can't collide with anyone else's.
"""

import argparse
import asyncio
import json

from common import (
    FIXTURES_PATH,
    get_or_create_named,
    get_or_create_org,
    login,
    org_name_for,
    pipeline_settings,
    wait_for_build,
)
from synapseclient.models import (
    Column,
    ColumnAnalyzerOverride,
    ColumnAnalyzerOverrideEntry,
    ColumnType,
    EntityView,
    Folder,
    NamedSearchPipeline,
    Project,
    SearchConfiguration,
    SearchIndex,
    Table,
    ViewTypeMask,
)
from synapseclient.operations import find_entity_id_async

PUBLIC = 273949  # the PUBLIC group: anyone, signed in or not

# Six unrelated topics, ten rows each. The semantic checks rely on two properties:
#   * "kitten" appears nowhere, so a keyword search for it finds nothing while a
#     semantic one ranks the feline rows first;
#   * each topic's vocabulary is disjoint from the others'.
TOPICS = {
    "Feline": [
        "Feline health starts with a clean litter box and fresh water.",
        "A tabby with long whiskers naps on the windowsill all afternoon.",
        "Indoor feline companions need scratching posts and climbing shelves.",
        "Grooming a feline weekly keeps hairballs down.",
        "Feline diets should be high in protein and low in grain.",
    ],
    "Marine": [
        "Coral reefs shelter thousands of fish species along the tide line.",
        "Kelp forests sway with the ocean swell off the rocky coast.",
        "Marine biologists tag sea turtles to follow their migration.",
        "Low tide exposes anemones and starfish in the rock pools.",
        "Plankton blooms colour the open ocean green each spring.",
    ],
    "Astronomy": [
        "A comet with a bright tail crossed the night sky in March.",
        "The telescope resolved the spiral arms of a distant galaxy.",
        "Nebulae are clouds of gas where new stars are born.",
        "Observing planets is easiest when they sit high above the horizon.",
        "Meteor showers peak when Earth crosses a comet's debris trail.",
    ],
    "Baking": [
        "Sourdough rises slowly from a starter fed with flour and water.",
        "Preheat the oven before the loaf goes in to get a crisp crust.",
        "Butter folded into the dough gives croissants their layers.",
        "Weighing flour is more accurate than measuring it by the cup.",
        "Let bread cool on a rack so the crumb sets.",
    ],
    "Cycling": [
        "Shift into a lower gear before the hill, not halfway up it.",
        "A properly fitted saddle prevents knee pain on long rides.",
        "Check bicycle tyre pressure before every ride.",
        "Clean and lubricate the chain after riding in the rain.",
        "Group rides draft in a single line to save energy.",
    ],
    "Gardening": [
        "Compost turns kitchen scraps into rich soil for the beds.",
        "Harden off seedlings outdoors for a week before planting.",
        "Prune roses in late winter, just above an outward bud.",
        "Mulch keeps soil moist and smothers weeds.",
        "Rotate vegetable crops each year to keep the soil healthy.",
    ],
}
ROWS_PER_TOPIC = 10
PROBE_TEXT = "regenerating tumors"  # stems to "tumor" under SCIENTIFIC, not under standard
LONG_ROW_NAME = "Archive logbook record"
# ~20,000 cl100k tokens -- well past the 8,000-token cap on the embedded text.
LONG_ROW_SUMMARY = "The observatory logbook records a comet sighting over the ridge. " * 1600


def corpus_rows():
    rows = []
    for t, (topic, sentences) in enumerate(TOPICS.items()):
        for i in range(ROWS_PER_TOPIC):
            probe = PROBE_TEXT if i == 0 else "healthy tissue samples"
            rows.append({
                "name": f"{topic} note {i + 1}",
                "summary": sentences[i % len(sentences)],
                "tags": [topic.lower(), f"batch{i % 3}"],
                "probe_flagged": probe,
                "probe_plain": probe,
                "year": 2000 + t,
            })
    rows.append({
        "name": LONG_ROW_NAME, "summary": LONG_ROW_SUMMARY, "tags": ["archive"],
        "probe_flagged": "none", "probe_plain": "none", "year": 1999,
    })
    return rows


# What the specs assert, derived from the corpus above rather than hand-counted.
def expectations(rows):
    feline = [r for r in rows if r["name"].startswith("Feline")]
    return {
        "total_rows": len(rows),
        "probe_matches": sum(r["probe_plain"] == PROBE_TEXT for r in rows),
        "feline_rows": len(feline),
        # query_string: name:feline AND NOT summary:tabby
        "feline_not_tabby": sum("tabby" not in r["summary"].lower() for r in feline),
        # query_string: (comet OR sourdough) AND NOT name:archive
        "comet_or_sourdough": sum(
            ("comet" in r["summary"].lower() or "sourdough" in r["summary"].lower())
            and "archive" not in r["name"].lower()
            for r in rows
        ),
    }


# The ACL index's rows: one folder each, under a PUBLIC-readable or a private parent.
ACL_ROWS = {
    "public": [
        ("Public shelter tabby", "A rescued feline waiting for adoption at the shelter."),
        ("Public comet watch", "Volunteers record each comet seen from the hilltop."),
        ("Public sourdough class", "A community class on feeding a sourdough starter."),
        ("Public reef survey", "Divers count fish on the coral reef every summer."),
    ],
    "private": [
        ("Private feline clinic", "Confidential feline patient notes from the vet clinic."),
        ("Private telescope log", "Internal telescope maintenance schedule."),
        ("Private bakery orders", "Wholesale flour and oven orders for the bakery."),
        ("Private dive roster", "Staff roster for the marine survey boat."),
    ],
}

TEXT_COLUMNS = [
    Column(name="name", column_type=ColumnType.STRING, maximum_size=100),
    Column(name="summary", column_type=ColumnType.LARGETEXT),
    Column(name="tags", column_type=ColumnType.STRING_LIST, maximum_size=50, maximum_list_length=5),
    Column(name="probe_flagged", column_type=ColumnType.STRING, maximum_size=100),
    Column(name="probe_plain", column_type=ColumnType.STRING, maximum_size=100),
    Column(name="year", column_type=ColumnType.INTEGER),
]


async def get_or_create_entity(cls, syn, parent_id, name, populate=None, **fields):
    """Reuse the child named `name`, or create it and run `populate(entity)` once."""
    existing = await find_entity_id_async(name=name, parent=parent_id, synapse_client=syn)
    if existing:
        return await cls(id=existing).get_async(synapse_client=syn)
    print(f"  creating {cls.__name__} {name!r}")
    entity = await cls(name=name, parent_id=parent_id, **fields).store_async(synapse_client=syn)
    if populate:
        await populate(entity)
    return entity


async def make_index(syn, parent_id, name, defining_sql, config=None):
    return await get_or_create_entity(
        SearchIndex, syn, parent_id, name, defining_sql=defining_sql,
        search_configuration_id=config.id if config else None,
    )


def ref(resource):
    return {"$ref": resource.qualified_name}


async def main(skip_acl, row_ceiling):
    syn = login()
    me = syn.getUserProfile()["userName"]
    org = (await get_or_create_org(syn, org_name_for(syn))).name
    print(f"Organization: {org}")

    project_name = f"PLFM search verification ({me})"
    project_id = await find_entity_id_async(name=project_name, synapse_client=syn)
    project = await (Project(id=project_id).get_async(synapse_client=syn) if project_id
                     else Project(name=project_name).store_async(synapse_client=syn))
    print(f"Project: {project.id}")

    # --- data ---------------------------------------------------------------------------
    rows = corpus_rows()

    async def fill(table):
        await table.store_rows_async(
            values={c.name: [r[c.name] for r in rows] for c in TEXT_COLUMNS}, synapse_client=syn
        )

    table = await get_or_create_entity(Table, syn, project.id, "verify-corpus", populate=fill, columns=TEXT_COLUMNS)

    # --- pipelines (PLFM-9971) ------------------------------------------------------------
    # Weights are positional over hybrid.queries; the playground sends [keyword, semantic].
    keyword_only = await get_or_create_named(
        NamedSearchPipeline, syn, org, "keyword_only",
        description="All weight on clause 0 (the keyword leg)", settings=pipeline_settings([1.0, 0.0]))
    semantic_only = await get_or_create_named(
        NamedSearchPipeline, syn, org, "semantic_only",
        description="All weight on clause 1 (the semantic leg)", settings=pipeline_settings([0.0, 1.0]))
    crud = await get_or_create_named(
        NamedSearchPipeline, syn, org, "crud_roundtrip",
        description="Rewritten by check_api.py's update round trip", settings=pipeline_settings([0.5, 0.5]))

    # --- configurations ---------------------------------------------------------------
    # probe_flagged's entry sets `semantic` and no analyzer: PLFM-9970 says it must still
    # get its column-type default (SCIENTIFIC), exactly like probe_plain, which has no entry.
    main_overrides = await get_or_create_named(
        ColumnAnalyzerOverride, syn, org, "verify_main_overrides",
        overrides=[ColumnAnalyzerOverrideEntry(column_name=c, semantic=True)
                   for c in ("name", "summary", "tags", "probe_flagged")])
    main_config = await get_or_create_named(
        SearchConfiguration, syn, org, "verify_main",
        column_analyzer_overrides=[ref(main_overrides)], default_search_pipeline=ref(keyword_only))
    bad_overrides = await get_or_create_named(
        ColumnAnalyzerOverride, syn, org, "verify_badtype_overrides",
        overrides=[ColumnAnalyzerOverrideEntry(column_name="year", semantic=True)])
    bad_config = await get_or_create_named(
        SearchConfiguration, syn, org, "verify_badtype", column_analyzer_overrides=[ref(bad_overrides)])

    # --- indexes ----------------------------------------------------------------------
    sql = f"SELECT * FROM {table.id}"
    indexes = {
        "main": await make_index(syn, project.id, "verify-main", sql, main_config),
        # No configuration at all: no vectors and no default pipeline.
        "novec": await make_index(syn, project.id, "verify-novec", sql),
        "badtype": await make_index(syn, project.id, "verify-badtype", sql, bad_config),
    }

    if not skip_acl:
        indexes["acl"] = await setup_acl(syn, org, project)
    if row_ceiling:
        indexes["ceiling"] = await setup_row_ceiling(syn, org, project)

    print("\nWaiting for builds (the semantic ones embed every row; allow a few minutes)")
    failures = {}
    for key, index in indexes.items():
        failures[key] = await wait_for_build(index, syn)
    for key in ("main", "novec", "acl"):
        if failures.get(key):
            raise SystemExit(f"{key} index failed to build: {failures[key]}")
    for key in ("badtype", "ceiling"):
        if key in indexes and not failures[key]:
            raise SystemExit(f"{key} index built, but PLFM-9973 says it must fail")

    fixtures = {
        "organization": org,
        "project": project.id,
        "table": table.id,
        "indexes": {k: v.id for k, v in indexes.items()},
        "build_failures": {k: v for k, v in failures.items() if v},
        "pipelines": {p.name: p.qualified_name for p in (keyword_only, semantic_only, crud)},
        "pipeline_ids": {p.name: p.id for p in (keyword_only, semantic_only, crud)},
        "configurations": {"main": main_config.id, "badtype": bad_config.id},
        "acl_rows": {k: len(v) for k, v in ACL_ROWS.items()} if not skip_acl else None,
        "expect": expectations(rows),
    }
    with open(FIXTURES_PATH, "w") as f:
        json.dump(fixtures, f, indent=2)
    print(f"\nWrote {FIXTURES_PATH}")
    print(json.dumps(fixtures["indexes"], indent=2))


async def setup_acl(syn, org, project):
    """An EntityView over folders whose rows have different benefactors: the PUBLIC-readable
    parent's children are readable anonymously, the private parent's are not. The view and
    its index live under the public parent so an anonymous caller can read the source."""
    public = await get_or_create_entity(Folder, syn, project.id, "acl-public")
    await public.set_permissions_async(principal_id=PUBLIC, access_type=["READ"], warn_if_inherits=False,
                                       synapse_client=syn)
    private = await get_or_create_entity(Folder, syn, project.id, "acl-private")
    for parent, key in ((public, "public"), (private, "private")):
        for name, summary in ACL_ROWS[key]:
            await get_or_create_entity(Folder, syn, parent.id, name, annotations={"summary": [summary]})

    view = await get_or_create_entity(
        EntityView, syn, public.id, "acl-view", scope_ids=[public.id, private.id],
        view_type_mask=ViewTypeMask.FOLDER, include_default_columns=True,
        columns=[Column(name="summary", column_type=ColumnType.STRING, maximum_size=200)],
    )
    overrides = await get_or_create_named(
        ColumnAnalyzerOverride, syn, org, "verify_acl_overrides",
        overrides=[ColumnAnalyzerOverrideEntry(column_name=c, semantic=True) for c in ("name", "summary")])
    config = await get_or_create_named(
        SearchConfiguration, syn, org, "verify_acl", column_analyzer_overrides=[ref(overrides)])
    return await make_index(syn, public.id, "verify-acl", f"SELECT * FROM {view.id}", config)


async def setup_row_ceiling(syn, org, project):
    """50,001 one-column rows with that column flagged semantic: one row past the
    semantic ceiling. The build fails on the row count before anything is embedded."""
    cols = [Column(name="x", column_type=ColumnType.STRING, maximum_size=10)]

    async def fill(table):
        await table.store_rows_async(values={"x": [str(i) for i in range(50_001)]}, synapse_client=syn)

    table = await get_or_create_entity(Table, syn, project.id, "verify-ceiling-rows", populate=fill, columns=cols)
    overrides = await get_or_create_named(
        ColumnAnalyzerOverride, syn, org, "verify_ceiling_overrides",
        overrides=[ColumnAnalyzerOverrideEntry(column_name="x", semantic=True)])
    config = await get_or_create_named(
        SearchConfiguration, syn, org, "verify_ceiling", column_analyzer_overrides=[ref(overrides)])
    return await make_index(syn, project.id, "verify-ceiling", f"SELECT * FROM {table.id}", config)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-acl", action="store_true",
                    help="don't create the PUBLIC-readable folders the row-level access check needs")
    ap.add_argument("--row-ceiling", action="store_true",
                    help="also build the 50,001-row table for the semantic row-ceiling check")
    args = ap.parse_args()
    asyncio.run(main(args.skip_acl, args.row_ceiling))
