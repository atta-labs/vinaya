---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Fix a transcript-pointer key collision: two project directories whose paths differed only in non-alphanumeric characters (e.g. `/a/b` and `/a-b`) collapsed to the same `$TMPDIR` pointer filename, so a pointer legitimately written by a session in one project could be read by an unrelated project as its own — reaching `resolveMeteringCapability`'s `pointer-unusable` reason, which refuses a commit. The pointer key now appends a full SHA-256 digest of the untouched project directory, which is collision-resistant rather than merely less likely to collide. Reads fall back to the pre-fix (legacy) pointer name when the new one is absent, so no pointer the shipped `track-transcript.sh` Stop hook already wrote on disk is orphaned by this change.
