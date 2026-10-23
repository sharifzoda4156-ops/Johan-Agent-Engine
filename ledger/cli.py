"""Command-line interface for the ``ledger`` reporting tool.

Invoked through ``python -m ledger`` (see :mod:`ledger.__main__`)::

    python -m ledger report FILE [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--account PREFIX]

The ``report`` command parses a CSV ledger file, validates every row and
prints a JSON balance report on stdout.

Exit codes:

* ``0`` -- success, the JSON report was written to stdout
* ``1`` -- the input file could not be read (missing, unreadable, ...)
* ``2`` -- invalid command-line usage/arguments or malformed input data

Every error path writes exactly one human-readable message to stderr and
leaves stdout completely empty.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys

from .errors import DataError, UsageError

__all__ = ["build_parser", "main"]

#: Strict ``YYYY-MM-DD`` shape; calendar validity is checked afterwards.
_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def build_parser() -> argparse.ArgumentParser:
    """Build the ``ledger`` argument parser.

    Unknown or invalid arguments make argparse print a message to stderr and
    exit with status 2, which is exactly the documented CLI behaviour.
    """
    parser = argparse.ArgumentParser(
        prog="ledger",
        description="Report on a CSV ledger file.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    report = subparsers.add_parser(
        "report",
        help="print a JSON balance report for a CSV ledger file",
        description="Print a JSON balance report for a CSV ledger file.",
    )
    report.add_argument(
        "file",
        metavar="FILE",
        help="path to the CSV ledger file",
    )
    report.add_argument(
        "--from",
        dest="date_from",
        metavar="YYYY-MM-DD",
        default=None,
        help="only include transactions on or after this date",
    )
    report.add_argument(
        "--to",
        dest="date_to",
        metavar="YYYY-MM-DD",
        default=None,
        help="only include transactions on or before this date",
    )
    report.add_argument(
        "--account",
        dest="account",
        metavar="PREFIX",
        default=None,
        help="only include accounts whose name starts with PREFIX",
    )
    report.set_defaults(handler=_run_report)
    return parser


def _fail(message: str, code: int) -> int:
    """Write ``message`` to stderr (stdout stays untouched) and return ``code``."""
    print(message, file=sys.stderr)
    return code


def _parse_date(value: str) -> datetime.date | None:
    """Return a real calendar date for a ``YYYY-MM-DD`` string, else ``None``."""
    if not _DATE_PATTERN.match(value):
        return None
    try:
        return datetime.date(int(value[0:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        return None


def _run_report(args: argparse.Namespace) -> int:
    """Execute the ``report`` subcommand and return the process exit status."""
    # Imported lazily so that ``--help`` and usage errors keep working even
    # before (or independently of) the parsing/reporting modules.
    from . import parser as parser_module
    from . import report as report_module

    date_from = None
    if args.date_from is not None:
        date_from = _parse_date(args.date_from)
        if date_from is None:
            return _fail(
                f"invalid --from date: {args.date_from!r} (expected YYYY-MM-DD)",
                2,
            )

    date_to = None
    if args.date_to is not None:
        date_to = _parse_date(args.date_to)
        if date_to is None:
            return _fail(
                f"invalid --to date: {args.date_to!r} (expected YYYY-MM-DD)",
                2,
            )

    if date_from is not None and date_to is not None and date_from > date_to:
        return _fail(
            f"invalid date range: --from {args.date_from} is after --to {args.date_to}",
            2,
        )

    try:
        stream = open(args.file, "r", encoding="utf-8-sig", newline="")
    except FileNotFoundError:
        return _fail(f"cannot read {args.file}: no such file or directory", 1)
    except IsADirectoryError:
        return _fail(f"cannot read {args.file}: is a directory", 1)
    except PermissionError:
        return _fail(f"cannot read {args.file}: permission denied", 1)
    except OSError as exc:
        detail = exc.strerror or str(exc)
        return _fail(f"cannot read {args.file}: {detail}", 1)

    with stream:
        try:
            rows = parser_module.load_rows(stream)
        except DataError as exc:
            return _fail(str(exc), 2)
        except UsageError as exc:
            return _fail(str(exc), 2)
        except UnicodeDecodeError as exc:
            return _fail(f"cannot decode {args.file}: {exc}", 1)

    try:
        result = report_module.build_report(
            rows,
            date_from=date_from,
            date_to=date_to,
            account=args.account,
        )
    except DataError as exc:
        return _fail(str(exc), 2)
    except UsageError as exc:
        return _fail(str(exc), 2)

    sys.stdout.write(json.dumps(result) + "\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse ``argv`` (defaulting to ``sys.argv[1:]``) and run the CLI.

    Returns the process exit status. argparse's own ``SystemExit`` for
    ``--help`` or invalid usage is deliberately not swallowed.
    """
    if argv is None:
        argv = sys.argv[1:]

    parser = build_parser()
    args = parser.parse_args(argv)

    handler = getattr(args, "handler", None)
    if handler is None:  # pragma: no cover - `required=True` already covers this
        parser.error("a command is required")

    return handler(args)
