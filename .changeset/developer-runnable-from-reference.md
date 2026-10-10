---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

Every command in the command reference now declares what it needs beyond the sandbox — a forge credential, a default-branch checkout, an operator seat, or nothing — and the Issue gate's Developer-runnable rule derives its forbidden set from those declarations instead of a typed list. `vinaya issue create` and `vinaya issue edit` therefore refuse a Test plan line that runs `brief render`, `task status`, `issue create` (even with `--validate-only`) or any other command that needs the forge or the default branch, naming the need; only the foreign binaries (`gh`, `git push`, `ssh`) stay typed.
