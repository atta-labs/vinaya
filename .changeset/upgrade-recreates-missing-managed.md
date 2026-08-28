---
"@attalabs/vinaya": patch
---

Fixes `vinaya upgrade` silently no-oping on a missing `.vinaya/doc-owners`, leaving `vinaya doctor`'s
"run `vinaya upgrade`" remedy provably dead-ended (`#182`): three consecutive `upgrade --yes` runs left
the file absent and `doctor` still erroring, because the drift-protection exemption for `.vinaya/doc-owners`
(and `vinaya.config.json`) was unconditional and ran before the "file is missing" check, making that
check unreachable for these two paths. The exemption now only fires when the file exists — a missing
file falls through to the ordinary recreate-from-starter handling, restoring the remedy `doctor` already
advertises. Existing files with real adopter bindings are untouched, exactly as before: the destruction
case the exemption exists to prevent is unchanged and stays regression-tested.
