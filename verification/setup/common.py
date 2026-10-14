"""Shared helpers for the PLFM search verification setup and API checks.

Logs in with ~/.synapseConfig (point its [endpoints] at repo-staging), and needs the
synapseclient from the SYNPY-1932 branch -- the first with NamedSearchPipeline, hybrid
and search_pipeline. See ../README.md for the exact command.
"""

import asyncio
import json
import os
import re
import time

from synapseclient import Synapse
from synapseclient.core.exceptions import SynapseTimeoutError
from synapseclient.models import Organization, SearchQuery, SearchQueryPart

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES_PATH = os.path.join(HERE, "..", "fixtures.json")
STAGING = "repo-staging"


def login():
    syn = Synapse(skip_checks=True)
    syn.login(silent=True)
    if STAGING not in syn.repoEndpoint:
        raise SystemExit(
            f"Refusing to run against {syn.repoEndpoint}: these tickets are only live on "
            "repo-staging. Point ~/.synapseConfig [endpoints] at repo-staging."
        )
    return syn


def org_name_for(syn):
    """Organizations are global and permanent, so each tester gets their own."""
    user = re.sub(r"[^A-Za-z0-9]", "", syn.getUserProfile()["userName"]) or "tester"
    if not user[0].isalpha():
        user = "u" + user
    return f"{user}.plfmverify"


def load_fixtures():
    with open(FIXTURES_PATH) as f:
        return json.load(f)


async def get_or_create_org(syn, name):
    try:
        return await Organization(name=name).get_async(synapse_client=syn)
    except Exception:
        print(f"  creating Organization {name}")
        return await Organization(name=name).store_async(synapse_client=syn)


async def get_or_create_named(cls, syn, org, name, **fields):
    """Org-scoped search resources have no delete, so reuse one by name when it exists.
    An existing one is left as-is -- rerunning never rewrites a resource a past run made."""
    for existing in await cls.list_async(organization_name=org, synapse_client=syn):
        if existing.name == name:
            return existing
    print(f"  creating {cls.__name__} {org}-{name}")
    return await cls(organization_name=org, name=name, **fields).store_async(synapse_client=syn)


def pipeline_settings(weights, normalization="min_max", combination="arithmetic_mean"):
    proc = {"normalization": {"technique": normalization}, "combination": {"technique": combination}}
    if weights is not None:
        proc["combination"]["parameters"] = {"weights": weights}
    return {"phase_results_processors": [{"normalization-processor": proc}]}


async def run_query(index, syn, parts=(SearchQueryPart.HITS, SearchQueryPart.TOTAL_HITS), job_timeout=120, **query):
    return await index.query_async(
        search_query=SearchQuery(**query), response_parts=list(parts), job_timeout=job_timeout,
        synapse_client=syn,
    )


async def wait_for_build(index, syn, timeout_sec=1800, poll_sec=10):
    """Poll until the index answers a match_all. Returns None when built, or the
    build-failure reason (which is how a failed build is reported to a client).

    While an index builds, a query job stays PROCESSING rather than failing, so each
    poll is a short-timeout job and a timeout just means "not yet"."""
    start = time.monotonic()
    while time.monotonic() - start < timeout_sec:
        try:
            res = await run_query(index, syn, job_timeout=30, query={"match_all": {}}, size=1)
            if res.total_hits:
                print(f"  {index.name}: built ({res.total_hits} rows, {time.monotonic() - start:.0f}s)")
                return None
        except SynapseTimeoutError:
            print(f"  {index.name}: still building ({time.monotonic() - start:.0f}s)")
            continue
        except Exception as e:  # noqa: BLE001 - the reason text is the result
            msg = str(e)
            if "build failed" in msg:
                return msg
            if "still building" not in msg:
                raise
        await asyncio.sleep(poll_sec)
    raise TimeoutError(f"{index.name} did not finish building in {timeout_sec}s")

