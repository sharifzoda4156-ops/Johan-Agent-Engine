import unittest
from datetime import datetime

from cronlite import Cron


class CronTest(unittest.TestCase):
    def test_daily(self):
        c = Cron("30 9 * * *")
        self.assertEqual(c.next_after(datetime(2026, 3, 4, 8, 0)), datetime(2026, 3, 4, 9, 30))
        self.assertEqual(c.next_after(datetime(2026, 3, 4, 10, 0)), datetime(2026, 3, 5, 9, 30))

    def test_list_and_names(self):
        c = Cron("0,30 12 * jan,Feb mon")
        self.assertTrue(c.matches(datetime(2026, 1, 5, 12, 30)))
        self.assertFalse(c.matches(datetime(2026, 1, 6, 12, 30)))
        self.assertFalse(c.matches(datetime(2026, 3, 2, 12, 0)))

    def test_range(self):
        c = Cron("0 9-11 * * *")
        self.assertEqual(sorted(c.hour), [9, 10, 11])

    def test_bad_expressions(self):
        for expr in ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "a * * * *", "*/0 * * * *", "5-1 * * * *"]:
            with self.subTest(expr=expr):
                with self.assertRaises(ValueError):
                    Cron(expr)


if __name__ == "__main__":
    unittest.main()
