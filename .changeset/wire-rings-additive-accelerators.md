---
"@attalabs/vinaya": patch
"@attalabs/vinaya-sources": patch
---

Wires `vinaya.config.json`'s `rings.ring1_forgeWriteInterception` and `rings.ring2_asyncAudits` into real enforcement — until now `rings` had exactly one live consumer (Studio's diagram renderer) and zero CLI-behavior consumers, despite every `vinaya init` starter config already shipping both keys.

Additive, never disabling: `false`/absent is a no-op — every existing adopter's enforcement runs exactly as it does today, unchanged by upgrading. `true` is the new opt-in accelerator, the only value that changes behavior. `ring1_forgeWriteInterception: true` skips `pr`/`issue`/`milestone create|edit`'s `briefSchema` validation entirely. `ring2_asyncAudits: true` skips `vinaya archive`'s provenance work and `vinaya audit`'s dead-branch-push notification — deliberately not `vinaya audit`'s direct-main-push detection, which stays unconditional regardless of the flag: it is a real pass/fail that catches a branch-protection bypass, and a config-readable on/off switch for it would let the bypass silently disable the check that catches it.
