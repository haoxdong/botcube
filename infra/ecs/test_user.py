from __future__ import annotations

import secrets
import time
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from types_boto3_dynamodb.service_resource import Table


@contextmanager
def test_user(table: Table, origin: str, *, operator_token: str | None = None) -> Generator[tuple[urllib.request.OpenerDirector, str], None, None]:
    account_id = 'acct_' + secrets.token_urlsafe(24)
    bearer = 'test_' + secrets.token_urlsafe(32)
    now = int(time.time())
    account_key = {'pk': 'ACCOUNT#' + account_id, 'sk': 'META'}
    token_key = {'pk': 'TOKEN#' + bearer, 'sk': 'META'}
    client = urllib.request.build_opener(NoRedirect())
    client.addheaders = [('x-botcube-test-user', bearer)]
    try:
        table.put_item(Item={**account_key, 'record': {
            'version': 1, 'accountId': account_id, 'status': 'test', 'rateTier': 'test',
            'createdAt': now, 'updatedAt': now,
        }}, ConditionExpression='attribute_not_exists(pk)')
        table.put_item(Item={**token_key, 'expiresAt': now + 3600, 'record': {
            'accountId': account_id, 'kind': 'test-user', 'createdAt': now, 'expiresAt': now + 3600,
        }}, ConditionExpression='attribute_not_exists(pk)')
    except Exception:
        table.delete_item(Key=token_key)
        table.delete_item(Key=account_key)
        raise
    try:
        if operator_token is not None:
            provision = urllib.request.Request(origin + '/operator/test-user/connector', method='POST',
                                               headers={'authorization': 'Bearer ' + operator_token})
            with client.open(provision, timeout=180) as response:
                if response.status != 201:
                    raise RuntimeError('Operator Test User Connector refresh failed')
        yield client, account_id
    finally:
        cleanup = urllib.request.Request(origin + '/operator/test-user', method='DELETE')
        with client.open(cleanup, timeout=180) as response:
            if response.status != 204:
                raise RuntimeError('Operator Test User cleanup failed')
        page = table.query(KeyConditionExpression='pk = :owner',
                           ExpressionAttributeValues={':owner': 'SESSIONS#' + account_id},
                           ConsistentRead=True)
        while True:
            with table.batch_writer() as batch:
                for item in page.get('Items', []):
                    batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
            last_key = page.get('LastEvaluatedKey')
            if last_key is None:
                break
            page = table.query(KeyConditionExpression='pk = :owner',
                               ExpressionAttributeValues={':owner': 'SESSIONS#' + account_id},
                               ConsistentRead=True, ExclusiveStartKey=last_key)
        table.delete_item(Key=token_key)
        table.delete_item(Key=account_key)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: urllib.request.Request, fp: object, code: int, msg: str,
                         headers: object, newurl: str) -> None:
        raise RuntimeError('Operator Test User request was redirected')
