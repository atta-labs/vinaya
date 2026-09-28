---
'@attalabs/vinaya': patch
---

The generated `pre-push` hook now clears every `GIT_*` variable whose name contains a digit before its selected-test step, alongside the letters-only names it already cleared. Git exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_PREFIX` when it runs a hook, and the hook has cleared those for its test step since the step existed; what survived was `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, which inject arbitrary configuration into every git call a test makes, and `GIT_TRACE2*`, which interleaves trace output into the git output a test parses. Regenerate the hook (`vinaya upgrade`) to pick it up.

A test that creates and operates on its own throwaway git repository no longer depends on the hook for that isolation either: `demo.test.ts` and `quickstart.test.ts` strip every `GIT_*` key — and the `PR_BODY`/`PR_NUMBER`/`BRANCH` grading context, which made the fixture's own generated hooks grade the caller's pull-request body and refuse the fixture's own push — from their own environment for the duration of the file, and restore it afterwards, so those fixtures stay on their own repository under any runner and any caller. Under a leaked `GIT_DIR`, all seven of the demo tests failed and the run left `core.bare=true` plus a committed fixture behind on the real repository.
