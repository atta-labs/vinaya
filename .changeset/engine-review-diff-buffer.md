---
'@attalabs/vinaya': patch
---

On an Engine run, both reviewers get the full diff of a change larger than one mebibyte, up to the 64 MiB bound the standalone loop uses for its own diff reads. A diff read that still fails stages a placeholder naming its reason and writes that reason to the driver log.
