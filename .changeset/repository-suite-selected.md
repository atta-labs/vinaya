---
'@attalabs/vinaya': patch
---

A pull request's CI and a local push no longer run the whole repository suite on every change: its tests are selected by what they read, like every other test, and the build job runs only the selected ones through the schedule's `build` placement. The inventory check still runs on every pull request, and a push to the default branch still runs the whole suite.
