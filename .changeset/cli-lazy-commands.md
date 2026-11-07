---
'@attalabs/vinaya': patch
---

The command-line program loads a command's code only when that command runs, so a change to one command no longer selects every test that runs some other command. Every test keeps its read record: the test runtime guard takes the repository from `GITHUB_REPOSITORY` on Actions instead of asking git, whose read under `.git/` made the recorder drop nearly every test's record.
