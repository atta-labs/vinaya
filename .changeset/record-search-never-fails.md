---
'@attalabs/test-selection': patch
---

`--fetch-record` no longer fails the command when no download folder can be made, and a download that runs out of time stops the search's use of `gh` instead of trying every run of every candidate commit. The workflow `test-selection-setup` writes runs `sudo apt-get update` before installing `strace`. The README's opening names the two parts of the package that reach GitHub.
