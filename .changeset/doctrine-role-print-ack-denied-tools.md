---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

`vinaya doctrine --role <name>` gains `--print`: it emits the resolved role file's body (frontmatter stripped) instead of its path, so a generated skill or slash command no longer has to shell out, read a path back, then read that path again — the printed output IS the operating instructions. Every generated agent skill and both generated slash commands now invoke it. The path-only output stays byte-identical without the flag.

Every agent role file's frontmatter now carries a fixed `ack-token`; print mode emits it as the output's own first line, and each agent role's own text requires the agent's first session message to echo it back verbatim — a transcript now proves the doctrine was read with one search.

Every agent role but the Operator now declares `denied-tools` in its frontmatter — the verbs its own prose already forbade, in the same vocabulary `performs` uses for what it does. The generated agent-skill file carries the list forward as a plain body line: `disallowed-tools` is a Claude-Code-only frontmatter extension outside the portable Agent Skills spec this file's own target hosts implement, and Claude Code itself never reads this file, so no host it reaches has a confirmed mechanism to enforce the denial from frontmatter.

The Developer and Planner role docs are each now a seat file of at most 120 lines — the short version and the entry gate — with the full procedure moved to a sibling `reference.md` under a directory named for the role, linked once from the seat.
