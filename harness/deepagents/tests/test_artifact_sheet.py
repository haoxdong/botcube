"""Publishing a Sheet with the `Artifact` tool: a `.sheet.json` file of sheet edits, checked before it is saved."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from botcube_harness_deepagents.artifact import artifact_tool
from botcube_harness_deepagents.artifact_check import CHECKER

pytestmark = pytest.mark.integration

SKILL_PAGE = CHECKER.parent.parent / 'skills/artifacts/SKILL.md'
KINDS = 'writeCells, formatCells, setBorders, setColumnWidths, fitColumns, setSheetSettings, mergeCells, setCellTable, importFile'

BUDGET = {'edits': [
    {'kind': 'writeCells', 'sheet': 'Budget', 'topLeft': 'A1',
     'rows': [['Item', 'Cost'], ['Rent', 1200], ['Food', 300], ['Total', '=SUM(B2:B3)']]},
    {'kind': 'formatCells', 'sheet': 'Budget', 'ranges': ['A1:B1', 'A4:B4'], 'format': {'font': {'bold': True}}},
]}


def call(root: Path, **args: str) -> ToolMessage:
    result = artifact_tool(root).invoke({'name': 'Artifact', 'type': 'tool_call', 'id': 'publish', 'args': args})
    assert isinstance(result, ToolMessage)
    return result


def write_sheet(root: Path, sheet: object) -> None:
    (root / 'sheets').mkdir(exist_ok=True)
    (root / 'sheets/budget.sheet.json').write_text(json.dumps(sheet), encoding='utf-8')


def refusals(root: Path, *edits: object) -> list[str]:
    """The errors a publish of a Sheet with `edits` is refused with, after checking it left no version behind."""
    write_sheet(root, {'edits': list(edits)})
    with pytest.raises(ValueError) as refused:
        call(root, file_path='/sheets/budget.sheet.json')
    assert str(refused.value).startswith('The Sheet breaks the sheet format, so nothing was published. Fix every error')
    versions = root / 'artifacts/sheets/budget.sheet.json.versions'
    assert not versions.exists() or not any(versions.iterdir())
    return [line for line in str(refused.value).splitlines() if line.startswith('- ')]


def test_an_edit_kind_a_sheet_does_not_take_is_refused_by_name_and_nothing_is_saved(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path,
        {'kind': 'renameSheet', 'sheet': 'Sheet1', 'name': 'Budget'},
        *BUDGET['edits'],
        {'kind': 'makeDropdown', 'sheet': 'Budget', 'range': 'C2:C3', 'options': []},
    )

    assert errors == [
        f'- budget.sheet.json edit 0 — kind "renameSheet" is not one a Sheet takes. Nearest: one of {KINDS}.',
        f'- budget.sheet.json edit 3 — kind "makeDropdown" is not one a Sheet takes. Nearest: one of {KINDS}.',
    ]


def skill_page_sheets() -> list[str]:
    page = SKILL_PAGE.read_text(encoding='utf-8')
    section = page[page.index('\n## Sheet\n'):]
    section = section[:section.find('\n## ', 1)] if '\n## ' in section[1:] else section
    return re.findall(r'```json\n(\{"edits".*?)\n```', section, re.DOTALL)


def test_every_sheet_example_in_the_skill_page_passes_the_checker(tmp_path: Path) -> None:
    examples = skill_page_sheets()
    assert len(examples) == 1
    for example in examples:
        write_sheet(tmp_path, json.loads(example))
        assert json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json').content))['type'] == 'sheet'


def test_the_skill_pages_example_keeps_an_open_ended_range_the_checker_lets_through(tmp_path: Path) -> None:
    # Google Sheets reads `F2:F` as F2 down to the last row; Excel, LibreOffice (#NAME?) and the grid (#VALUE!) have
    # no such range. A formula is a string the checker does not read, so the example publishes and the total shows as
    # an error. This pins the gap until the checker refuses such a range, a loader rewrites it, or the example changes.
    (example,) = skill_page_sheets()
    formulas = [value for edit in json.loads(example)['edits'] if edit['kind'] == 'writeCells'
                for row in edit['rows'] for value in row if isinstance(value, str) and value.startswith('=')]

    assert formulas == ['=SUM(B2:B3)', '=SUMIFS(F2:F,E2:E,FALSE)']
    write_sheet(tmp_path, {'edits': [{'kind': 'writeCells', 'sheet': 'Tasks', 'topLeft': 'I1', 'rows': [['=SUMIFS(F2:F,E2:E,FALSE)']]}]})
    assert json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json').content))['version'] == 1


def test_a_key_or_value_the_format_has_no_place_for_names_the_edit_and_the_allowed_form(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path,
        {'kind': 'writeCells', 'sheet': 'Budget', 'topLeft': 'b2', 'rows': [[1]]},
        {'kind': 'formatCells', 'sheet': 'Budget', 'ranges': ['A1'], 'format': {'font': {'weight': 700}}},
        {'kind': 'setColumnWidths', 'sheet': 'Budget', 'columns': 'A:B', 'width': 100},
    )

    assert errors == [
        '- budget.sheet.json edit 0 (writeCells) — topLeft is "b2", which it does not take. Nearest: one cell such as B2.',
        '- budget.sheet.json edit 1 (formatCells) — format.font has "weight", a key it does not take. '
        'Nearest: the keys of format.font: bold, italic, underline, strikethrough, size, color.',
        '- budget.sheet.json edit 2 (setColumnWidths) — widthInPixels is missing. Nearest: a width of 8 to 2000 pixels.',
        '- budget.sheet.json edit 2 (setColumnWidths) — the edit has "width", a key it does not take. '
        'Nearest: the keys of setColumnWidths: kind, sheet, columns, widthInPixels.',
    ]


def test_a_merge_overlapping_an_earlier_one_is_refused_naming_both_edits_and_the_merge_that_covers_both(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path, *BUDGET['edits'],
        {'kind': 'mergeCells', 'sheet': 'Budget', 'ranges': ['A6:B6']},
        {'kind': 'mergeCells', 'sheet': 'Other', 'ranges': ['A6:B6']},
        {'kind': 'mergeCells', 'sheet': 'Budget', 'ranges': ['D1:E1', 'B7:B6']},
    )

    assert errors == [
        '- budget.sheet.json edit 4 (mergeCells) — ranges[1] is "B7:B6", which overlaps "A6:B6" merged by edit 2, and Excel can\'t merge a '
        'cell twice. Nearest: one merge that covers both, such as "A6:B7", or a range that shares no cell with "A6:B6".',
    ]


# The grid (Univer's open-source core) and the Excel file draw neither a checkbox nor a table, so each is refused by
# its edit and field until both do, rather than published and silently dropped.
def test_a_checkbox_is_refused_naming_the_edit_the_field_and_the_values_to_write_instead(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path, *BUDGET['edits'],
        {'kind': 'formatCells', 'sheet': 'Budget', 'ranges': ['C2:C3'], 'format': {'cellControl': {'kind': 'checkbox'}}},
    )

    assert errors == [
        '- budget.sheet.json edit 2 (formatCells) — format.cellControl.kind is "checkbox", which neither the grid nor the Excel file '
        'draws yet. Nearest: {"kind": "none"}: write true or false in the cells instead of a checkbox.',
    ]


def test_a_table_whose_rows_would_band_is_refused_naming_the_edit_and_the_field(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path, *BUDGET['edits'],
        {'kind': 'setCellTable', 'sheet': 'Budget', 'cellTable': {'columns': 'A:B', 'headerRows': '1', 'footerRows': None}},
    )

    assert errors == [
        '- budget.sheet.json edit 2 (setCellTable) — cellTable is a table, whose banded rows neither the grid nor the Excel file draws '
        'yet. Nearest: cellTable null; for a header row, bold it with formatCells and freeze it with setSheetSettings '
        'lastFrozenRow.',
    ]


def test_a_tables_footer_rows_are_refused_naming_the_edit_and_the_field(tmp_path: Path) -> None:
    errors = refusals(
        tmp_path, *BUDGET['edits'],
        {'kind': 'setCellTable', 'sheet': 'Budget', 'cellTable': {'columns': 'A:B', 'headerRows': '1', 'footerRows': '4'}},
    )

    assert errors == [
        '- budget.sheet.json edit 2 (setCellTable) — cellTable.footerRows is "4": footer rows are a table\'s, which neither the grid nor '
        'the Excel file draws yet. Nearest: no table yet (cellTable null), with the totals written as cells by '
        'writeCells.',
    ]


def test_no_checkbox_and_no_table_are_taken(tmp_path: Path) -> None:
    write_sheet(tmp_path, {'edits': [
        *BUDGET['edits'],
        {'kind': 'formatCells', 'sheet': 'Budget', 'ranges': ['C2:C3'], 'format': {'cellControl': {'kind': 'none'}}},
        {'kind': 'setCellTable', 'sheet': 'Budget', 'cellTable': None},
    ]})

    assert json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json').content))['version'] == 1


@pytest.mark.parametrize('name', ['A sheet name of thirty-two chars', 'Q4: draft', 'Plan [v2]', 'a/b', 'a\\b', 'Why?', 'All*'])
def test_a_sheet_name_excel_does_not_take_is_refused(tmp_path: Path, name: str) -> None:
    errors = refusals(tmp_path, {'kind': 'fitColumns', 'sheet': name, 'columns': 'A'})

    assert errors == [
        f'- budget.sheet.json edit 0 (fitColumns) — sheet is {json.dumps(name)}, which Excel does not take as a sheet\'s name. '
        'Nearest: a sheet name of 1 to 31 characters with none of [ ] : * ? / \\.',
    ]


def test_a_sheet_name_of_31_characters_is_taken(tmp_path: Path) -> None:
    write_sheet(tmp_path, {'edits': [{'kind': 'fitColumns', 'sheet': 'A' * 31, 'columns': 'A'}]})

    assert json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json').content))['version'] == 1


def test_a_sheet_publishes_as_version_1_and_read_returns_its_edits(tmp_path: Path) -> None:
    write_sheet(tmp_path, BUDGET)

    published = json.loads(str(call(tmp_path, file_path='/sheets/budget.sheet.json', description='Monthly costs').content))

    assert published == {
        'id': '/sheets/budget.sheet.json', 'type': 'sheet', 'title': 'budget.sheet.json', 'description': 'Monthly costs',
        'version': 1, 'path': '/artifacts/sheets/budget.sheet.json.versions/1.sheet.json',
    }
    read = json.loads(str(call(tmp_path, action='read', url='/sheets/budget.sheet.json').content))
    assert json.loads(read['sheet']) == BUDGET
    assert read['versions'] == [
        {'version': 1, 'author': 'agent', 'path': '/artifacts/sheets/budget.sheet.json.versions/1.sheet.json'},
    ]

