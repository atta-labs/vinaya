---
'@attalabs/vinaya': patch
---

A dispatch can now run read-only: Claude Code holds only `Read`, `Grep`, `Glob` and `Bash`, loads no MCP server, and its sandbox writes only the dispatch's scratch directory; Codex runs in its `read-only` sandbox mode on the first turn and, through its staged `config.toml`, on every resumed turn. A layer-G review trial runs this way, with a read-only shell that the renderer maps to the new neutral capability `read_commands`, and the derived review cases grant it. Every other dispatch is unchanged.
