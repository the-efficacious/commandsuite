/**
 * Public API — csuite-web-ui.
 *
 * Everything a host needs to embed the shell:
 *   - `<TeamShell>` root component
 *   - `Identity` type for the identity prop
 *   - `SignOutHandler` / `UnauthorizedHandler` callback types
 *
 * Styles ship separately at `csuite-web-ui/styles.css`.
 *
 * Anything beyond this module is implementation detail. Consumers
 * should NOT deep-import lib/ or components/ directly — those file
 * paths are not a stable surface and may move without notice.
 */

export { BrandMark, type BrandMarkProps } from './components/icons/BrandMark.js';
export {
  AlertCircle,
  AlertTriangle,
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Folder,
  Hash,
  Home,
  Inbox,
  Info,
  LogOut,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  PanelRight,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Slash,
  Sun,
  Target,
  Users,
  Wand2,
  WifiOff,
  X,
} from './components/icons/index.js';
export { RouteModal, type RouteModalProps } from './components/RouteModal.js';
export { Hint, type HintKind, type HintProps } from './components/ui/Hint.js';
export { ToastContainer } from './components/ui/ToastContainer.js';
export type { SignOutHandler, UnauthorizedHandler } from './lib/handlers.js';
export type { Identity } from './lib/identity.js';
export {
  closeInspector,
  isInspectorOpen,
  openInspector,
  toggleInspector,
} from './lib/inspector.js';
export {
  cycleThemeMode,
  type EffectiveTheme,
  effectiveTheme,
  initTheme,
  setThemeMode,
  type ThemeMode,
  themeMode,
} from './lib/theme.js';
export {
  clearAllToasts,
  dismissToast,
  dismissToastsByTag,
  type Toast,
  type ToastAction,
  type ToastKind,
  type ToastOptions,
  toast,
  toasts,
} from './lib/toast.js';
export { closeSidebar, isSidebarOpen, openSidebar } from './lib/view.js';
export { TeamShell, type TeamShellProps } from './TeamShell.js';
