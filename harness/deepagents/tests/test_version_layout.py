"""The version store's layout has one definition, artifact-check's versions.json, which the web app reads too."""

from botcube_harness_deepagents import artifact_check, files
from botcube_harness_deepagents.artifact_types import TYPES


def test_the_harness_stores_versions_in_the_shared_layout():
    # files.py stays free of the checker's folder: the session API image ships the Harness without it.
    assert files.ARTIFACTS_DIRECTORY == artifact_check.STORE
    assert {kind.name or 'page': kind.suffix for kind in TYPES} == artifact_check.SUFFIXES
