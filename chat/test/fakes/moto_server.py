"""moto_server for the suite, answering DynamoDB one request at a time.

moto 5.2.3 copies each table a transaction touches and restores the copy when the transaction
is cancelled, undoing what another request wrote meanwhile; DynamoDB isolates transactions.
Drop this launcher once moto isolates concurrent transactions itself.
Other services stay concurrent: an SQS receive long-polls.
"""

import os
import sys
from threading import Lock, Thread

import moto.server


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


moto.server.run_simple = lambda host, port, app, **options: run_simple(host, port, isolating_dynamodb(app), **options)
moto.server.main()
