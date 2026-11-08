#!/usr/bin/env python3
from __future__ import annotations

import signal
import sys
import urllib.request

with urllib.request.urlopen(sys.argv[-1]) as response:
    response.read()
signal.pause()
