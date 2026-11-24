---
"@attalabs/vinaya": minor
"@attalabs/vinaya-log-sdk": minor
---

The command line depends on the Log SDK as a real package: the published `@attalabs/vinaya` lists `@attalabs/vinaya-log-sdk` at its own version, imports it by name and bundles none of its source. Every record a Log handle writes now names the package's own version, read from its `package.json`, as `vinaya.sdk.version` and as its instrumentation scope's version, where it named `0.0.0` before. The settings reader (`resolveSettings`, `repoSegment`, `defaultRuntimeDir`) and the emit argument reader (`readFields`, `EMIT_USAGE`) are now on the public entry.
