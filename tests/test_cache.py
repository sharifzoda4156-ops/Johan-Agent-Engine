import unittest

from ttlcache import TTLCache


class FakeClock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TTLCacheTest(unittest.TestCase):
    def test_set_get(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        self.assertEqual(cache.get("a"), 1)
        self.assertEqual(cache.get("b", "x"), "x")

    def test_expires(self):
        clock = FakeClock()
        cache = TTLCache(maxsize=2, ttl=10, clock=clock)
        cache.set("a", 1)
        clock.advance(11)
        self.assertIsNone(cache.get("a"))

    def test_evicts_oldest(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)
        self.assertIsNone(cache.get("a"))
        self.assertEqual(cache.get("b"), 2)
        self.assertEqual(cache.get("c"), 3)

    def test_expires_at_exact_boundary(self):
        clock = FakeClock()
        cache = TTLCache(maxsize=2, ttl=10, clock=clock)
        cache.set("a", 1, ttl=10)
        clock.now += 10
        self.assertIsNone(cache.get("a"))

    def test_get_refreshes_lru_order(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        cache.set("b", 2)
        cache.get("a")
        cache.set("c", 3)
        self.assertIn("a", cache)
        self.assertNotIn("b", cache)

    def test_set_existing_key_updates_without_evicting(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("a", 99)
        self.assertIn("b", cache)
        self.assertEqual(len(cache), 2)
        self.assertEqual(cache.get("a"), 99)

    def test_expired_entries_not_counted_and_do_not_touch_counters(self):
        clock = FakeClock()
        cache = TTLCache(maxsize=5, ttl=10, clock=clock)
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)
        hits, misses = cache.hits, cache.misses
        clock.advance(11)
        self.assertEqual(len(cache), 0)
        self.assertNotIn("a", cache)
        self.assertEqual(cache.hits, hits)
        self.assertEqual(cache.misses, misses)

    def test_set_rejects_non_positive_ttl(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        hits, misses = cache.hits, cache.misses
        with self.assertRaises(ValueError):
            cache.set("a", 1, ttl=0)
        with self.assertRaises(ValueError):
            cache.set("a", 1, ttl=-1)
        self.assertNotIn("a", cache)
        self.assertEqual(len(cache), 0)
        self.assertEqual(cache.hits, hits)
        self.assertEqual(cache.misses, misses)

    def test_delete(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        self.assertTrue(cache.delete("a"))
        self.assertIsNone(cache.get("a"))
        self.assertFalse(cache.delete("a"))


if __name__ == "__main__":
    unittest.main()
