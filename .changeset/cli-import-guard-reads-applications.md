---
"@attalabs/vinaya": patch
---

The command line's import guard reads the repository's other applications from their manifests when it runs and refuses an import of any of them from the command line's source or tests folder, by package name, by subpath or by a relative path into the application's folder. The test selector's entry for the guard names each of those manifests among its roots, so a change to one selects the guard.
