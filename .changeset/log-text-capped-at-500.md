---
"@attalabs/vinaya-log-sdk": patch
---

Every text value the writer stores, including each text in a list, is at most 500 characters after redaction; a longer one is cut so that it ends with `…`. A custom event's text field over 500 characters is still refused.
