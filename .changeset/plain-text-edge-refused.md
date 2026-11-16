---
'@attalabs/vinaya': patch
---

A `Depends-on` or `Conflicts-with` edge written in plain text, outside backticks, is now refused when a task Issue is created, edited or validated, with one error naming the label and its ids and the backtick form to use. Before, the edge was dropped without a word, the rendered brief read `Depends-on: —`, and the task could start before the task it depends on. Prose that mentions the label with no edge id, such as `No Depends-on: it needs only merged code`, still passes.
