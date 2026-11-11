---
'@attalabs/vinaya': patch
---

The Milestone operations — create, edit, adopt, close and status — are a library that returns an outcome instead of ending the process, and the `vinaya milestone` commands parse their arguments, call it and print. The library adds a delete that removes a Milestone only when it exists and no Issue or pull request, open or closed, is attached to it, and refuses otherwise, naming each attached item. Command output, exit codes and refusals are unchanged.
