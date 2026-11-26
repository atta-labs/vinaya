---
"@attalabs/vinaya": minor
"@attalabs/vinaya-log-sdk": minor
---

A run's local copy is now cleaned after a keep window. The Log settings accept `logs.keepDays`, a whole number of days of at least 1 (90 when absent); any other value is refused when the settings load, naming the key. When a Log handle opens with recording on, it deletes from its repository's local-copy folder every traces and logs file last written longer ago than the window, with that file's delivery state; newer files stay. `connect()` takes an optional `keepDays`, and `DEFAULT_KEEP_DAYS` and `ResolvedSettings.keepDays` are on the public entry. An unattended run keeps the default window.
