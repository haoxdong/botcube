import re
import tomllib
import unittest
from pathlib import Path

INFRA = Path(__file__).resolve().parents[1]


class TransitionSdkTests(unittest.TestCase):
    """The transition Lambda bundles the SDK the tests run against, not the runtime's older built-in one."""

    def test_bundled_pins_are_the_locked_boto3_and_its_dependencies(self):
        packages = {package['name']: package for package in tomllib.loads((INFRA / 'uv.lock').read_text())['package']}
        needed, queue = set(), ['boto3']
        while queue:
            name = queue.pop()
            if name not in needed:
                needed.add(name)
                queue += [dependency['name'] for dependency in packages[name].get('dependencies', [])]
        locked = {name: (packages[name]['version'], packages[name]['wheels'][0]['hash']) for name in needed}
        pinned = {name: (version, digest) for name, version, digest in
                  re.findall(r'^(\S+)==(\S+) --hash=(\S+)$', (INFRA / 'transition-requirements.txt').read_text(), re.M)}
        self.assertEqual(pinned, locked)


if __name__ == '__main__':
    unittest.main()
