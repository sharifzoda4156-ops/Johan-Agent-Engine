"""CSV parsing and row validation for the ``ledger`` reporting tool.

:func:`load_rows` consumes a text stream (already opened with
``encoding="utf-8-sig"`` by :mod:`ledger.cli`, so a leading BOM is gone) and
returns the validated transactions. The csv module is used for reading so that
the standard quoting rules are honoured.

Every problem is reported by raising :class:`ledger.errors.DataError` carrying
the 1-based physical line number and a short reason, so the CLI can print
``line N: <reason>`` and exit with status 2.
"""

from __future__ import annotations

import csv
import datetime
import decimal
import re

from .errors import DataError

__all__ = ["load_rows"]

#: Header cells understood by the tool; ``memo`` is the only optional one.
_ALLOWED_COLUMNS = ("date", "account", "amount", "currency", "memo")

#: Header cells that must be present, in no particular order.
_REQUIRED_COLUMNS = ("date", "account", "amount", "currency")

#: Strict ``YYYY-MM-DD`` shape; calendar validity is checked afterwards.
_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: Amounts: optional minus, digits, optional 1-2 decimal places (no ``+``,
#: no exponent, no spaces).
_AMOUNT_PATTERN = re.compile(r"-?\d+(\.\d{1,2})?")

#: Currency: exactly three uppercase Latin letters.
_CURRENCY_PATTERN = re.compile(r"[A-Z]{3}")


def _parse_header(header: list[str]) -> dict[str, int]:
    """Validate the header record and return a ``column name -> index`` map.

    Raises :class:`DataError` for line 1 if a column is unknown, duplicated or
    if a required column is missing.
    """
    columns: dict[str, int] = {}
    for index, name in enumerate(header):
        if name not in _ALLOWED_COLUMNS:
            raise DataError(1, f"unknown column: {name!r}")
        if name in columns:
            raise DataError(1, f"duplicate column: {name!r}")
        columns[name] = index

    for name in _REQUIRED_COLUMNS:
        if name not in columns:
            raise DataError(1, f"missing required column: {name}")

    return columns


def _parse_date(value: str, line: int) -> datetime.date:
    """Validate a ``YYYY-MM-DD`` cell and return the real calendar date."""
    if not _DATE_PATTERN.match(value):
        raise DataError(line, f"invalid date: {value!r}")
    try:
        return datetime.date(int(value[0:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        raise DataError(line, f"invalid date: {value!r}") from None


def _parse_account(value: str, line: int) -> str:
    """Validate a colon-separated account path and return it unchanged.

    Every ``:``-separated segment must be non-empty and free of surrounding
    whitespace.
    """
    segments = value.split(":")
    if any(segment == "" or segment != segment.strip() for segment in segments):
        raise DataError(line, f"invalid account: {value!r}")
    return value


def _parse_amount(value: str, line: int) -> decimal.Decimal:
    """Validate a decimal amount cell and return it as a :class:`~decimal.Decimal`."""
    if not _AMOUNT_PATTERN.fullmatch(value):
        raise DataError(line, f"invalid amount: {value!r}")
    return decimal.Decimal(value)


def _parse_currency(value: str, line: int) -> str:
    """Validate a three-uppercase-letter currency code and return it."""
    if not _CURRENCY_PATTERN.fullmatch(value):
        raise DataError(line, f"invalid currency: {value!r}")
    return value


def load_rows(stream):
    """Read and validate the CSV ``stream``, returning the transaction rows.

    The first record is the header (physical line 1); it must contain the
    required ``date``/``account``/``amount``/``currency`` columns plus an
    optional ``memo``, in any order, with no unknown or duplicated names.
    """
    reader = csv.reader(stream)

    try:
        header = next(reader)
    except StopIteration:
        raise DataError(1, "missing header row") from None
    if not header:
        raise DataError(1, "missing header row")

    columns = _parse_header(header)

    rows: list[dict[str, object]] = []
    for record in reader:
        # ``reader.line_num`` is the physical line number of the record that
        # was just read (it may have advanced past the record's start when the
        # record contains embedded newlines), so it is the right value to
        # report for a problem found in this row.
        line = reader.line_num

        # csv.reader yields an empty list for a blank physical line, while a
        # line of only delimiters (",,,") yields empty fields; treat both as
        # fully empty and skip them.
        if not record or all(field == "" for field in record):
            continue

        if len(record) != len(header):
            raise DataError(line, "wrong number of fields")

        # Validate every field before appending so a malformed row never
        # leaves a partially-built transaction behind.
        row = {name: record[index] for name, index in columns.items()}
        rows.append(
            {
                "date": _parse_date(row["date"], line),
                "account": _parse_account(row["account"], line),
                "amount": _parse_amount(row["amount"], line),
                "currency": _parse_currency(row["currency"], line),
                "memo": row.get("memo", ""),
            }
        )

    return rows
