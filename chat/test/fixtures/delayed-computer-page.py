#!/usr/bin/env python3
import os
import re
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request

child = subprocess.Popen(
    [os.environ["REAL_CHROMIUM"], *sys.argv[1:-1], "--no-startup-window"],
    stderr=subprocess.PIPE,
    text=True,
)


def stop(_signal, _frame):
    child.terminate()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
try:
    for line in child.stderr:
        sys.stderr.write(line)
        sys.stderr.flush()
        match = re.search(r"DevTools listening on ws://([^/]+)", line)
        if match:
            time.sleep(0.5)
            request = urllib.request.Request(
                "http://" + match[1] + "/json/new?" + urllib.parse.quote(sys.argv[-1]),
                method="PUT",
            )
            with urllib.request.urlopen(request) as response:
                response.read()
finally:
    child.terminate()
    child.wait()
