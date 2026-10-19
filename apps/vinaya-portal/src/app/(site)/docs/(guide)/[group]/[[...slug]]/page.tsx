import { notFound } from 'next/navigation'
import { MarkdownDoc } from '../../../_components/MarkdownDoc'
import { DOCS_PAGES, findDocsPage } from '../../../_lib/portal-docs'

/** Only the Markdown-backed pages listed in the docs nav exist under this route; a set's entry page has no slug. */
export const dynamicParams = false

export function generateStaticParams() {
  return DOCS_PAGES.filter((p) => p.source).map((p) => {
    const [, , group, ...slug] = p.href.split('/')
    return { group, slug: slug.length > 0 ? slug : undefined }
  })
}

const pageFor = (group: string, slug: string[] = []) => findDocsPage(['/docs', group, ...slug].join('/'))

export async function generateMetadata({ params }: PageProps<'/docs/[group]/[[...slug]]'>) {
  const { group, slug } = await params
  const page = pageFor(group, slug)
  return { title: page ? `${page.title} · Vinaya Docs` : 'Vinaya Docs' }
}

export default async function TreeDocPage({ params }: PageProps<'/docs/[group]/[[...slug]]'>) {
  const { group, slug } = await params
  const page = pageFor(group, slug)
  if (!page?.source) notFound()
  return (
    <MarkdownDoc
      page={{ ...page, source: page.source }}
      eyebrow={
        page.parent?.title ??
        (['Guides', 'Features', 'CLI', 'Dev Process', 'Integration', 'Reference'].includes(page.section)
          ? page.section
          : page.group.title)
      }
    />
  )
}
