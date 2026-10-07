from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(description='Read the template site data.')
    parser.add_argument('command', choices=['data'])
    parser.parse_args()
    url = os.environ.get('TEMPLATE_CREDENTIAL_SERVICE_URL')
    invocation = os.environ.get('TEMPLATE_CREDENTIAL_INVOCATION')
    session = os.environ.get('TEMPLATE_CREDENTIAL_SESSION')
    if not url or not invocation or not session:
        parser.exit(1, 'Template site sign-in needed. Credential Service invocation is required.\n')
    request = Request(f'{url.rstrip("/")}/fake-site/data', headers={'Authorization': f'Bearer {invocation}', 'X-Template-Session': session})
    try:
        with urlopen(request, timeout=10) as response:
            data = json.load(response)
    except HTTPError as error:
        parser.exit(1, 'Template site sign-in needed.\n' if error.code == 401 else f'Template site HTTP {error.code}.\n')
    except (URLError, OSError, ValueError) as error:
        parser.exit(1, f'Template site request failed: {error}.\n')
    sys.stdout.write(json.dumps(data) + '\n')
