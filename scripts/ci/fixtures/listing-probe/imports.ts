// Only loads a module from `target/`: Bun's resolver lists the folder, the code lists nothing, so the probe logs nothing.
import { value } from './target/mod'

console.log(JSON.stringify({ value }))
