---
'@attalabs/vinaya': minor
'@attalabs/vinaya-sources': patch
'@attalabs/aeg-core': patch
---

Every agent session now loads the doctrine pointer from the file its vendor reads at start. `vinaya init` and `vinaya upgrade` write the pointer to a root `AGENTS.md` (Codex reads it), a root `CLAUDE.md` whose body is the import line `@AGENTS.md` plus one sentence naming `/vinaya <role>` (Claude Code reads it), and, for the `gemini` agent vendor, `.gemini/settings.json` naming `AGENTS.md` as Gemini CLI's context file. Each is written only where no file of that name exists; an adopter's own file is refused and left untouched. The pointer's role list is generated from the bundled doctrine's roles, with human-only and retired roles left out the way the role skills leave them out, so it now names the Operator and no longer names the Principal. `VINAYA.md` is no longer generated: `upgrade` removes a copy the manifest records, `eject` removes it like any recorded file, and `doctor` reports a recorded `VINAYA.md`, and a missing or drifted `AGENTS.md`, `CLAUDE.md` or `.gemini/settings.json`, like every other managed artifact. The `pr-report-density` check no longer counts the driver-written `AEG:BEYOND-SURFACE` block in `## Scope` as a second paragraph: it strips every anchored field the body grammar declares.
