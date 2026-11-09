---
'@attalabs/vinaya': patch
---

A hand-posted review verdict binds to the manifest snapshot its reviewer judged. `vinaya-review-post --export-manifest --pr <n>` prints the review input before the review; both reviewer roles post with `--manifest-file`, the post echoes that snapshot, and it is refused before any forge write when the head, base, brief, objectives, ruling, pause-bound ruling, version or policy no longer match, or when the snapshot is missing a field or carries an unsupported one. Print-only output and the post-write check apply the same comparison.
