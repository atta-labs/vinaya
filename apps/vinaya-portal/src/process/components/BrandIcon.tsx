import {
  siAnthropic,
  siApple,
  siAsana,
  siClaude,
  siCloudflare,
  siDatadog,
  siGithub,
  siGrafana,
  siJira,
  siLanggraph,
  siLinear,
  siLinux,
  siOpenai
} from 'simple-icons'
import { cn } from '@/ui/lib/utils'

/**
 * Brand marks, the way the portal draws them: simple-icons paths painted in
 * `currentColor`. Everything that is not a brand is a lucide icon.
 */
export type Brand =
  | 'langgraph'
  | 'linear'
  | 'jira'
  | 'claude'
  | 'anthropic'
  | 'codex'
  | 'apple'
  | 'linux'
  | 'asana'
  | 'cloudflare'
  | 'github'
  | 'datadog'
  | 'grafana'

const paths: Record<Brand, string> = {
  linear: siLinear.path,
  jira: siJira.path,
  langgraph: siLanggraph.path,
  claude: siClaude.path,
  anthropic: siAnthropic.path,
  codex: siOpenai.path,
  apple: siApple.path,
  linux: siLinux.path,
  asana: siAsana.path,
  cloudflare: siCloudflare.path,
  datadog: siDatadog.path,
  grafana: siGrafana.path,
  github: siGithub.path
}

/** A brand's simple-icons path (24 × 24), for drawings that paint the mark themselves (the life-cycle scene). */
export const brandPath = (brand: Brand): string => paths[brand]

export function BrandIcon({ brand, className }: { brand: Brand; className?: string }) {
  return (
    <svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true' className={cn('size-4 shrink-0', className)}>
      <path d={paths[brand]} />
    </svg>
  )
}
