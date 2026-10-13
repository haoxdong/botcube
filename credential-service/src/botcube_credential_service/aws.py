from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from .vault import (
    Boto3KmsDataKeyProvider,
    DynamoDbCredentialVault,
    LocalDataKeyProvider,
)

if TYPE_CHECKING:
    from botocore.config import Config
    from types_boto3_dynamodb.service_resource import DynamoDBServiceResource


def env_vault(table_env: str, kms_key_env: str, *, local_key_env: str | None = None) -> DynamoDbCredentialVault:
    """The Vault its environment names: a DynamoDB table, keyed by KMS or, on a local stack, by a key file.

    Raises ValueError while unconfigured. AWS_ENDPOINT_URL_DYNAMODB points a local stack at its DynamoDB.
    """
    table_name = os.getenv(table_env, '').strip()
    kms_key_id = os.getenv(kms_key_env, '').strip()
    local_key = os.getenv(local_key_env, '').strip() if local_key_env else ''
    if not table_name or not (kms_key_id or local_key):
        key = f'{kms_key_env} (or {local_key_env})' if local_key_env else kms_key_env
        raise ValueError(f'{table_env} and {key} are required together')
    region = os.getenv('AGENTCORE_REGION') or os.getenv('AWS_REGION')
    if local_key:
        return DynamoDbCredentialVault(_dynamodb(region).Table(table_name), LocalDataKeyProvider(Path(local_key)))
    import boto3

    # Both clients retry transient failures with backoff: a rotated refresh token's write-back has no other retry.
    kms = boto3.client('kms', region_name=region, config=_retrying())
    return DynamoDbCredentialVault(_dynamodb(region).Table(table_name), Boto3KmsDataKeyProvider(key_id=kms_key_id, client=kms))


def _dynamodb(region_name: str | None) -> DynamoDBServiceResource:
    import boto3

    return boto3.resource('dynamodb', region_name=region_name, config=_retrying())


def _retrying() -> Config:
    from botocore.config import Config

    return Config(retries={'mode': 'standard', 'total_max_attempts': 10})


def positive_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f'{name} must be a positive integer') from exc
    if parsed <= 0:
        raise ValueError(f'{name} must be a positive integer')
    return parsed
