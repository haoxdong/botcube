from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]


def run_in_fresh_tools_python(site: Path, code: str) -> subprocess.CompletedProcess[str]:
    shutil.copy(TOOLS / 'botcube_plotly.py', site)
    (site / 'botcube_plotly.pth').write_text('import botcube_plotly\n')
    return subprocess.run([sys.executable, '-c', f'import site; site.addsitedir({str(site)!r})\n{code}'],
                          capture_output=True, text=True, check=False)


@pytest.mark.integration
def test_a_saved_figure_carries_the_botcube_look_without_asking(tmp_path: Path) -> None:
    chart = tmp_path / 'chart.plotly.json'
    result = run_in_fresh_tools_python(tmp_path, f"""
import plotly.express as px
px.bar(x=['a', 'b'], y=[3, 4], title='Oil').write_json({str(chart)!r})
""")
    assert result.returncode == 0, result.stderr
    layout = json.loads(chart.read_text())['layout']['template']['layout']
    assert layout['colorway'] == ['#0090ff', '#f76b15', '#30a46c', '#e5484d', '#6e56cf', '#12a594', '#ffc53d', '#d6409f']
    assert layout['font']['size'] == 13 and layout['font']['color'] == '#646464'
    assert layout['font']['family'].startswith('-apple-system')
    for axis in (layout['xaxis'], layout['yaxis']):
        assert axis['showgrid'] is False and axis['ticks'] == 'outside'
        assert axis['linecolor'] == axis['tickcolor'] == '#e8e8e8'


@pytest.mark.integration
def test_an_agents_own_template_and_the_builtins_stay_as_plotly_has_them(tmp_path: Path) -> None:
    result = run_in_fresh_tools_python(tmp_path, """
import json
import plotly.graph_objects as go
from plotly import io as pio
own = json.loads(go.Figure(layout={'template': 'plotly_dark'}).to_json())['layout']['template']['layout']
print(own['paper_bgcolor'], pio.templates['simple_white'].layout.colorway[0])
""")
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ['rgb(17,17,17)', '#1F77B4']


@pytest.mark.integration
def test_python_that_draws_no_chart_does_not_load_plotly(tmp_path: Path) -> None:
    result = run_in_fresh_tools_python(tmp_path, "import sys; print('plotly' in sys.modules)")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'False'
