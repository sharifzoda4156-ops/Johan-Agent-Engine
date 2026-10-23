"""Unit and integration tests for the ``ledger`` command-line tool.

Run from the repository root with::

    python -m unittest

The unit tests exercise :func:`ledger.parser.load_rows` and
:func:`ledger.report.build_report` directly. The integration tests spawn
``python -m ledger report FILE ...`` as a subprocess and check the exit
codes, the stdout/stderr behaviour and the JSON payload.
"""

from __future__ import annotations

import datetime
import decimal
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from ledger import parser, report
from ledger.errors import DataError

#: Repository root -- the directory that contains the ``ledger`` package.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: Canonical header used by most of the parser tests.
HEADER = "date,account,amount,currency,memo\n"


def load(text):
    """Parse ``text`` as CSV through :func:`ledger.parser.load_rows`."""
    return parser.load_rows(io.StringIO(text))


def run_cli(args):
    """Run ``python -m ledger <args>`` from the repository root."""
    return subprocess.run(
        [sys.executable, "-m", "ledger", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class HeaderTests(unittest.TestCase):
    """The first record must be a valid, complete, unambiguous header."""

    def test_empty_file_is_missing_header(self):
        with self.assertRaises(DataError) as ctx:
            load("")
        self.assertEqual(ctx.exception.line, 1)
        self.assertEqual(str(ctx.exception), "line 1: missing header row")

    def test_unknown_column(self):
        with self.assertRaises(DataError) as ctx:
            load("date,account,amount,currency,bogus\n")
        self.assertEqual(ctx.exception.line, 1)
        self.assertTrue(str(ctx.exception).startswith("line 1: "))

    def test_duplicate_column(self):
        with self.assertRaises(DataError) as ctx:
            load("date,account,amount,currency,account\n")
        self.assertEqual(ctx.exception.line, 1)

    def test_missing_required_column(self):
        with self.assertRaises(DataError) as ctx:
            load("date,account,amount\n")
        self.assertEqual(ctx.exception.line, 1)

    def test_required_columns_any_order(self):
        rows = load("currency,amount,account,date\nUSD,1.00,Assets:Cash,2024-01-02\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["account"], "Assets:Cash")
        self.assertEqual(rows[0]["amount"], decimal.Decimal("1.00"))
        self.assertEqual(rows[0]["date"], datetime.date(2024, 1, 2))

    def test_memo_is_optional(self):
        rows = load("date,account,amount,currency\n2024-01-02,Assets:Cash,1.00,USD\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["memo"], "")


class FieldValidationTests(unittest.TestCase):
    """Per-field validation, in the order date -> account -> amount -> currency."""

    def _rows(self, line):
        return load(HEADER + line + "\n")

    def test_valid_row_types(self):
        rows = self._rows("2024-01-02,Assets:Cash,10.50,USD,coffee")
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["date"], datetime.date(2024, 1, 2))
        self.assertEqual(row["account"], "Assets:Cash")
        self.assertEqual(row["amount"], decimal.Decimal("10.50"))
        self.assertEqual(row["currency"], "USD")
        self.assertEqual(row["memo"], "coffee")

    def test_negative_amount_and_single_decimal(self):
        rows = self._rows("2024-01-02,Assets:Cash,-3.5,USD,")
        self.assertEqual(rows[0]["amount"], decimal.Decimal("-3.5"))

    def test_bad_date_calendar(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-13-40,Assets:Cash,10.50,USD,")
        self.assertEqual(ctx.exception.line, 2)
        self.assertTrue(str(ctx.exception).startswith("line 2: "))

    def test_bad_date_format(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("01/02/2024,Assets:Cash,10.50,USD,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_amount(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets:Cash,10.555,USD,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_amount_not_a_number(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets:Cash,ten,USD,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_currency_lowercase(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets:Cash,10.50,usd,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_currency_length(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets:Cash,10.50,US,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_account_empty_segment(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets::Cash,10.50,USD,")
        self.assertEqual(ctx.exception.line, 2)

    def test_bad_account_whitespace(self):
        with self.assertRaises(DataError) as ctx:
            self._rows("2024-01-02,Assets: Cash,10.50,USD,")
        self.assertEqual(ctx.exception.line, 2)

    def test_empty_line_skipped(self):
        rows = load(
            HEADER
            + "\n"
            + "2024-01-02,Assets:Cash,1.00,USD,\n"
            + "   \n"
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["account"], "Assets:Cash")

    def test_whitespace_only_record_skipped(self):
        # A record of commas with no content must not be treated as data.
        rows = load(HEADER + ",,,,\n" + "2024-01-02,Assets:Cash,1.00,USD,\n")
        self.assertEqual(len(rows), 1)

    def test_field_count_mismatch(self):
        with self.assertRaises(DataError) as ctx:
            load(HEADER + "2024-01-02,Assets:Cash,1.00,USD\n")
        self.assertEqual(ctx.exception.line, 2)
        self.assertEqual(str(ctx.exception), "line 2: wrong number of fields")

    def test_error_reports_physical_line_number(self):
        with self.assertRaises(DataError) as ctx:
            load(HEADER + "2024-01-02,Assets:Cash,1.00,USD,\n" + "not-a-date,x,1,USD,\n")
        self.assertEqual(ctx.exception.line, 3)
        self.assertTrue(str(ctx.exception).startswith("line 3: "))


class ReportFilterTests(unittest.TestCase):
    """Filtering, aggregation and rendering in :mod:`ledger.report`."""

    def setUp(self):
        self.rows = [
            self._row("2024-01-01", "Assets", "1.00", "USD"),
            self._row("2024-01-02", "Assets:Bank", "2.00", "USD"),
            self._row("2024-01-03", "AssetsX", "3.00", "USD"),
            self._row("2024-01-04", "Expenses", "4.00", "USD"),
        ]

    @staticmethod
    def _row(day, account, amount, currency, memo=""):
        return {
            "date": datetime.date.fromisoformat(day),
            "account": account,
            "amount": decimal.Decimal(amount),
            "currency": currency,
            "memo": memo,
        }

    def test_account_prefix_matches_self_and_children_only(self):
        result = report.build_report(self.rows, account="Assets")
        self.assertEqual(result["total_transactions"], 2)
        names = {a["account"] for a in result["accounts"]}
        self.assertEqual(names, {"Assets", "Assets:Bank"})

    def test_account_prefix_exact_match(self):
        result = report.build_report(self.rows, account="AssetsX")
        self.assertEqual(result["total_transactions"], 1)
        self.assertEqual(result["accounts"][0]["account"], "AssetsX")

    def test_inclusive_date_bounds(self):
        result = report.build_report(
            self.rows,
            date_from=datetime.date(2024, 1, 2),
            date_to=datetime.date(2024, 1, 3),
        )
        self.assertEqual(result["total_transactions"], 2)

    def test_date_from_only(self):
        result = report.build_report(self.rows, date_from=datetime.date(2024, 1, 3))
        self.assertEqual(result["total_transactions"], 2)

    def test_date_to_only(self):
        result = report.build_report(self.rows, date_to=datetime.date(2024, 1, 2))
        self.assertEqual(result["total_transactions"], 2)

    def test_no_filters_returns_everything(self):
        result = report.build_report(self.rows)
        self.assertEqual(result["total_transactions"], 4)

    def test_empty_result(self):
        result = report.build_report(
            self.rows,
            date_from=datetime.date(2030, 1, 1),
        )
        self.assertEqual(result["total_transactions"], 0)
        self.assertEqual(result["accounts"], [])

    def test_zero_total_is_emitted(self):
        rows = [
            self._row("2024-01-01", "Assets:Cash", "5.00", "USD"),
            self._row("2024-01-02", "Assets:Cash", "-5.00", "USD"),
        ]
        result = report.build_report(rows)
        self.assertEqual(len(result["accounts"]), 1)
        self.assertEqual(result["accounts"][0]["balance"], "0.00")

    def test_negative_zero_is_normalized(self):
        rows = [self._row("2024-01-01", "Assets:Cash", "-0.001", "USD")]
        result = report.build_report(rows)
        self.assertEqual(result["accounts"][0]["balance"], "0.00")

    def test_decimal_accuracy(self):
        rows = [
            self._row("2024-01-01", "Assets:Cash", "0.10", "USD"),
            self._row("2024-01-02", "Assets:Cash", "0.20", "USD"),
        ]
        result = report.build_report(rows)
        self.assertEqual(result["accounts"][0]["balance"], "0.30")

    def test_balances_rendered_with_two_decimals(self):
        rows = [self._row("2024-01-01", "Assets:Cash", "3.5", "USD")]
        result = report.build_report(rows)
        self.assertEqual(result["accounts"][0]["balance"], "3.50")

    def test_currencies_kept_separate(self):
        rows = [
            self._row("2024-01-01", "Assets:Cash", "1.00", "USD"),
            self._row("2024-01-01", "Assets:Cash", "2.00", "EUR"),
        ]
        result = report.build_report(rows)
        balances = {(a["currency"]): a["balance"] for a in result["accounts"]}
        self.assertEqual(balances, {"USD": "1.00", "EUR": "2.00"})

    def test_accounts_sorted_by_account_then_currency(self):
        rows = [
            self._row("2024-01-01", "Expenses", "1.00", "USD"),
            self._row("2024-01-01", "Assets", "1.00", "USD"),
            self._row("2024-01-01", "Assets", "1.00", "EUR"),
        ]
        result = report.build_report(rows)
        keys = [(a["account"], a["currency"]) for a in result["accounts"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(keys[0], ("Assets", "EUR"))


class CliIntegrationTests(unittest.TestCase):
    """End-to-end tests spawning ``python -m ledger report ...``."""

    def setUp(self):
        # Fixtures live in a temp directory inside the working directory.
        self._dir = tempfile.TemporaryDirectory(dir=REPO_ROOT)
        self.addCleanup(self._dir.cleanup)

    def _write(self, name, text):
        path = os.path.join(self._dir.name, name)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        return path

    def test_success_exit_zero_and_json(self):
        path = self._write(
            "ok.csv",
            HEADER + "2024-01-02,Assets:Cash,10.50,USD,coffee\n",
        )
        result = run_cli(["report", path])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        data = json.loads(result.stdout)
        self.assertEqual(data["total_transactions"], 1)
        self.assertEqual(data["accounts"][0]["account"], "Assets:Cash")
        self.assertEqual(data["accounts"][0]["balance"], "10.50")

    def test_missing_file_exit_one_and_empty_stdout(self):
        missing = os.path.join(self._dir.name, "does-not-exist.csv")
        result = run_cli(["report", missing])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotEqual(result.stderr, "")

    def test_bad_from_date_exit_two(self):
        path = self._write(
            "ok.csv",
            HEADER + "2024-01-02,Assets:Cash,10.50,USD,\n",
        )
        result = run_cli(["report", path, "--from", "not-a-date"])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_from_after_to_exit_two(self):
        path = self._write(
            "ok.csv",
            HEADER + "2024-01-02,Assets:Cash,10.50,USD,\n",
        )
        result = run_cli(
            ["report", path, "--from", "2024-02-01", "--to", "2024-01-01"]
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_data_error_exit_two_and_empty_stdout(self):
        path = self._write(
            "bad.csv",
            HEADER + "2024-13-40,Assets:Cash,10.50,USD,\n",
        )
        result = run_cli(["report", path])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertIn("line 2", result.stderr)

    def test_header_error_exit_two(self):
        path = self._write(
            "hdr.csv",
            "date,account,amount\n2024-01-02,Assets:Cash,10.50\n",
        )
        result = run_cli(["report", path])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_bom_is_handled(self):
        path = self._write(
            "bom.csv",
            "\ufeff" + HEADER + "2024-01-02,Assets:Cash,10.50,USD,\n",
        )
        result = run_cli(["report", path])
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertEqual(data["total_transactions"], 1)

    def test_account_filter(self):
        path = self._write(
            "acct.csv",
            HEADER
            + "2024-01-02,Assets:Cash,10.50,USD,\n"
            + "2024-01-03,Expenses:Food,4.00,USD,\n",
        )
        result = run_cli(["report", path, "--account", "Assets"])
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertEqual(data["total_transactions"], 1)
        self.assertEqual(data["accounts"][0]["account"], "Assets:Cash")

    def test_date_filter(self):
        path = self._write(
            "dates.csv",
            HEADER
            + "2024-01-01,Assets:Cash,1.00,USD,\n"
            + "2024-01-15,Assets:Cash,2.00,USD,\n"
            + "2024-02-01,Assets:Cash,3.00,USD,\n",
        )
        result = run_cli(
            ["report", path, "--from", "2024-01-15", "--to", "2024-01-31"]
        )
        self.assertEqual(result.returncode, 0)
        data = json.loads(result.stdout)
        self.assertEqual(data["total_transactions"], 1)
        self.assertEqual(data["accounts"][0]["balance"], "2.00")


if __name__ == "__main__":
    unittest.main()
