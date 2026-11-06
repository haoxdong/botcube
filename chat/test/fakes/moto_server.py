"""moto_server for the suite, answering DynamoDB one request at a time, without keeping its table copies.

moto 5.2.3 copies each table a transaction touches and restores the copy when the transaction
is cancelled, undoing what another request wrote meanwhile; DynamoDB isolates transactions.
Each copy's models also stay listed for moto's dashboard, so the heap grows with every
transaction until a full garbage collection stalls a request for seconds.
Drop this launcher once moto isolates concurrent transactions and frees the copies itself.
Other services stay concurrent: an SQS receive long-polls.
"""

import json
import os
import sys
from threading import Lock, Thread
from urllib.parse import parse_qs

import moto.server
from moto.core.common_models import BaseModel


def exit_on_parent_end():
    sys.stdin.read()
    os._exit(0)


Thread(target=exit_on_parent_end, daemon=True).start()

run_simple = moto.server.run_simple
dynamodb = Lock()
scheduler_deletes = Lock()
deleted_requests = {}


def idempotent_scheduler_deletes(app):
    # Moto ignores ClientToken. AWS replays successful DeleteSchedule requests with the same token.
    # https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteSchedule.html
    def serve(environ, start_response):
        query = parse_qs(environ.get('QUERY_STRING', ''))
        token = query.get('clientToken', [None])[0]
        if environ.get('REQUEST_METHOD') != 'DELETE' or not environ.get('PATH_INFO', '').startswith('/schedules/') or token is None:
            return app(environ, start_response)
        identity = (environ['PATH_INFO'], query.get('groupName', ['default'])[0])
        with scheduler_deletes:
            saved = deleted_requests.get(token)
            if saved is not None:
                if saved[0] != identity:
                    start_response('409 Conflict', [('Content-Type', 'application/json'), ('x-amzn-errortype', 'ConflictException')])
                    return [json.dumps({'Message': 'ClientToken reused for a different request'}).encode()]
                start_response(saved[1], saved[2])
                return saved[3]
            result = []

            def capture(status, headers, exc_info=None):
                result.extend([status, headers])
                return start_response(status, headers, exc_info)

            response = app(environ, capture)
            try:
                body = list(response)
            finally:
                getattr(response, 'close', lambda: None)()
            if result[0].startswith('200 '):
                deleted_requests[token] = (identity, result[0], result[1], body)
            return body

    return serve


def isolating_dynamodb(app):
    def serve(environ, start_response):
        if not environ.get('HTTP_X_AMZ_TARGET', '').startswith('DynamoDB_'):
            return app(environ, start_response)
        with dynamodb:
            response = app(environ, start_response)
            try:
                return list(response)
            finally:
                getattr(response, 'close', lambda: None)()

    return serve


tracked = BaseModel.__new__


def untracked_dynamodb(cls, *args, **kwargs):
    if cls.__module__.startswith('moto.dynamodb.'):
        return object.__new__(cls)
    return tracked(cls, *args, **kwargs)


BaseModel.__new__ = staticmethod(untracked_dynamodb)
moto.server.run_simple = lambda host, port, app, **options: run_simple(host, port, isolating_dynamodb(idempotent_scheduler_deletes(app)), **options)
moto.server.main()
