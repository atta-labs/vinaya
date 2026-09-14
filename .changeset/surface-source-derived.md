---
"@attalabs/vinaya": patch
---

The command-layering and export-inventory rules are enforced directly from the source tree instead of a hand-maintained spec table: a command's own file declares its `SURFACE_EXEMPTIONS` (a new `SurfaceExemption` type) when it doesn't yet call exactly one lib chokepoint, and the spec document no longer lists a row per command or per export.
