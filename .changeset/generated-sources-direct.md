---
'@attalabs/vinaya': patch
---

The Issue gate's generated-file rule now counts as a generated file's sources only the modules that decide its content, listed from the repository's history, instead of every module the writer imports. Before, nearly every task touching the Issue gate, the brief render or the kernel tool files was refused at planning and dispatch with demands to regenerate workflows, hooks and pointer files it never changes. `vinaya.config.json` and `.vinaya/doc-owners` are no longer treated as generated, since `vinaya upgrade` keeps them as the adopter's own content.
