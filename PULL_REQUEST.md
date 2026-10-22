# Fix five TTL cache bugs

Branch: `fix/ttlcache-five-reports`
Base: `main`
Merge/deploy: **not performed** (out of scope for this task).

## Summary

`TTLCache` had five defects around TTL boundaries, LRU bookkeeping and
argument validation. Each fix is minimal and is covered by a regression
test in `tests/test_cache.py`.

## Reasons per report

1. **TTL boundary was exclusive.** `_expired` used `clock() > expires_at`,
   so an entry stayed alive at exactly `expires_at`. Changed to
   `clock() >= expires_at` so an entry with `ttl=10` is gone at `now == 10`.
   Covered by `test_expires_at_exact_boundary`.
2. **`get()` did not refresh LRU order.** A hit returned the value without
   moving the key to the end of the `OrderedDict`, so a frequently read key
   could still be evicted as "oldest". Added `self._data.move_to_end(key)`
   on a successful, non-expired hit. Covered by `test_get_refreshes_lru_order`.
3. **`set()` on an existing key evicted another entry.** The write path fell
   through to the eviction branch, so re-setting a key could drop an
   unrelated entry. Added an early branch that updates value/`expires_at`,
   calls `move_to_end` and returns before eviction. Covered by
   `test_set_existing_key_updates_without_evicting`.
4. **Expired entries were counted as present.** `__contains__` and `__len__`
   reported expired entries as live, so callers saw phantom keys and an
   inflated size. Both now consult `_expired` and ignore expired entries
   without touching `hits`/`misses`. Covered by
   `test_expired_entries_not_counted_and_do_not_touch_counters`.
5. **`set()` accepted a non-positive TTL.** `ttl=0` or a negative TTL
   silently produced an already-expired entry. `set()` now raises
   `ValueError("ttl must be > 0")` before mutating `_data` or the counters,
   matching the validation already done in `__init__`. Covered by
   `test_set_rejects_non_positive_ttl`.

## Test evidence

`python -m unittest` is green on this branch; the run is captured by
`run_tests.py` into `test_report.txt`.

## Scope

Only the five defects above were fixed; no refactoring beyond what the
reports require. No merge and no deploy.
