---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
---

The Vinaya Log header is now `schema: 3`: it names the unit of work (`work`), the way of working (`flow`), the runtime and the source, set through `VINAYA_WORK_REF`, `VINAYA_FLOW`, `VINAYA_FLOW_VERSION`, `VINAYA_RUNTIME` and `VINAYA_SOURCE`. Lines of schema 1 and 2 still read back unchanged.
