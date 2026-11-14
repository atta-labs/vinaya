// A CommonJS package's listing: its own `require('fs')`, as an installed package would make it.
const fs = require('fs')

module.exports = function listFromPackage(folder) {
  return fs.readdirSync(folder).sort()
}
