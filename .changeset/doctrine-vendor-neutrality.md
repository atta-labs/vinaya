---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Shipped doctrine now names one AI vendor by product name in exactly one fenced, clearly-labeled place (`tranche-model.md` §12's collection-adapter example) — everywhere else it refers to the coding agent's host generically. `checkDoctrinePortability` (`doctrine-portability.ts`) gains a second, additive finding kind, `'vendor-name'`: a fixed word list (Claude, Claude Code, Anthropic, GPT, ChatGPT, OpenAI, Gemini, Codex, Grok, DeepSeek, Opus, Sonnet, Haiku — company/product names and model-tier names alike) scanned against doctrine prose outside code spans and outside a new `<!-- AEG:VENDOR-EXAMPLE:START -->` / `<!-- AEG:VENDOR-EXAMPLE:END -->` fence, so the rule no longer depends on a reviewer noticing. The original path-shape predicate (`'path'` findings) is unchanged.
