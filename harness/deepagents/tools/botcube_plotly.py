"""BotCube's in-chat chart look (DESIGN.md, Charts) as plotly.py's default template, so every figure the agent saves
with `fig.write_json` carries it. A `.pth` line imports this module when the tools interpreter starts; the template is
built only once plotly's `io` module has loaded, so Python that draws no chart starts no slower."""

import importlib.abc
import importlib.machinery
import sys
from collections.abc import Sequence
from functools import wraps
from types import ModuleType

FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
TEXT = '#202020'
TEXT_MUTED = '#646464'
LINE = '#e8e8e8'
WHITE = '#ffffff'
COLORWAY = ['#0090ff', '#f76b15', '#30a46c', '#e5484d', '#6e56cf', '#12a594', '#ffc53d', '#d6409f']


def register() -> None:
    from plotly import io as pio
    from plotly.graph_objs.layout import Template

    axis = {'showgrid': False, 'linecolor': LINE, 'tickcolor': LINE, 'ticklen': 4, 'zerolinecolor': LINE}
    pio.templates['botcube'] = Template(pio.templates['simple_white']).update(layout={
        'font': {'family': FONT, 'size': 13, 'color': TEXT_MUTED},
        'colorway': COLORWAY,
        'xaxis': axis,
        'yaxis': axis,
        'hoverlabel': {'bgcolor': WHITE, 'bordercolor': LINE, 'font': {'family': FONT, 'size': 13, 'color': TEXT}},
    })
    pio.templates.default = 'botcube'
    original_write_json = pio.write_json

    @wraps(original_write_json)
    def write_json(fig: object, *args: object, **kwargs: object) -> None:
        from plotly.graph_objs import Figure

        figure = Figure(fig)
        theme = pio.templates['botcube'].layout
        figure.update_layout(template='botcube', font=theme.font)
        figure.for_each_xaxis(lambda axis: axis.update(theme.xaxis))
        figure.for_each_yaxis(lambda axis: axis.update(theme.yaxis))
        for index, trace in enumerate(figure.data):
            colour = COLORWAY[index % len(COLORWAY)]
            if trace.type in ('scatter', 'scattergl'):
                trace.line.color = colour
            if trace.type in ('scatter', 'scattergl', 'bar') and (
                trace.marker.color is None or isinstance(trace.marker.color, str)
            ):
                trace.marker.color = colour
        original_write_json(figure, *args, **kwargs)

    vars(pio)['write_json'] = write_json


class _RegisterOnImport(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Finds plotly's `io` module as Python would, then registers the template once the module has run: the module
    sets plotly's own default template as its last step, so this one must come after it."""

    def __init__(self) -> None:
        self.loader: importlib.abc.Loader | None = None

    def find_spec(self, fullname: str, path: Sequence[str] | None, target: ModuleType | None = None):
        if fullname.split('.') != ['plotly', 'io']:
            return None
        sys.meta_path.remove(self)
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is None or spec.loader is None:
            return spec
        self.loader, spec.loader = spec.loader, self
        return spec

    def create_module(self, spec: importlib.machinery.ModuleSpec):
        assert self.loader is not None
        return self.loader.create_module(spec)

    def exec_module(self, module: ModuleType) -> None:
        assert self.loader is not None
        self.loader.exec_module(module)
        register()


sys.meta_path.insert(0, _RegisterOnImport())
