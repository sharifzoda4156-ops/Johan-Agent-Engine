"""Filtering, balance computation and JSON-ready reporting for ``ledger``.

:func:`build_report` consumes the validated transactions produced by
:func:`ledger.parser.load_rows` and applies the CLI filters:

* ``date_from`` / ``date_to`` -- inclusive bounds on ``row["date"]`` (either
  bound may be ``None``, meaning "unbounded on that side");
* ``account`` -- an account prefix that matches the account itself as well as
  its sub-accounts (``Assets`` matches ``Assets`` and ``Assets:Bank`` but not
  ``AssetsX``).

The filtered rows are the basis for the balance report emitted by
:mod:`ledger.cli`.
"""

from __future__ import annotations

import datetime
import decimal
from decimal import ROUND_HALF_EVEN

__all__ = ["build_report"]

#: Quantum used when rendering balances (exactly two decimal places).
_CENT = decimal.Decimal("0.01")


def _matches_date(
    day: datetime.date,
    date_from: datetime.date | None,
    date_to: datetime.date | None,
) -> bool:
    """Return whether ``day`` lies within the inclusive ``[from, to]`` range."""
    if date_from is not None and day < date_from:
        return False
    if date_to is not None and day > date_to:
        return False
    return True


def _matches_account(account: str, prefix: str | None) -> bool:
    """Return whether ``account`` equals ``prefix`` or is one of its children."""
    if prefix is None:
        return True
    return account == prefix or account.startswith(prefix + ":")


def _filter_rows(
    rows,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    account: str | None = None,
):
    """Return the rows passing the inclusive date range and account prefix."""
    return [
        row
        for row in rows
        if _matches_date(row["date"], date_from, date_to)
        and _matches_account(row["account"], account)
    ]


def _totals(rows) -> dict[tuple[str, str], decimal.Decimal]:
    """Sum ``row["amount"]`` per ``(account, currency)`` using :class:`Decimal`.

    Every encountered pair is present in the result -- a pair whose amounts
    cancel out keeps its zero total instead of being dropped.
    """
    totals: dict[tuple[str, str], decimal.Decimal] = {}
    for row in rows:
        key = (row["account"], row["currency"])
        totals[key] = totals.get(key, decimal.Decimal(0)) + row["amount"]
    return totals


def _format_balance(value: decimal.Decimal) -> str:
    """Render ``value`` as a string with exactly two decimal places.

    The sum is quantized with :data:`~decimal.ROUND_HALF_EVEN` and a negative
    zero is normalized so the result is always ``"0.00"`` and never
    ``"-0.00"``.
    """
    quantized = value.quantize(_CENT, rounding=ROUND_HALF_EVEN)
    if quantized == 0:
        quantized = decimal.Decimal(0)
    return f"{quantized:.2f}"


def build_report(
    rows,
    date_from: datetime.date | None = None,
    date_to: datetime.date | None = None,
    account: str | None = None,
):
    """Build the balance report for the transactions that pass the filters.

    ``rows`` is the list of validated transactions returned by
    :func:`ledger.parser.load_rows`; ``date_from``/``date_to`` are inclusive
    calendar bounds and ``account`` is an account prefix (``None`` disables the
    corresponding filter).

    The filtered rows are aggregated into one balance per ``(account,
    currency)`` pair (exact :class:`~decimal.Decimal` arithmetic); every
    encountered pair is emitted, even when its total is zero. Balances are
    rendered as strings with exactly two decimals (``"0.00"`` for zero, never
    ``"-0.00"``). The ``accounts`` list is sorted by account and then currency
    using plain string comparison, and ``total_transactions`` is the number of
    rows that passed the filters.
    """
    filtered = _filter_rows(
        rows, date_from=date_from, date_to=date_to, account=account
    )
    totals = _totals(filtered)
    accounts = [
        {
            "account": name,
            "currency": currency,
            "balance": _format_balance(total),
        }
        for (name, currency), total in sorted(totals.items())
    ]
    return {"accounts": accounts, "total_transactions": len(filtered)}
