from __future__ import annotations

import importlib

import langsmith.utils

# Importing the package turns LangSmith tracing off.
importlib.import_module('botcube_harness_deepagents')


def test_the_suite_sends_no_runs_to_langsmith() -> None:
    assert not langsmith.utils.tracing_is_enabled()
