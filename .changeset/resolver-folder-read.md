---
'@attalabs/vinaya': patch
---

The read recorder no longer counts the module resolver's opening of a `node_modules` folder as a read of the whole lockfile. Bun opens that folder on every bare import, so nearly every test looked like a reader of the whole lockfile and any dependency change still selected them all. A read naming no package now records nothing; the packages a test loads stay recorded one by one.
