"""Offline lifecycle evidence; these tests do not claim a live replacement."""
import runpy
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

from deploy_script_support import DEPLOY_ECS

v = runpy.run_path(str(DEPLOY_ECS / 'verify-continuity.py'))


class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.report = {'completed': True, 'requestedMonotonicSeconds': 110,
            'deregistrationDelaySeconds': 3600, 'idleTimeoutSeconds': 3600,
            'observations': [
                {'oldTargetState': 'healthy', 'targetReadMonotonicSeconds': 119, 'observedMonotonicSeconds': 120},
                {'oldTargetState': 'draining', 'targetReadMonotonicSeconds': 130, 'observedMonotonicSeconds': 132},
                {'oldTargetState': 'draining', 'targetReadMonotonicSeconds': 140, 'observedMonotonicSeconds': 142}]}
        self.timing = {'requestMonotonicSeconds': 100, 'progressOffsetsSeconds': [1, 35, 190],
                       'terminalSeconds': 191, 'connectionClosedSeconds': 192, 'maxEventGapSeconds': 2}

    def test_success_requires_actual_progress_inside_bracketed_draining(self):
        v['verify_overlap'](self.report, self.timing)
        self.assertEqual(self.report['continuity']['progressDuringDrainingMonotonicSeconds'], [135])
        self.assertEqual(self.report['continuity']['requestToStreamCloseSeconds'], 182)

    def test_missing_overlap_early_finish_and_timing_failure_rejected(self):
        cases = [
            ('completed', False, 'did not complete'),
            ('requestedMonotonicSeconds', 100, 'prior tool progress'),
            ('observations', self.report['observations'][:2], 'bracketed'),
            ('deregistrationDelaySeconds', 180, 'Drain setting'),
            ('idleTimeoutSeconds', 60, 'idle timeout'),
        ]
        for key, value, error in cases:
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, error):
                v['verify_overlap']({**self.report, key: value}, self.timing)
        for progress in ([1, 25, 190], [1, 31, 190], [1, 141, 190]):
            with self.subTest(progress=progress), self.assertRaisesRegex(RuntimeError, 'bracketed'):
                v['verify_overlap'](self.report, {**self.timing, 'progressOffsetsSeconds': progress})
        with self.assertRaisesRegex(RuntimeError, 'finished before'):
            v['verify_overlap'](self.report, {**self.timing, 'terminalSeconds': 30})
        report = deepcopy(self.report)
        report['observations'][-1]['oldTargetState'] = 'unused'
        with self.assertRaisesRegex(RuntimeError, 'bracketed'):
            v['verify_overlap'](report, self.timing)

    def test_trigger_once_after_progress_without_blocking_reader_and_propagate_failure(self):
        started, finish = threading.Event(), threading.Event()
        calls = []
        def replace():
            calls.append('replace')
            started.set()
            if not finish.wait(5):
                raise RuntimeError('test synchronization timed out')
            raise RuntimeError('provider failed')
        with ThreadPoolExecutor(max_workers=1) as pool:
            probe = v['Continuity']({}, {}, {}, pool)
            probe.replace = replace
            self.assertIsNone(probe.future)
            try:
                probe.progress()
                self.assertTrue(started.wait(2))
                probe.progress()
                self.assertEqual(calls, ['replace'])
            finally:
                finish.set()
            with self.assertRaisesRegex(RuntimeError, 'provider failed'):
                probe.settle()
            with self.assertRaisesRegex(RuntimeError, 'provider failed'):
                probe.progress()
        probe = v['Continuity']({}, {}, {}, None)
        with self.assertRaisesRegex(RuntimeError, 'before replacement'):
            probe.before_replay({})


if __name__ == '__main__':
    unittest.main()
