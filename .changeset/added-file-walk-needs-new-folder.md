---
'@attalabs/test-selection': patch
---

A file added to or deleted from a folder the recorded run did not list now reaches a test through a listed folder above it only when a folder on its path between the two is new: absent at the base for an added path, absent at the head for a deleted one. A new file inside folders that exist on both sides, such as every pull request's `.changeset/` entry, no longer selects every test whose code listed the root. Each added or deleted `PathChange` the selection builds carries that folder as `newFolder`, read once from the base and head file lists; a change without it walks as before. The dispatch child-process test's survivor check also reads an empty process state as gone, so a launch that exits between the zero signal and the state read is no longer counted as running.
