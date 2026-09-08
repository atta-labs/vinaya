---
"@attalabs/vinaya": patch
---

A dispatched agent's work is visible while it runs. `vinaya dispatch` now asks each vendor for the streaming form of the structured channel it already used — `claude` gains `--output-format stream-json` (with the `--verbose` the CLI requires alongside `-p`), and `codex` already streamed — and renders each event as it arrives: the text the agent produced, and one line per tool call naming the file, command or pattern it acted on. Tool results are not rendered; they are bulk, and the full raw stream is still teed verbatim to the run's log file.

The cause was never vendor-specific: the child is spawned onto pipes, so no vendor sees a terminal and each falls back to a buffered mode that prints nothing until it exits. A pseudo-terminal would have restored the view at the cost of the structured channel `parseUsage` reads, and of a native dependency this bundled CLI cannot carry; requesting the streaming form of that same channel costs neither. `parseClaudeUsage` and `parseClaudeResumeId` now read a stream's terminal event as well as a single whole-blob payload, so both forms keep working.
