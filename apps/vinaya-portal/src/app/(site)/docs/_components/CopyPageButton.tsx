'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/ui/components'

/** Copies the page's text, for pasting into an agent or a chat. */
export function CopyPageButton() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const article = document.querySelector<HTMLElement>('[data-doc-article]')
    if (!article) return
    await navigator.clipboard.writeText(article.innerText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Button variant='subtle' size='sm' onClick={copy} className='shrink-0 gap-2'>
      {copied ? <Check className='size-4' aria-hidden /> : <Copy className='size-4' aria-hidden />}
      {copied ? 'Copied' : 'Copy page'}
    </Button>
  )
}
