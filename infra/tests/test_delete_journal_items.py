import pytest
from types_boto3_dynamodb.service_resource import Table

from deploy_script_support import load_deploy_script

cleanup = load_deploy_script('delete_journal_items', 'delete-journal-items.py')

# Key shapes of the former Journal (botcube_chat_service/journal.py before #2198).
JOURNAL_ITEMS = [
    {'pk': 'OWNER#account_61', 'sk': 'THREAD#thread-1', 'thread_key': 'THREAD#abc'},
    {'pk': 'OWNER#account_61', 'sk': 'JOURNAL#DELETED'},
    {'pk': 'THREAD#abc', 'sk': 'META'},
    {'pk': 'THREAD#abc', 'sk': 'DATA#ref#0', 'data': 'chunk'},
    {'pk': 'THREAD#abc', 'sk': 'RUN#run-1'},
    {'pk': 'THREAD#abc', 'sk': 'EVENT#e1'},
]
KEPT_ITEMS = [
    {'pk': 'ACCOUNT#acct-1', 'sk': 'META'},
    {'pk': 'PROVIDER#alice@example.com', 'sk': 'META'},
    {'pk': 'SESSIONS#acct-1', 'sk': 'SESSION#thread-1', 'session_id': 'thread-1'},
    {'pk': 'SESSIONS#acct-1', 'sk': 'DELETED'},
]


def _keys(table: Table) -> set[tuple[object, object]]:
    return {(item['pk'], item['sk']) for item in table.scan()['Items']}


def test_a_dry_run_counts_the_journal_items_and_deletes_nothing(chat_table: Table, capsys: pytest.CaptureFixture[str]) -> None:
    for item in JOURNAL_ITEMS + KEPT_ITEMS:
        chat_table.put_item(Item=item)

    cleanup.main(['--table', 'chat'])

    assert _keys(chat_table) == {(item['pk'], item['sk']) for item in JOURNAL_ITEMS + KEPT_ITEMS}
    output = capsys.readouterr().out
    assert 'OWNER#: 2' in output and 'THREAD#: 4' in output and 'dry run' in output
    assert 'account_61' not in output and 'abc' not in output  # account IDs are bearer secrets


def test_delete_removes_only_the_journal_items_and_a_rerun_finds_none(chat_table: Table, capsys: pytest.CaptureFixture[str]) -> None:
    for item in JOURNAL_ITEMS + KEPT_ITEMS:
        chat_table.put_item(Item=item)

    cleanup.main(['--table', 'chat', '--delete'])
    cleanup.main(['--table', 'chat', '--delete'])

    assert _keys(chat_table) == {(item['pk'], item['sk']) for item in KEPT_ITEMS}
    assert capsys.readouterr().out.splitlines()[-1] == 'Deleted 0 Journal items.'
