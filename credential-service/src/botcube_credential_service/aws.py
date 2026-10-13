from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .vault import Boto3KmsDataKeyProvider

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import DynamoDBServiceResource


def vault_aws(kms_key_id: str, region_name: str | None = None) -> tuple[DynamoDBServiceResource, Boto3KmsDataKeyProvider]:
    """The DynamoDB and KMS clients every Vault uses, in the Credential Service's region.

    They retry transient failures with backoff: a rotated refresh token's write-back has no other retry.
    """
    import boto3
    from botocore.config import Config

    region = region_name
    config = Config(retries={'mode': 'standard', 'total_max_attempts': 10})
    kms = boto3.client('kms', region_name=region, config=config)
    return (
        boto3.resource('dynamodb', region_name=region, config=config),
        Boto3KmsDataKeyProvider(key_id=kms_key_id, client=kms),
    )


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
