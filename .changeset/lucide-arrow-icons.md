---
"csuite-web-ui": patch
"csuite-web-host": patch
---

Replace the ad-hoc Unicode arrows on shell buttons with Lucide icons.

Directional glyphs (`←`, `→`, `↑`, `↓`, `▲`, `▼`, `›`) were typed straight into button labels and breadcrumbs, so they rendered in the text font rather than from the icon set every other affordance draws from. They now come from the icon registry.

- `ArrowLeft` / `ArrowRight` / `ArrowUp` are added to `components/icons/index.ts` and re-exported from the package root, alongside the existing chevrons.
- Back links (Tools, Notifications, Secrets, Objectives, Home), forward actions (`Manage`, `DM`, `Profile`, `View profile`, `Reassign`, `VIEW AGENT`, `Browse files`, `Open Files`), submit buttons (`Create + assign`, `Sign in`), and the `Load older` pagers all render an icon plus a plain-text label.
- The objective discussion's `Send` button now uses the `Send` icon, matching the composer.
- Breadcrumb separators and the audit-log / API-call disclosure toggles use `ChevronRight` / `ChevronUp` / `ChevronDown`.
- `.crumbs` gains inline-flex alignment so a crumb's icon and label share a centre line.

Non-button arrows are untouched: assignee and delivery meta text, the `in→out tok` usage separator, and the file-type glyph vocabulary (`▸`, `▶`, `◈`, `≡`, `⧉`, `◆`) keep their existing characters.
