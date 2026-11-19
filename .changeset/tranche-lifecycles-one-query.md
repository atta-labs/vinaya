---
'@attalabs/vinaya': patch
---

Checks that need to know which tranches are active now read every tranche label's Issue counts in one GitHub query and list Issues only for active tranches, instead of listing every tranche's Issues on every run. In a repository with many tranches this stops loops and CI from running out of GitHub's GraphQL rate limit.
