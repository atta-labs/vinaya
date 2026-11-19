---
'@attalabs/vinaya': patch
---

The `changeset-coverage` check now refuses added or edited changesets that name packages covered by the Changesets `ignore` list, even when the diff touches no published files. Remove the ignored package entries from the frontmatter. If no release is intended, use an empty changeset or delete the file when a changeset is unnecessary.
