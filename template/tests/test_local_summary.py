import threading

import httpx

from botcube_template.fake_site import FakeSiteServer


def test_local_summary_uses_converse_and_rejects_unsupported_tools() -> None:
    site = FakeSiteServer(('127.0.0.1', 0))
    thread = threading.Thread(target=site.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{site.server_port}/model/local/converse'
    try:
        response = httpx.post(url, json={'toolConfig': {'toolChoice': {'tool': {'name': 'turn_summary'}}}})
        assert response.status_code == 200
        assert response.json() == {
            'output': {'message': {'role': 'assistant', 'content': [{'toolUse': {
                'toolUseId': 'local-summary', 'name': 'turn_summary',
                'input': {'title': 'Answered a question', 'summary': 'Replied to the user'},
            }}]}},
            'stopReason': 'tool_use',
        }
        unsupported = httpx.post(url, json={'toolConfig': {'toolChoice': {'tool': {'name': 'other'}}}})
        assert unsupported.status_code == 400
        assert unsupported.json() == {'error': 'Only turn_summary is supported'}
        malformed = httpx.post(url, content='not json')
        assert malformed.status_code == 400
        assert malformed.json() == {'error': 'Invalid Converse request'}
    finally:
        site.shutdown()
        site.server_close()
        thread.join(timeout=5)
