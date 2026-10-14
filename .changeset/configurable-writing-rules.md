---
'@attalabs/vinaya': minor
'@attalabs/aeg-core': minor
'@attalabs/vinaya-sources': minor
---

A repository configures its own writing rules. `proseGates.rules` switches a default prose rule off, retunes its scopes, severity or exemptions, and adds custom rules whose findings print the rule's id, the file and line, the matched text and its message; `proseGates.productPaths` replaces the product class's file set, and `proseGates.published.allow` replaces the published pass's allowed mechanics. Every key is validated at load and a malformed one refuses the run, naming the key. `reader-resolvable-prose` runs the reader-resolvable group and `retired-vocabulary` the retired group of the one rule set, and `vinaya check --plan` prints which rules each runs. With none of the keys set, every finding is unchanged.
