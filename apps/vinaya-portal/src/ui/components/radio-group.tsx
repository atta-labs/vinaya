'use client'

import * as Ariakit from '@ariakit/react'
import * as React from 'react'
import { cn } from '../lib/utils'

// A single-choice group on Ariakit's radio: one Tab stop, arrow keys (and
// Home/End) move between choices and pick as they go, Space or Enter picks.
// Items can render as any element (a Card, a Button), not only <input>.

type RadioGroupProps = Omit<Ariakit.RadioGroupProps, 'store' | 'onChange'> & {
  value?: string | null
  defaultValue?: string
  onValueChange?: (value: string) => void
}

function RadioGroup({ value, defaultValue, onValueChange, className, ...props }: RadioGroupProps) {
  return (
    <Ariakit.RadioProvider
      value={value}
      defaultValue={defaultValue}
      setValue={(next) => {
        if (next != null) onValueChange?.(String(next))
      }}
    >
      <PickOnMove />
      <Ariakit.RadioGroup data-slot='radio-group' className={cn(className)} {...props} />
    </Ariakit.RadioProvider>
  )
}

/**
 * A native radio is checked as arrow keys reach it; a custom element is not.
 * Ariakit counts keyboard moves in `moves`, so each move picks the item it
 * landed on (the WAI radio pattern). Clicks pick through Ariakit itself.
 */
function PickOnMove() {
  const store = Ariakit.useRadioContext()
  const moves = Ariakit.useStoreState(store, 'moves')
  React.useEffect(() => {
    if (!store || !moves) return
    const { activeId } = store.getState()
    const value = activeId ? store.item(activeId)?.element?.getAttribute('data-value') : null
    if (value != null) store.setValue(value)
  }, [store, moves])
  return null
}

type RadioItemProps = Omit<Ariakit.RadioProps, 'store' | 'value'> & {
  value: string
  /** The element the choice renders as, e.g. `<Card />`; children go inside it. */
  render?: React.ReactElement
}

/** One choice. `data-checked` marks the picked one for styling. */
function RadioItem({ value, render, ...props }: RadioItemProps) {
  const store = Ariakit.useRadioContext()
  const checked = Ariakit.useStoreState(store, (state) => state?.value === value)
  return (
    <Ariakit.Radio
      data-slot='radio-item'
      data-checked={checked ? '' : undefined}
      value={value}
      data-value={value}
      render={render ?? <div />}
      {...props}
    />
  )
}

export { RadioGroup, type RadioGroupProps, RadioItem, type RadioItemProps }
