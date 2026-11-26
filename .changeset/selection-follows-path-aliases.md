---
"@attalabs/test-selection": minor
---

Selection takes a table of path aliases (`SelectionPolicy.pathAliases`, `FileSelectionOptions.pathAliases`, and the `pathAliases` key of the consumer config) and follows an aliased import the way it follows a relative one, in both its compiler walk and its text-scan walk. `resolveAliasedSpecifier` maps an aliased specifier to the repository path it names. With no table, nothing changes.
