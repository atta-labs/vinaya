---
"@attalabs/vinaya": patch
---

Three planner fixes for repositories that install Vinaya from npm. A task whose Boundary names only new files now renders its brief: the `**Premise:**` block says every named file is new instead of refusing the task, and premise coverage accepts that line. Step 0 of a brief installs dependencies with the package manager whose lockfile the repository commits (`npm ci` for `package-lock.json`, pnpm or Yarn for theirs, Bun otherwise), and the Step 0 gate accepts that install. A repository-root file such as `README.md` named in the Boundary's `Pinned files:` clause is now pinned instead of dropped.
