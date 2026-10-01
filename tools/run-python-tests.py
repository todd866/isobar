#!/usr/bin/env python3
"""Run unittest discovery with a per-test alarm.

A hung test prints its name and exits. The default limit is 90s
(ISOBAR_PYTEST_TIMEOUT). This does not weaken a failing assertion.
"""
import os
import signal
import sys
import unittest

LIMIT = int(os.environ.get("ISOBAR_PYTEST_TIMEOUT", "90"))


class GuardedResult(unittest.TextTestResult):
    def startTest(self, test):
        super().startTest(test)
        name = test.id()

        def expired(signum, frame):
            print(f"FAIL {name} hung for more than {LIMIT}s", file=sys.stderr, flush=True)
            os._exit(1)

        signal.signal(signal.SIGALRM, expired)
        signal.alarm(LIMIT)

    def stopTest(self, test):
        signal.alarm(0)
        super().stopTest(test)


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "Tests"
    pattern = sys.argv[2] if len(sys.argv) > 2 else "test_*.py"
    suite = unittest.defaultTestLoader.discover(start, pattern=pattern)
    result = unittest.TextTestRunner(resultclass=GuardedResult, verbosity=1).run(suite)
    if not result.wasSuccessful():
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
