---
'@attalabs/aeg-core': patch
---

The rendered brief no longer tells the Developer to paste the brief into the pull-request body, to include a token report, to confirm dispatch readiness itself, or to run the documentation gate by hand before opening. It states one publication rule: publish once when every Part is done, then open the pull request, and publish again only to answer review findings or a red gate. The brief and PR report templates now say the same, and a test keeps the render and both templates on one list of retired instructions.
