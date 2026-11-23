"""Count inline media for compaction and resize model-facing raster images."""

from __future__ import annotations

import asyncio
from base64 import b64decode, b64encode
from collections.abc import Awaitable, Callable, Generator, Iterable
from contextlib import contextmanager
from io import BytesIO
from math import ceil
from typing import Any

from deepagents.middleware.summarization import _extract_data_url, _is_context_overflow
from deepagents.middleware.unsupported_content import UnsupportedContentMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.exceptions import ContextOverflowError
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage
from langchain_core.messages.content import ContentBlock
from langchain_core.messages.utils import (
    MessageLikeRepresentation,
    convert_to_messages,
    count_tokens_approximately,
)
from langchain_core.tools import BaseTool
from openai import APIStatusError
from PIL import Image

# Reserve space below the 30 MB gateway limit for text, tools and framing.
_MEDIA_BYTES_AT_TRIGGER = 24_576_000
_RASTER_TYPES = {'image/gif', 'image/jpeg', 'image/png', 'image/webp'}


def count_request_tokens(
    messages: Iterable[MessageLikeRepresentation], *, media_trigger: int, tools: list[BaseTool | dict[str, Any]] | None = None,
) -> int:
    media_bytes = 0
    counted = []
    for message in convert_to_messages(messages):
        if not isinstance(message.content, list):
            counted.append(message)
            continue
        blocks = message.content_blocks
        content = []
        for block in blocks:
            data = _extract_data_url(block)
            if data is not None:
                media_bytes += len(data)
            if data is None or block['type'] == 'image':
                content.append(block)
        counted.append(message.model_copy(update={'content': content}) if len(content) != len(blocks) else message)
    return count_tokens_approximately(counted, tools=tools) + ceil(media_bytes * media_trigger / _MEDIA_BYTES_AT_TRIGGER)


def _resize(block: ContentBlock) -> ContentBlock:
    if block['type'] != 'image' or 'base64' not in block or block.get('mime_type') not in _RASTER_TYPES:
        return block
    try:
        with Image.open(BytesIO(b64decode(block['base64'], validate=True))) as image:
            if max(image.size) <= 2000:
                return block
            image.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
            buffer = BytesIO()
            image.save(buffer, format=image.format)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return block
    return {**block, 'base64': b64encode(buffer.getvalue()).decode('ascii')}


@contextmanager
def _normalize_gateway_refusal() -> Generator[None]:
    try:
        yield
    except APIStatusError as error:
        # DeepAgents 0.7.22 recognizes context wording, while the gateway can return a bare 413.
        if error.status_code == 413 and not _is_context_overflow(error):
            raise ContextOverflowError(str(error)) from error
        raise


class ModelRequestBounds(UnsupportedContentMiddleware):
    @property
    def name(self) -> str:
        return UnsupportedContentMiddleware.__name__

    def _filter_message(self, message: AnyMessage, *, model: BaseChatModel) -> AnyMessage:
        filtered = super()._filter_message(message, model=model)
        if not isinstance(filtered.content, list):
            return filtered
        blocks = filtered.content_blocks
        resized = [_resize(block) for block in blocks]
        return filtered if resized == blocks else filtered.model_copy(update={'content': resized})

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        with _normalize_gateway_refusal():
            return super().wrap_model_call(request, handler)

    async def awrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        filtered = await asyncio.to_thread(self._filter_request, request)
        with _normalize_gateway_refusal():
            return await handler(filtered)
