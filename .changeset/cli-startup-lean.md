---
'@attalabs/vinaya': patch
---

The command-line program loads less at startup: its two installers come from a small module instead of the dispatch module, and the Log sink, its loop-log writer and its webhook drain load the first time something logs. A command that logs nothing no longer loads them, so an edit to them selects only the tests whose commands log.
