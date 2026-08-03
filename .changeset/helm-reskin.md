---
'csuite-web-ui': minor
'csuite-web-host': minor
'csuite-sdk': minor
'csuite-server': minor
'csuite-cli': minor
---

Adopt the Helm design system from `@the-efficacious/brand`.

The web shell's entire visual layer now resolves through the brand
package's `--ef-*` role tokens — the legacy token vocabulary (`--ink`,
`--paper`, `--steel`, `--ember`, …) is gone, along with the local token
block and the dusk-mode remap in `theme.css`. Breaking contract changes
for hosts and integrators:

- **Theme attribute**: the shell now drives `data-ef-theme` on `<html>`
  (`helm` dark is the `:root` default; `helm-light` is the light theme).
  `data-theme` is no longer set. The `csuite:theme` localStorage
  contract is unchanged, but `auto` is now stored explicitly and the
  unset default is **dark** — Helm is dark-native.
- **Utilities**: hosts compiling atomic utilities must compose
  `@the-efficacious/brand/uno`'s `efficacious()` preset after
  `presetWind4()`. The hand-rolled `brand-*` colors and breakpoint
  overrides are gone; breakpoints come from the shared scale
  (700/900/1100/1280).
- **Sender colors**: `senderTextClass(kind)` replaces
  `senderTextClass(sender, viewer)` — the axis is person vs agent
  (Helm plate 14), resolved from the roster. `Teammate.kind?: 'person'
  | 'agent'` is new in the SDK; servers derive it from TOTP enrollment
  and omit it when unknown.
- **Identity tiles**: `.avatar` is now the plate-14 square tile
  (`data-kind`, `data-size` 20/26/34/48/64, optional `.avatar-dot`
  presence lamp). The `sm/lg/xl/dark/ember` modifiers are gone.
- **Badges**: `.badge.ember` → `.badge.caution`, `.badge.glacier` →
  `.badge.info`; `.btn-accent` is removed (use `.btn-destructive` for
  stop actions). Lamp components pick up the five-state grammar,
  including `working` and `stood-down`.
- **CLI**: activity printers and the HUD paint Helm roles (lamp grammar
  for connection state; the gold mark on the `csuite` word).

Brand tokens and fonts ship transitively via `csuite-web-ui/styles.css`;
the served UI (`csuite-server`'s `public/`) also exposes them at
`/brand/*.css` for server-rendered pages.
