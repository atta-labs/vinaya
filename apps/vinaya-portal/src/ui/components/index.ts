// The portal's component library, built on Ariakit with shadcn's CSS variables.
// Same names and props as the library it replaces, so call sites don't change.
export { Badge, type BadgeProps, type BadgeSize, type BadgeTone, type BadgeVariant } from './badge'
export {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from './breadcrumb'
export { Button, type ButtonProps, buttonVariants } from './button'
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card'
export { ChromeFrame, type ChromeFrameProps, type ChromeFrameVariant } from './chrome-frame'
export { Code, CodeBlock } from './code'
export {
  Collapsible,
  CollapsibleContent,
  type CollapsibleContentProps,
  type CollapsibleProps,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
  useCollapsible
} from './collapsible'
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from './command'
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
} from './dialog'
export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover'
export { RadioGroup, type RadioGroupProps, RadioItem, type RadioItemProps } from './radio-group'
export { Separator, type SeparatorProps } from './separator'
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from './sheet'
export {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar
} from './sidebar'
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  type TableProps,
  TableRow
} from './table'
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'
export { TerminalCommand } from './terminal-command'
export { Toggle, type ToggleProps, toggleVariants } from './toggle'
