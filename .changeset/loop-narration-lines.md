---
'@attalabs/vinaya': patch
---

The dev-review loop now narrates itself in the loop log with one shared line shape — time, mark, role label, then plain words — for the run start, each round and every agent step. `vinaya task status` reads a driver exit only from a line of that shape, so agent prose that mentions a driver exit is never mistaken for one.
