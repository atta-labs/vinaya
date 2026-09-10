---
"@attalabs/vinaya": patch
---

`vinaya task dispatch <tranche> <n> --agent <vendor>` now always starts the developer when the brief posts successfully — the runtime `import('./dispatch.js')` lookup it used to resolve `dispatchRole` never resolved inside the published, single-file bundle, so the published CLI silently fell back to printing a manual-recovery instruction naming a `--tranche` flag `vinaya dispatch` does not accept. `dispatchRole` is now a static import; a build that cannot reach it fails to compile instead. `vinaya dispatch` also refuses an unrecognized flag by name instead of silently ignoring it — the same `--tranche` probe used to start a real developer while looking like it might have failed.

Also documents (task 7, `#495`) that `vinaya dispatch`'s and the dev-review-loop's terminal output is colour-coded per role, and that `NO_COLOR` disables it.
