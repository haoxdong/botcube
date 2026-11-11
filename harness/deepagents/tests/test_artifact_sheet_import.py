"""A Sheet's `importFile` edit: a table the agent computed and saved as an `.xlsx` or `.csv` File, imported into new sheets.

Files keep no versions, so a publish keeps a copy of every File a Sheet imports, named by its content, and the
version's record names the copy for each import step: the Viewer, the Excel Export and every later replay read that
copy, never the File.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.artifact import artifact_tool

pytestmark = pytest.mark.integration

VERSIONS = '/artifacts/sheets/q4.sheet.json.versions'
# The harness copies the bytes and never reads them; the Viewer does.
XLSX = b'PK\x03\x04 an openpyxl workbook'
CSV = b'Region,Orders\nNorth,120\nSouth,95\n'
IMPORTS = [
    {'kind': 'importFile', 'asset': '/data/orders.xlsx'},
    {'kind': 'importFile', 'asset': 'data/regions.csv'},
    {'kind': 'formatCells', 'sheet': 'regions', 'ranges': ['A1:B1'], 'format': {'font': {'bold': True}}},
]


def call(root: Path, skills: tuple[str, ...] = (), **args: str) -> ToolMessage:
    result = artifact_tool(root, skills).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'publish', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def write(root: Path, path: str, data: bytes) -> None:
    (root / path).parent.mkdir(parents=True, exist_ok=True)
    (root / path).write_bytes(data)


def write_sheet(root: Path, edits: Sequence[Mapping[str, object]]) -> None:
    write(root, 'sheets/q4.sheet.json', json.dumps({'edits': edits}).encode())


def copy_of(data: bytes, extension: str) -> str:
    return f'{VERSIONS}/imports/{hashlib.sha256(data).hexdigest()}.{extension}'


def refused(root: Path, skills: tuple[str, ...] = ()) -> str:
    with pytest.raises(ValueError) as refusal:
        call(root, skills, file_path='/sheets/q4.sheet.json')
    versions = root / VERSIONS.lstrip('/')
    assert not versions.exists() or not any(versions.iterdir())
    return str(refusal.value)


def test_a_sheet_importing_an_xlsx_and_a_csv_keeps_a_copy_of_each_named_by_its_version(tmp_path: Path) -> None:
    write(tmp_path, 'data/orders.xlsx', XLSX)
    write(tmp_path, 'data/regions.csv', CSV)
    write_sheet(tmp_path, IMPORTS)

    call(tmp_path, file_path='/sheets/q4.sheet.json')

    record = json.loads((tmp_path / VERSIONS.lstrip('/') / '1.json').read_text())
    assert record['imports'] == [
        {'edit': 0, 'from': '/data/orders.xlsx', 'path': copy_of(XLSX, 'xlsx')},
        {'edit': 1, 'from': '/data/regions.csv', 'path': copy_of(CSV, 'csv')},
    ]
    assert (tmp_path / copy_of(XLSX, 'xlsx').lstrip('/')).read_bytes() == XLSX
    assert (tmp_path / copy_of(CSV, 'csv').lstrip('/')).read_bytes() == CSV
    read = json.loads(str(call(tmp_path, action='read', url='/sheets/q4.sheet.json').content))
    assert json.loads(read['sheet']) == {'edits': IMPORTS}
    assert read['imports'] == record['imports']


def test_an_import_naming_a_missing_file_is_refused_with_the_edit_and_the_path_and_nothing_is_saved(tmp_path: Path) -> None:
    write(tmp_path, 'data/orders.xlsx', XLSX)
    write_sheet(tmp_path, IMPORTS)

    assert refused(tmp_path) == (
        'The Sheet imports a File that is not in Files, so nothing was published. Save it there, then publish again:\n'
        '- q4.sheet.json edit 1 (importFile) — asset: no File at /data/regions.csv'
    )


def test_an_import_from_a_skill_folder_is_refused_as_not_in_files(tmp_path: Path) -> None:
    write(tmp_path, 'skills/finance/orders.xlsx', XLSX)
    write_sheet(tmp_path, [{'kind': 'importFile', 'asset': '/skills/finance/orders.xlsx'}])

    assert refused(tmp_path, ('/skills/',)).endswith('- q4.sheet.json edit 0 (importFile) — asset: no File at /skills/finance/orders.xlsx')


def test_an_import_of_another_file_type_is_refused_by_the_checker(tmp_path: Path) -> None:
    write(tmp_path, 'data/orders.json', b'[]')
    write_sheet(tmp_path, [{'kind': 'importFile', 'asset': '/data/orders.json'}])

    errors = [line for line in refused(tmp_path).splitlines() if line.startswith('- ')]

    assert errors == [(
        '- q4.sheet.json edit 0 (importFile) — asset is "/data/orders.json", which it does not take. '
        'Nearest: an .xlsx or a .csv File in Files, such as /data/orders.xlsx.'
    )]


def test_a_version_keeps_its_import_after_the_file_changes_or_is_deleted(tmp_path: Path) -> None:
    write(tmp_path, 'data/orders.xlsx', XLSX)
    write_sheet(tmp_path, [{'kind': 'importFile', 'asset': '/data/orders.xlsx'}])
    call(tmp_path, file_path='/sheets/q4.sheet.json')

    write(tmp_path, 'data/orders.xlsx', b'PK\x03\x04 recomputed')
    call(tmp_path, file_path='/sheets/q4.sheet.json')
    (tmp_path / 'data/orders.xlsx').unlink()

    assert (tmp_path / copy_of(XLSX, 'xlsx').lstrip('/')).read_bytes() == XLSX
    read = json.loads(str(call(tmp_path, action='read', url='/sheets/q4.sheet.json').content))
    assert read['version'] == 2
    assert read['imports'] == [{'edit': 0, 'from': '/data/orders.xlsx', 'path': copy_of(b'PK\x03\x04 recomputed', 'xlsx')}]
