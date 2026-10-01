---
'@attalabs/vinaya': minor
---

The CLI's minimum supported Node version is now 22.13, raised from 20 — a change to the public install contract, so an install on Node 20 or 22.0–22.12 is warned by npm's engine check. The workflows `vinaya init` and `vinaya upgrade` generate set up Node 22, and `vinaya doctor` reports a managed workflow still on Node 20 as out of date.
