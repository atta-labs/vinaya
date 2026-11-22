---
"@attalabs/vinaya": patch
---

A Developer sent back on a failed round test is told the directory the round ran each failing file's runner group from and the command that runs the file from there, and that one passing run does not clear a round test: the file is run twenty times in one invocation with `--rerun-each=20`.
