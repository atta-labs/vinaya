---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
'@attalabs/vinaya-sources': patch
---

A repository can declare its own Vinaya Log events in `vinaya.config.json`, under `logs.events`, and record them with no code written. Each event is named `<namespace>.<event>` (the `vinaya.` namespace is reserved) and declares up to 20 flat fields typed text, number, boolean, or one of a listed set of words; a declaration that breaks a rule is refused when the config loads, naming the entry.

A declared event with every field present and of its declared type is written as one line of the new `custom` family, valid under a schema 3 header only. An undeclared or malformed event writes no `custom` line: one `operation` event named `log.emit`, result `refused`, records the reason and the field names — never the values — and the caller receives the refusal. Secret-shaped values in a custom field are redacted like in every other event.
