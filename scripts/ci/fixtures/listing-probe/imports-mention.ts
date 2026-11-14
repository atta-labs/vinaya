// Only imports a module that mentions Bun's resolve functions and `bun:ffi`, and calls neither: not wholly scanned.
import { value } from './mentions-resolve'

console.log(JSON.stringify({ value }))
