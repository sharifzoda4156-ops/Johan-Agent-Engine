import unittest

from ttlcache import TTLCache


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class TTLCacheTest(unittest.TestCase):
    def test_set_get(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        self.assertEqual(cache.get("a"), 1)
        self.assertEqual(cache.get("b", "x"), "x")
        self.assertEqual((cache.hits, cache.misses), (1, 1))

    def test_expires(self):
        clock = FakeClock()
        cache = TTLCache(maxsize=2, ttl=10, clock=clock)
        cache.set("a", 1)
        clock.now += 11
        self.assertIsNone(cache.get("a"))

    def test_evicts_oldest(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        cache.set("b", 2)
        cache.set("c", 3)
        self.assertNotIn("a", cache)
        self.assertEqual(len(cache), 2)

    def test_delete(self):
        cache = TTLCache(maxsize=2, ttl=10, clock=FakeClock())
        cache.set("a", 1)
        self.assertTrue(cache.delete("a"))
        self.assertFalse(cache.delete("a"))


if __name__ == "__main__":
    unittest.main()
