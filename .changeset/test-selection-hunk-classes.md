---
'@attalabs/test-selection': minor
---

The package exports `classifyHunks`, which classifies each hunk of a change to one TypeScript file from the file's two texts: `body-only` when the hunk lies strictly inside one function's body and that function's signature and enclosing declarations are unchanged (naming the function, with its body span and the spans of the functions nested in it on both sides), `inert-addition` when it only adds top-level declarations that do nothing at load and bind no name the old text wrote (listing the names and any type-only import specifiers), and `unclassified` otherwise. A new, deleted, renamed, non-`.ts` or test file, a file that does not parse or has a load-time error, and a file without the TypeScript API are unclassified throughout, as is every hunk of a file with one unclassified hunk. No existing selection result changes.
