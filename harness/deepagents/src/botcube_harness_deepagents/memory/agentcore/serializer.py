from __future__ import annotations

from typing import Any

import zstandard
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

_COMPRESSION_SUFFIX = '+zstd'


class CompressedSerializer(JsonPlusSerializer):
    def __init__(self, *, compress: bool = False) -> None:
        super().__init__()
        self.compress = compress

    def dumps_typed(self, obj: Any) -> tuple[str, bytes]:
        kind, payload = super().dumps_typed(obj)
        if not self.compress or len(payload) < 4096:
            return kind, payload
        compressed = zstandard.compress(payload, level=1)
        return (kind + _COMPRESSION_SUFFIX, compressed) if len(compressed) < len(payload) else (kind, payload)

    def loads_typed(self, data: tuple[str, bytes]) -> Any:
        kind, payload = data
        if kind.endswith(_COMPRESSION_SUFFIX):
            data = kind.removesuffix(_COMPRESSION_SUFFIX), zstandard.decompress(payload)
        return super().loads_typed(data)
