---
'@attalabs/vinaya': patch
---

The driver's `fetch_documentation` tool counts a `text/html` page as a documentation read only when its visible text (script and style elements, tags and extra whitespace removed) reaches the minimum read size, so a script-heavy application shell no longer records a receipt. The page is still returned, with the visible-text size named as the reason; other text content types keep the raw-size rule. The measure is the exported `visibleTextSize`.
