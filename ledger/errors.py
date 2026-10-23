"""Exception types for the ledger reporting tool.

These exceptions are intentionally small and dependency-free: ``cli.py`` and
``parser.py`` raise them, and ``cli.py`` is responsible for turning them into
the documented process behaviour (exit code and stderr message).
"""


class DataError(Exception):
    """A malformed CSV header or data row.

    Carries the 1-based line number in the source file and a short,
    human-readable reason. Its string form is exactly ``line N: <reason>`` so
    callers can print the exception directly to stderr.
    """

    def __init__(self, line, reason):
        self.line = line
        self.reason = reason
        super().__init__(f"line {line}: {reason}")

    def __str__(self):
        return f"line {self.line}: {self.reason}"


class UsageError(Exception):
    """Invalid command-line usage or arguments.

    Raised for argument problems that are not already handled by argparse.
    ``cli.py`` is expected to print the message on stderr and exit with
    status 2.
    """
