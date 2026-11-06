from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping

from opentelemetry import trace

from .trace_secrets import cookie_secrets, environment_secrets, strip_secrets

log = logging.getLogger(__name__)
_CHUNK_CHARACTERS = 16000
# A curl command an answer quotes in prose or Markdown code, up to the end of its line or code span.
_QUOTED_CURL = re.compile(r'\bcurl\s[^\n`]*')


def retain(output: str, environment: Mapping[str, str]) -> None:
    context = trace.get_current_span().get_span_context()
    if not context.is_valid or not output:
        return
    # The redactor reads curl's credential options only where curl starts a command, so each quoted command is read alone.
    # Its credentials are then stripped wherever else the answer repeats them.
    known = environment_secrets(environment)
    quoted = [secret for match in _QUOTED_CURL.finditer(output) for secret in cookie_secrets(match.group())]
    output = _QUOTED_CURL.sub(lambda match: strip_secrets(match.group(), known), output)
    output = strip_secrets(output, sorted(known + quoted, key=len, reverse=True))
    chunks = [output[index:index + _CHUNK_CHARACTERS] for index in range(0, len(output), _CHUNK_CHARACTERS)]
    for index, chunk in enumerate(chunks):
        log.info(json.dumps({
            'event': 'harness_turn_output',
            'traceId': format(context.trace_id, '032x'),
            'spanId': format(context.span_id, '016x'),
            'output': chunk,
            'chunkIndex': index,
            'chunkCount': len(chunks),
        }, separators=(',', ':')))
