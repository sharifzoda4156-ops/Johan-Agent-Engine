import time
from collections import OrderedDict


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
        return self._clock() >= expires_at

    def get(self, key, default=None):
        entry = self._data.get(key)
        if entry is None:
            self.misses += 1
            return default
        value, expires_at = entry
        if self._expired(expires_at):
            self.misses += 1
            return default
        self._data.move_to_end(key)
        self.hits += 1
        return value

    def set(self, key, value, ttl=None):
        if ttl is None:
            ttl = self.ttl
        if ttl <= 0:
            raise ValueError("ttl must be > 0")
        if key in self._data:
            self._data[key] = (value, self._clock() + ttl)
            self._data.move_to_end(key)
            return
        if len(self._data) >= self.maxsize:
            self._data.popitem(last=False)
        self._data[key] = (value, self._clock() + ttl)

    def delete(self, key):
        return self._data.pop(key, None) is not None

    def purge(self):
        now = self._clock()
        expired = [k for k, (_, exp) in self._data.items() if exp <= now]
        for k in expired:
            del self._data[k]
        return len(expired)

    def __contains__(self, key):
        entry = self._data.get(key)
        if entry is None:
            return False
        _, expires_at = entry
        return not self._expired(expires_at)

    def __len__(self):
        return sum(1 for _, exp in self._data.values() if not self._expired(exp))
