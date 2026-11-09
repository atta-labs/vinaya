---
'@attalabs/vinaya': minor
---

`vinaya studio` builds and opens this repository's own Studio, with nothing downloaded. Packing the command line builds the Studio app from its source and ships its standalone server in the package. Inside a checkout the command runs the app from its source; from an installed package it runs the shipped server, and it refuses, saying the package is missing Studio, when neither is present. Studio listens on the loopback address only, on port 3008 or 3108 when 3008 is taken, and `--port` uses exactly the port given or refuses; once the port answers, the command opens the browser, or prints the address once when it cannot.
