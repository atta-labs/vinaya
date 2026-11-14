// Read by the recorder's source scan, never run: a lookup whose specifier is computed.
const name = process.argv[2] ?? 'widget'
export const where = import.meta.resolve(`./${name}`)
