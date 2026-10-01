---
'@attalabs/vinaya': patch
---

On macOS the always-on worker sandbox now lets a dispatched role run `git`, keeps its Claude/Codex session between rounds, and lets it write its own task log — the three failures the always-on sandbox introduced for every Developer, code-reviewer and security dispatch on a Mac.

The rendered Seatbelt profile grants read AND exec (never write) on the active Apple developer directory `xcode-select -p` reports, resolved fresh at launch and added only when it exists — so `/usr/bin/git`'s Command Line Tools shim can load `libxcrun.dylib` and re-exec the real tool instead of crashing with "xcrun: error: unable to load libxcrun (… file system sandbox blocked open())". Each dispatch's subscription login and vendor session store now stage into a PERSISTENT per-task directory (`<runtimeDir>/tasks-execution/<task>/sessions/<role>-<agent>-config`) reused across rounds and removed only when the loop ends — never the per-dispatch scratch dir that was deleted after round 1, which left a round-2 resume reading an empty store ("No conversation found with session ID"). The role's own task log file (`<runtimeDir>/logs/<repo>/<task>.ndjson`, and its one rotation backup) is granted writable as an exact literal, never its folder, so a confined `log()` no longer dies with "log outbox target could not be opened".
