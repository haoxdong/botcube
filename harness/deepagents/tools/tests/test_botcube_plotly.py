from __future__ import annotations

import base64
import json
import shutil
import struct
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


@pytest.mark.integration
@pytest.mark.parametrize('kind', ['line', 'bar'])
def test_saved_charts_use_the_approved_theme_despite_agent_overrides(tmp_path: Path, kind: str) -> None:
    chart = tmp_path / 'chart.plotly.json'
    result = run_in_fresh_tools_python(tmp_path, f"""
import plotly.express as px
figure = px.{kind}(x=['2026-11-05', '2026-11-06'], y=[[7676.77, 7800], [29273.405, 29500]],
                   template='plotly_white', color_discrete_sequence=['#1765b5', '#e76f24'])
figure.update_layout(title='SPX and NDX', yaxis_title='Close', hovermode='x unified')
figure.write_json({str(chart)!r})
""")
    assert result.returncode == 0, result.stderr
    saved = json.loads(chart.read_text())
    layout = saved['layout']
    theme = layout['template']['layout']
    assert theme['font']['size'] == 13
    assert theme['font']['color'] == '#646464'
    assert theme['font']['family'].startswith('-apple-system')
    for axis in (theme['xaxis'], theme['yaxis']):
        assert axis['showgrid'] is False
        assert axis['showline'] is True
        assert axis['ticks'] == 'outside'
        assert axis['ticklen'] == 4
        assert axis['linecolor'] == axis['tickcolor'] == '#e8e8e8'
    colour_key = 'line' if kind == 'line' else 'marker'
    assert [trace[colour_key]['color'] for trace in saved['data']] == ['#0090ff', '#f76b15']
    assert [list(struct.unpack('<2d', base64.b64decode(trace['y']['bdata']))) for trace in saved['data']] == [
        [7676.77, 7800], [29273.405, 29500],
    ]
    assert layout['title']['text'] == 'SPX and NDX'
    assert layout['yaxis']['title']['text'] == 'Close'
    assert layout['hovermode'] == 'x unified'


@pytest.mark.integration
def test_saving_the_theme_preserves_the_source_and_numeric_colour_data_and_refuses_bad_figures(tmp_path: Path) -> None:
    chart = tmp_path / 'chart.plotly.json'
    result = run_in_fresh_tools_python(tmp_path, f"""
import json
from io import StringIO
import plotly.graph_objects as go
import plotly.io as pio
figure = go.Figure(go.Scatter(x=[1, 2], y=[3, 4], marker={{'color': [10, 20], 'colorscale': 'Viridis'}}))
figure.update_layout(template='plotly_white', font={{'size': 12, 'color': '#2a3f5f'}},
                     xaxis={{'showgrid': True, 'showline': False, 'ticks': ''}}, yaxis2={{'showgrid': True}})
before = figure.to_json()
figure.write_json({str(chart)!r})
assert figure.to_json() == before
stream = StringIO()
pio.write_json(figure.to_dict(), stream, pretty=True)
assert json.loads(stream.getvalue()) == json.load(open({str(chart)!r}))
try:
    pio.write_json({{'data': [{{'type': 'not-a-chart'}}]}}, StringIO())
except ValueError:
    print('invalid figure refused')
else:
    raise AssertionError('invalid figure accepted')
""")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'invalid figure refused'
    saved = json.loads(chart.read_text())
    assert saved['data'][0]['marker']['color'] == [10, 20]
    assert saved['data'][0]['marker']['colorscale'][0] == [0.0, '#440154']
    assert saved['layout']['font']['size'] == 13
    assert saved['layout']['font']['color'] == '#646464'
    for axis in ('xaxis', 'yaxis2'):
        assert saved['layout'][axis]['showgrid'] is False
        assert saved['layout'][axis]['showline'] is True
        assert saved['layout'][axis]['ticks'] == 'outside'
