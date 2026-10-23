"""Entry point enabling ``python -m ledger`` to run the CLI.

Executed by the interpreter as the ``__main__`` module, so it simply defers to
``ledger.cli.main`` and forwards its return value to :func:`sys.exit`.
"""

import sys

from . import cli


if __name__ == "__main__":
    sys.exit(cli.main(sys.argv[1:]))
