"""Run the unittest suite and record the result to test_report.txt.

Usage: python run_tests.py
"""
import subprocess
import sys
from pathlib import Path

REPORT = Path(__file__).with_name("test_report.txt")


def main():
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "-v"],
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    REPORT.write_text(output, encoding="utf-8")
    sys.stdout.write(output)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
