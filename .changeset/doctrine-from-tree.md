---
"@attalabs/vinaya": patch
---

`vinaya doctrine`/`resolveDoctrineRoot()` now try the current repository's own `aeg-root/` first, whenever its git toplevel carries `aeg-root/roles/`, before falling back to the bundle next to the running CLI — a globally-installed `vinaya` invoked inside a repo that vendors the doctrine tree itself now reads that checkout's own tree instead of the binary's bundled copy, which could be releases behind. `vinaya doctor` reports which root it resolved and why (`tree` or `bundle`).

In a self-hosting repository, the generated `.agents/skills/vinaya-*/SKILL.md`, `.claude/commands/vinaya.md`, and `.gemini/commands/vinaya.toml` files now invoke the source CLI (`bun <dir>/src/index.ts doctrine --role <r>`) rather than the global `vinaya` binary; `vinaya upgrade` rewrites the existing files.
