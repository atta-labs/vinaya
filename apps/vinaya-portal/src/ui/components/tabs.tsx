'use client'

import * as Ariakit from '@ariakit/react'
import { MotionConfig, motion } from 'motion/react'
import * as React from 'react'
import { cn } from '../lib/utils'

// Ariakit selects tabs by element id; the public API selects by value, as
// before. Each Tabs gets its own id prefix, so two lists that share values
// ("npm") never share DOM ids.
type TabValue = string | number

const TabsContext = React.createContext<{ prefix: string } | null>(null)

function useTabId(value: TabValue) {
  const context = React.useContext(TabsContext)
  if (!context) throw new Error('Tabs parts must be used within Tabs')
  return { id: `${context.prefix}-${value}`, prefix: context.prefix }
}

function useSelected(id: string) {
  const store = Ariakit.useTabContext()
  return Ariakit.useStoreState(store, (state) => state?.selectedId === id)
}

type TabsProps = Omit<React.ComponentProps<'div'>, 'defaultValue' | 'onChange'> & {
  value?: TabValue
  defaultValue?: TabValue
  onValueChange?: (value: string) => void
}

/**
 * The panels slide past each other (Ariakit's animated-TabPanel recipe), so
 * they share one grid cell: Tabs gathers every `TabsContent` child into a
 * clipped stack where the first one stood. Everything else stays in place.
 */
function Tabs({ value, defaultValue, onValueChange, className, children, ...props }: TabsProps) {
  const prefix = React.useId()
  const toId = (v: TabValue | undefined) => (v === undefined ? undefined : `${prefix}-${v}`)
  const items = React.Children.toArray(children)
  const isPanel = (child: React.ReactNode) => React.isValidElement(child) && child.type === TabsContent
  const panels = items.filter(isPanel)
  const firstPanel = items.findIndex(isPanel)
  const laidOut =
    firstPanel < 0
      ? items
      : [
          ...items.slice(0, firstPanel).filter((child) => !isPanel(child)),
          <div key='tabs-panels' data-slot='tabs-panels' className='grid overflow-x-clip'>
            {panels}
          </div>,
          ...items.slice(firstPanel).filter((child) => !isPanel(child))
        ]
  return (
    <TabsContext.Provider value={{ prefix }}>
      <Ariakit.TabProvider
        selectedId={toId(value)}
        defaultSelectedId={toId(defaultValue)}
        setSelectedId={(id) => {
          if (id && onValueChange) onValueChange(id.slice(prefix.length + 1))
        }}
      >
        <MotionConfig reducedMotion='user'>
          <div data-slot='tabs' className={className} {...props}>
            {laidOut}
          </div>
        </MotionConfig>
      </Ariakit.TabProvider>
    </TabsContext.Provider>
  )
}

function TabsList({ className, ...props }: Ariakit.TabListProps) {
  return (
    <Ariakit.TabList
      data-slot='tabs-list'
      className={cn('relative flex items-center gap-0 border-b border-border/20', className)}
      {...props}
    />
  )
}

type TabsTriggerProps = Omit<Ariakit.TabProps, 'id'> & { value: TabValue }

function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  const { id, prefix } = useTabId(value)
  const selected = useSelected(id)
  return (
    <Ariakit.Tab
      id={id}
      data-slot='tabs-trigger'
      data-active={selected ? '' : undefined}
      data-state={selected ? 'active' : 'inactive'}
      className={cn(
        'relative h-auto cursor-pointer rounded-none bg-transparent px-4 pt-0 pb-3',
        'font-mono text-xs tracking-widest uppercase',
        'text-foreground/40 transition-colors hover:bg-transparent hover:text-foreground/70',
        'data-[active]:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
        'disabled:pointer-events-none disabled:opacity-40',
        className
      )}
      {...props}
    >
      {children}
      {selected && (
        // The underline moves from tab to tab (a shared layout animation).
        <motion.span
          aria-hidden
          layoutId={`${prefix}-indicator`}
          transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
          className='absolute inset-x-0 -bottom-px h-0.5 bg-foreground'
        />
      )}
    </Ariakit.Tab>
  )
}

function usePrevious<T>(value: T) {
  const ref = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}

type TabsContentProps = Omit<Ariakit.TabPanelProps, 'tabId'> & {
  value: TabValue
  /** Keep the panel in the DOM while hidden (Ariakit marks it `hidden`). */
  keepMounted?: boolean
  forceMount?: boolean
}

/**
 * A panel that slides in from the side of the tab it replaces and the old one
 * out the other way. `data-was-open` marks the panel that was showing a moment
 * ago; nothing animates on first render, only once a panel has been left.
 */
function TabsContent({ value, keepMounted, forceMount, className, ...props }: TabsContentProps) {
  const { id } = useTabId(value)
  const store = Ariakit.useTabContext()
  const previous = usePrevious(Ariakit.useStoreState(store, 'selectedId'))
  return (
    <Ariakit.TabPanel
      tabId={id}
      data-slot='tabs-content'
      data-was-open={previous === id || undefined}
      unmountOnHide={!(forceMount ?? keepMounted)}
      className={cn(
        'col-start-1 row-start-1 mt-6 outline-none',
        'transition-[opacity,translate] duration-300 ease-out motion-reduce:transition-none',
        // Hidden state, only once a panel has been left (no animation on load).
        '[:has(>[data-was-open])>&]:opacity-0 [:has(>[data-was-open])>&]:[translate:-100%]',
        // Panels after the one showing wait on the right.
        '[:is([data-was-open],[data-open])~&]:[translate:100%]',
        'data-enter:![translate:0] data-enter:!opacity-100',
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
