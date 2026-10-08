---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

An agent's usage limit is no longer recorded as a crash. A Codex or Claude Code run that stops because its subscription usage limit was reached pauses the task with the agent's reset time and the command that continues it, spends no infrastructure retry, and a watching driver resumes it by itself after the reset when that is within six hours. The Log records it as its own dispatch outcome, and `vinaya task status` shows it as a usage limit with its reset time. The log server must be deployed before this CLI release, since it classifies stored lines with the new outcome.
