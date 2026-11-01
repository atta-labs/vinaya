---
'@attalabs/vinaya': patch
---

Test selection links a test that starts a script with `bun <script>` to that script's own imports instead of the CLI's whole source folder, when every start in the test reads that way and the script starts no `bun` itself; any other start the selector cannot read keeps the folder-wide edge.
