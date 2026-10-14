---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
'@attalabs/vinaya-sources': minor
---

A repository opts into decision records. `decisionRecords.path` names a folder of the repository; load refuses one outside the repository or inside the doctrine tree, naming the key. With it set, the folder joins the writing rules' `spec` scope, the `decision-record-citation` rule blocks `ADR` followed by a number and any path to a numbered record everywhere but the folder itself (including the published pass), and `vinaya new adr <title>` writes the next numbered record from the shipped decision-record template with status Proposed and adds it to the folder's index page. With the key absent, every check, command and finding is unchanged.
