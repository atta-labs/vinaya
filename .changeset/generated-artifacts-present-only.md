---
"@attalabs/vinaya": patch
---

The Issue write gate asks a task's Surface to reach only the generated files the repository actually has. A repository whose hooks live under `.vinaya/hooks` is no longer asked to add `.husky`, which the same gate then refused because no file there is tracked.
