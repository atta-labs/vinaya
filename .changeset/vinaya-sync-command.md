---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': patch
---

`vinaya sync` fills, resumes and rebuilds a repository's local log cache from its configured destination — a folder or a server, read-only — and prints pages read, rows stored, duplicates, edits, deletions, gaps, quarantined lines and, for a server, its lost-event diagnostic. `--rebuild` deletes the cache file and syncs again from the beginning of what the destination still retains. Opens the durable `node:sqlite` cache (`log-readers-v1` 7), so it needs the Node floor that command's own task set: `>=22.13`.
