"""cronlite: cron-выражения из пяти полей и поиск следующего запуска.

Поля: минута, час, день месяца, месяц, день недели. Время наивное, точность до минуты.
"""
from datetime import datetime, timedelta

_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
_DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
_NAMES = {
    "month": {n: i for i, n in enumerate(_MONTHS, 1)},
    "dow": {n: i for i, n in enumerate(_DAYS)},
}
_SPEC = (("minute", 0, 59), ("hour", 0, 23), ("dom", 1, 31), ("month", 1, 12), ("dow", 0, 6))
_HORIZON = timedelta(days=366 * 10)


def _num(tok, name):
    tok = tok.upper()
    if tok in _NAMES.get(name, ()):
        return _NAMES[name][tok]
    if not tok.isdigit():
        raise ValueError(f"{name}: bad value {tok!r}")
    return int(tok)


def _field(src, name, lo, hi):
    acc = set()
    for chunk in src.split(","):
        step = None
        if "/" in chunk:
            chunk, raw = chunk.split("/", 1)
            if not raw.isdigit() or int(raw) < 1:
                raise ValueError(f"{name}: bad step {raw!r}")
            step = int(raw)
        if chunk == "*":
            a, b = lo, hi
            vals = range(lo, hi + 1)[step - 1 :: step] if step else range(lo, hi + 1)
        elif "-" in chunk:
            x, y = chunk.split("-", 1)
            a, b = _num(x, name), _num(y, name)
            vals = range(a, b + 1)
        else:
            if step:
                raise ValueError(f"{name}: step needs a range")
            a = b = _num(chunk, name)
            vals = (a,)
        if a < lo or b > hi or a > b:
            raise ValueError(f"{name}: {chunk!r} out of range {lo}-{hi}")
        acc.update(vals)
    return frozenset(acc)


class Cron:
    def __init__(self, expr):
        parts = expr.split()
        if len(parts) != 5:
            raise ValueError("expected 5 fields")
        self.expr = expr
        self.minute, self.hour, self.dom, self.month, self.dow = (
            _field(p, *spec) for p, spec in zip(parts, _SPEC)
        )

    def _day_ok(self, t):
        return t.day in self.dom and (t.weekday() + 1) % 7 in self.dow

    def matches(self, t):
        return (
            t.month in self.month
            and self._day_ok(t)
            and t.hour in self.hour
            and t.minute in self.minute
        )

    def next_after(self, t):
        """Ближайший момент запуска строго после t или None, если его нет в ближайшие 10 лет."""
        limit = t + _HORIZON
        t = t.replace(second=0, microsecond=0)
        while t <= limit:
            if t.month not in self.month:
                if t.month == 12:
                    t = t.replace(year=t.year + 1, month=1, hour=0, minute=0)
                else:
                    t = t.replace(month=t.month + 1, hour=0, minute=0)
                continue
            if not self._day_ok(t):
                t = (t + timedelta(days=1)).replace(hour=0, minute=0)
                continue
            if t.hour not in self.hour:
                t = (t + timedelta(hours=1)).replace(minute=0)
                continue
            if t.minute not in self.minute:
                t += timedelta(minutes=1)
                continue
            return t
        return None
