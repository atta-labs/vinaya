---
"@attalabs/vinaya": patch
---

The control store syncs the directory holding each record it publishes, by overwrite or by exclusive claim, and the parent of each directory it creates inside its own root, so a record's name and a new directory reach disk and not only the record's bytes. A failing directory sync surfaces as an error from the write and leaves the published record in place.
