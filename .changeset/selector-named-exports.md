---
'@attalabs/vinaya': patch
---

The pre-push test selection attributes a change inside a named export list (`export { a, b as c } from '…'`) to the names on the changed lines, so adding one name to a package barrel no longer selects every test that reaches the barrel. A change to the list's braces, its `from` clause, a one-line list or an `export *` still makes the whole file affected.
