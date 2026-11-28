---
"@attalabs/vinaya": patch
---

A later Plan review round's prompt, output schema and validator agree on how a confirmed finding is named. The prompt states that each confirmation's `finding` field holds the finding's `id` exactly as the list gives it and nothing else; the session's output schema allows only the ids that round asks to confirm; and a round with nothing to confirm gets a schema whose `confirmations` list holds at most zero items. The validator still accepts only the exact id.
