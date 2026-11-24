from __future__ import annotations

import json
from pathlib import Path

from .generated.resolved_config_types import FORMAT_VERSION, ResolvedConfig


def load_resolved_config(path: Path | str | None = None) -> ResolvedConfig:
    """Read the deploy's resolved config, or the packaged section defaults."""
    source = path if path is not None else Path(__file__).with_name('resolved-empty.json')
    try:
        config = json.loads(_read_config(source))
    except FileNotFoundError:
        raise
    except Exception as error:
        raise ValueError(f'Resolved BotCube Config {source}: {error}') from error
    version = config.get('formatVersion') if isinstance(config, dict) else None
    if type(version) is not int or version != FORMAT_VERSION:
        raise ValueError(f'Resolved BotCube Config {source}: expected formatVersion {FORMAT_VERSION}, got {version!r}')
    return config


def _read_config(source: Path | str) -> bytes:
    if isinstance(source, str) and source.startswith('s3://'):
        bucket, _, key = source.removeprefix('s3://').partition('/')
        if not bucket or not key:
            raise ValueError('expected s3://bucket/key')

        import boto3

        client = boto3.client('s3')
        try:
            with client.get_object(Bucket=bucket, Key=key)['Body'] as body:
                return body.read()
        finally:
            client.close()

    return Path(source).read_bytes()
