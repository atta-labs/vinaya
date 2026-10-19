import type { ConfigField } from '@attalabs/vinaya-sources'
import { Badge, CodeBlock } from '@/ui/components'
import { Heading } from '@/ui/shared'
import { configFieldSlug } from './config-navigation'
import { FieldProse } from './FieldProse'

/**
 * One `CONFIG_REFERENCE` row — key/type/prose/example, plus the secrets
 * warning callout for the one field that carries one (`checks.env.literal`).
 * `depth` (the number of `.` segments in `field.key`) sizes the heading so a
 * nested field (`rings.ring1_forgeWriteInterception`, `checks.env.anyOf`)
 * reads as a child of its parent row rather than a sibling section — and
 * keeps the rail's sections (`h2`) distinct from the fields under them.
 *
 * `scroll-mt-16` clears `StickyDocHeader`'s bar rather than the `scroll-mt-6`
 * `/docs/start/cli`'s sections use: this page renders that bar, and a deep link
 * (`/docs/features/configuration#config-checks-env-literal`) always lands scrolled past the
 * 80px threshold that pins it, so a smaller margin puts the anchored heading
 * underneath it. Coupled to the bar's `top-2` + `h-11`, same as `DocPage`'s
 * `top-15` table offset — move both together if that bar's height changes.
 */
export function ConfigFieldSection({ field }: { field: ConfigField }) {
  const depth = field.key.split('.').length
  const headingLevel = depth >= 3 ? 4 : depth === 2 ? 3 : 2

  return (
    <div id={configFieldSlug(field.key)} className='flex scroll-mt-16 flex-col gap-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <Heading level={headingLevel} family='serif'>
          {field.key}
        </Heading>
        <Badge variant='code' size='sm'>
          {field.type}
        </Badge>
      </div>

      {field.semantics.map((sentence) => (
        <FieldProse key={sentence} text={sentence} />
      ))}

      <CodeBlock className='my-0'>{field.example}</CodeBlock>

      {field.warning && (
        <div className='rounded-md border border-warning/40 px-4 py-3'>
          <FieldProse text={field.warning} />
        </div>
      )}
    </div>
  )
}
