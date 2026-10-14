---
'@attalabs/vinaya': patch
---

The code and security reviewers now read a required source through their own `read_source` tool: the content the controller pinned for the Developer's turn, its final URL and its digest, in bounded pages, never a fresh fetch. Both reviewers' prompts name the required-source manifest and the Developer's source citations. A `completed` Developer turn is accepted only when every required source, a repository source included, has a citation backed by a delivery receipt the controller recorded.
