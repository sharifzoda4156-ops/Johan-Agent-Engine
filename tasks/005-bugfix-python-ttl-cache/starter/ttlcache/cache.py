"""LRU-кэш с ограничением размера и временем жизни записей."""
import time
from collections import OrderedDict

_MISSING = object()


class TTLCache:
    def __init__(self, maxsize, ttl, clock=time.monotonic):
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        if ttl <= 0:
            raise ValueError("ttl must be > 0")
        self.maxsize = maxsize
        self.ttl = ttl
        self._clock = clock
        self._data = OrderedDict()  # key -> (value, expires_at)
        self.hits = 0
        self.misses = 0

    def _expired(self, expires_at):
        return self._clock() > expires_at

    def get(self, key, default=None):
        item = self._data.get(key, _MISSING)
        if item is _MISSING:
            self.misses += 1
            return default
        value, expires_at = item
        if self._expired(expires_at):
            del self._data[key]
            self.misses += 1
            return default
        self.hits += 1
        return value

    def set(self, key, value, ttl=None):
        ttl = self.ttl if ttl is None else ttl
        if len(self._data) >= self.maxsize:
            self.purge()
        if len(self._data) >= self.maxsize:
            self._data.popitem(last=False)
        self._data[key] = (value, self._clock() + ttl)

    def delete(self, key):
        return self._data.pop(key, _MISSING) is not _MISSING

    def purge(self):
        """Удалить просроченные записи, вернуть их количество."""
        now = self._clock()
        expired = [k for k, (_, exp) in self._data.items() if exp < now]
        for k in expired:
            del self._data[k]
        return len(expired)

    def __contains__(self, key):
        return key in self._data

    def __len__(self):
        return len(self._data)
