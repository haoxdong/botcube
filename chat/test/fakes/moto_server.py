"""moto_server for the suite, answering DynamoDB one request at a time, without keeping its table copies.

moto 5.2.3 copies each table a transaction touches and restores the copy when the transaction
is cancelled, undoing what another request wrote meanwhile; DynamoDB isolates transactions.
Each copy's models also stay listed for moto's dashboard, so the heap grows with every
transaction until a full garbage collection stalls a request for seconds.
Drop this launcher once moto isolates concurrent transactions and frees the copies itself.
Other services stay concurrent: an SQS receive long-polls.
"""

import os
import sys
from threading import Lock, Thread

import moto.server
from moto.core.common_models import BaseModel


def exit_on_parent_end():
    sys.stdin.read()
    os._exit(0)


Thread(target=exit_on_parent_end, daemon=True).start()

run_simple = moto.server.run_simple
dynamodb = Lock()


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
moto.server.run_simple = lambda host, port, app, **options: run_simple(host, port, isolating_dynamodb(app), **options)
moto.server.main()
