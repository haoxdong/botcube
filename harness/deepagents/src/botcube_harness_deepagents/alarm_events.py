import json
from importlib.resources import files

_events = json.loads(files("botcube_harness_deepagents").joinpath('alarm-events.json').read_text(encoding='utf-8'))

FILES_MOUNT_ERROR_CODE: str = _events['filesMountErrorCode']
SESSION_PURGE_DELETED: str = _events['sessionPurgeDeleted']
