---
'@attalabs/vinaya': minor
---

Every `vinaya` invocation now records one `operation` event named `cli_command` in the Vinaya Log when it ends, with the command name as its target, its result, its duration and its exit code, and never an argument. `vinaya log send` records none, and a process ended by a signal remains the one invocation not recorded.
