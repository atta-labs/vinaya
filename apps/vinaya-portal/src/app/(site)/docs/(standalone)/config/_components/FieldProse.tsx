import { Code } from '@/ui/components'
import { Text } from '@/ui/shared'

// Route-private companion to the CLI detail renderer: inline code stays
// semantic while config prose remains authored in the shared registry.
export function FieldProse({ text }: { text: string }) {
  const parts = text.split('`')
  return (
    <Text as='p' family='sans' size='sm' tone='muted'>
      {/* biome-ignore lint/suspicious/noArrayIndexKey: segments of a fixed string never reorder; position is their identity */}
      {parts.map((part, index) => (index % 2 === 1 ? <Code key={`${index}-${part}`}>{part}</Code> : part))}
    </Text>
  )
}
