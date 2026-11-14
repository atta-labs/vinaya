// Read by the recorder's source scan, never run: a module mock of a relative literal specifier.
import { mock } from 'bun:test'

mock.module('../src/widgets/widget', () => ({ Widget: () => null }))
