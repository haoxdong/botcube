from __future__ import annotations

from typing import Any

import zstandard
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

_COMPRESSION_SUFFIX = '+zstd'


class CompressedReadingSerializer(JsonPlusSerializer):
    def loads_typed(self, data: tuple[str, bytes]) -> Any:
        kind, payload = data
        if kind.endswith(_COMPRESSION_SUFFIX):
            data = kind.removesuffix(_COMPRESSION_SUFFIX), zstandard.decompress(payload)
        return super().loads_typed(data)
