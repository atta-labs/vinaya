---
'@attalabs/vinaya': patch
---

The command-line program installs the Log sink factory, the configuration provider and the check registry when a command first needs them, and loads the Log client for the exit record only when the process has a Log destination, so a Log or configuration edit no longer selects every test that starts the program.
