# Web UI capability-gate classification

**Derivation.** Generated from `packages/web-ui/src/**/*.tsx` at commit
`78b49fb` (branch `fix/ui-capability-gates`, base `origin/develop@eef2de3`)
by the script in the appendix. Not a grep for permission-shaped words: the
candidate set is every JSX conditional whose guarded block contains
`<button`, `<form`, `onClick=` or `onSubmit=`.

- 199 conditional renders total
- **69** guard a control ← the set below
- 85 `disabled={}` expressions enumerated separately; all busy/validation

**Classification rule**, applied mechanically then reviewed by hand:
`CAPABILITY` if the guard references identity, role, permission or
ownership; otherwise `state` (busy/error/confirming), `navigation`
(tab/mode), or `data` (presence/length of data).

**16 of 69 are capability-shaped.** The other 53 are non-capability by the
rule above, reviewed but not individually traced to server predicates —
that is the honest limit of this pass and is why the count is stated
rather than "the rest are fine."

## Capability-shaped gates

| gate | server predicate | traced? | verdict |
|---|---|---|---|
| `FilesPanel.tsx:381` Delete | `canWrite()` = admin \| owner \| objective member | **yes** | **FIXED** — was `owner === viewer`, false for every namespace member |
| `ObjectiveDetail.tsx` status | assignee \| `objectives.cancel` | **yes** | **FIXED** — used `members.manage`, diverged both ways |
| `FilesPanel.tsx:268` all-files | `listAllFiles` throws unless `members.manage` | **yes** | agrees |
| `ChannelSettings.tsx:262` remove/leave | channel admin, or self-leave; server also enforces a last-admin guard the UI does not model | **yes** | agrees on who; UI cannot predict the last-admin refusal — button may 403 |
| `ChannelSettings.tsx:201,281,322` | `channel.myRole === 'admin'` — server-provided role, not inferred | partial | no divergence found |
| `ChannelHeader.tsx:64` | `myRole === 'admin'` / `joined` | partial | no divergence found |
| `TeamHome.tsx:265`, `ObjectiveDetail.tsx:857` | `canManage` from briefing permissions | partial | no divergence found |
| `NavColumn.tsx:182`, `Transcript.tsx:127`, `ObjectiveDetail.tsx:276` | `members.manage` — view gates, not mutating | no | out of scope: guards visibility, not a mutation |
| `MemberProfile.tsx:192`, `ui/Mention.tsx:145` | `!isSelf` → opens a DM | no | UX choice, no server predicate |
| `SecretDetail.tsx:283`, `ToolSourceDetail.tsx:417` | `!allMembers` — a data field of the secret/source | no | data condition, not identity |

**One residue worth naming:** `ChannelSettings.tsx:262` agrees with the
server about *who*, and cannot model the server's last-admin guard. That
is a more-permissive gate by construction — the UI cannot know whether a
removal would empty the channel of admins. Unlike the two fixed cases it
is not resolvable by asking a different question about the viewer; it
needs the server to say whether *this specific removal* is allowed.

## What this enumeration cannot reach

- a control gated by an early `return null` in the component body
- a gate computed in a hook and passed down as a prop
- anything in `apps/web-host`
- `disabled=` gates that combine capability with busy state

## Appendix — the script

```js
// run from packages/web-ui/src
const files=[]; walk('.');            // all *.tsx
for (const f of files) for (const [i,line] of lines.entries()) {
  const m = line.match(/\{([^}]*?)&&\s*\(?\s*$|\{([^}]*?)&&\s*</);
  if (!m) continue;
  const cond = (m[1]||m[2]||'').trim();
  if (!cond || cond.length > 90) continue;
  const block = lines.slice(i, i+14).join('\n');
  if (!/<button|<form|onClick=|onSubmit=/.test(block)) continue;
  hits.push({file: f, line: i+1, cond});
}
```

## Full enumeration

| gate | guard | class |
|---|---|---|
| components/ActivityInspector.tsx:234 | `!isPinned` | state |
| components/AgentTimeline.tsx:558 | `rows.length === 0 && loading` | state |
| components/AgentTimeline.tsx:559 | `rows.length === 0 && !loading` | state |
| components/AgentTimeline.tsx:565 | `canLoadOlder` | data |
| components/ChannelBrowse.tsx:63 | `loadErr !== null` | data |
| components/ChannelCreate.tsx:126 | `submitError.value !== null` | data |
| components/ChannelHeader.tsx:64 | `(canManage || canLeave)` | CAPABILITY |
| components/ChannelSettings.tsx:190 | `memberError.value !== null` | data |
| components/ChannelSettings.tsx:201 | `isAdmin` | CAPABILITY |
| components/ChannelSettings.tsx:262 | `(isAdmin || m.memberName === viewer)` | CAPABILITY |
| components/ChannelSettings.tsx:281 | `isAdmin && addableTeammates.length > 0` | CAPABILITY |
| components/ChannelSettings.tsx:312 | `channel.joined && channel.id !== 'general'` | CAPABILITY |
| components/ChannelSettings.tsx:322 | `isAdmin` | CAPABILITY |
| components/CommandPalette.tsx:142 | `ranked.length === 0` | data |
| components/FilesPanel.tsx:268 | `isAdmin` | CAPABILITY |
| components/FilesPanel.tsx:285 | `current.error` | state |
| components/FilesPanel.tsx:392 | `current.mode !== 'shared' && entry.canWrite === true` | navigation |
| components/MemberProfile.tsx:192 | `!isSelf` | CAPABILITY |
| components/MemberProfile.tsx:223 | `effectiveTab === 'objectives'` | navigation |
| components/MemberProfile.tsx:224 | `effectiveTab === 'activity'` | navigation |
| components/MemberProfile.tsx:225 | `effectiveTab === 'files'` | navigation |
| components/MemberProfile.tsx:240 | `effectiveTab === 'manage'` | navigation |
| components/NotificationDetail.tsx:386 | `!usingProfile` | state |
| components/NotificationDetail.tsx:395 | `endpoint.hasSecret` | data |
| components/NotificationDetail.tsx:738 | `delivery.replayOf !== null` | data |
| components/NotificationDetail.tsx:739 | `delivery.messageIds.length > 0` | data |
| components/NotificationDetail.tsx:808 | `confirming` | state |
| components/NotificationsPanel.tsx:363 | `err !== null` | state |
| components/NotificationsPanel.tsx:373 | `profileFormOpen.value` | state |
| components/NotificationsPanel.tsx:503 | `secretOpen` | state |
| components/ObjectiveCreate.tsx:244 | `watchers.value.length > 0` | data |
| components/ObjectiveCreate.tsx:347 | `err.value` | state |
| components/ObjectiveDetail.tsx:276 | `tab === 'trace' && isAdmin` | CAPABILITY |
| components/ObjectiveDetail.tsx:277 | `tab === 'audit'` | navigation |
| components/ObjectiveDetail.tsx:486 | `canUpdateStatus && objective.status === 'blocked'` | data |
| components/ObjectiveDetail.tsx:789 | `Object.keys(ev.payload).length > 0` | data |
| components/ObjectiveDetail.tsx:795 | `events.length > 5` | data |
| components/ObjectiveDetail.tsx:857 | `canManage` | CAPABILITY |
| components/SecretDetail.tsx:283 | `!secret.allMembers` | CAPABILITY |
| components/SecretDetail.tsx:285 | `boundMembers.length === 0` | data |
| components/SecretDetail.tsx:290 | `boundMembers.length > 0` | data |
| components/SecretDetail.tsx:451 | `confirming` | state |
| components/TeamHome.tsx:265 | `canManage` | CAPABILITY |
| components/ToolSourceDetail.tsx:254 | `t.description.length > 0` | data |
| components/ToolSourceDetail.tsx:260 | `isCustom` | data |
| components/ToolSourceDetail.tsx:417 | `!source.allMembers` | CAPABILITY |
| components/ToolSourceDetail.tsx:419 | `boundMembers.length === 0` | data |
| components/ToolSourceDetail.tsx:424 | `boundMembers.length > 0` | data |
| components/ToolSourceDetail.tsx:623 | `confirming` | state |
| components/Transcript.tsx:119 | `showDmHeader && dmCounterpart` | navigation |
| components/Transcript.tsx:127 | `isDirector` | CAPABILITY |
| components/Transcript.tsx:167 | `canLoadOlder` | data |
| components/Transcript.tsx:193 | `!isPinned && messages.length > 0` | state |
| components/members/MemberTokenList.tsx:181 | `t.expiresAt !== null` | data |
| components/members/MemberTokenList.tsx:182 | `t.createdBy !== null` | data |
| components/members/PendingEnrollments.tsx:135 | `e.sourceUa !== null` | data |
| components/members/PermissionsEditor.tsx:47 | `(presetEntries.length > 0 || true)` | data |
| components/shell/NavColumn.tsx:182 | `isAdmin` | CAPABILITY |
| components/shell/NavColumn.tsx:191 | `canManageTools` | data |
| components/shell/NavColumn.tsx:200 | `canManageSecrets` | data |
| components/shell/NavColumn.tsx:209 | `canManageNotifications` | data |
| components/shell/NavColumn.tsx:437 | `showSignOut` | state |
| components/ui/ErrorCallout.tsx:25 | `title` | data |
| components/ui/ErrorCallout.tsx:27 | `onRetry` | data |
| components/ui/ErrorCallout.tsx:39 | `onDismiss` | data |
| components/ui/Mention.tsx:136 | `teammate?.role.description` | data |
| components/ui/Mention.tsx:145 | `!isSelf` | CAPABILITY |
| components/ui/ToastContainer.tsx:81 | `toast.title !== undefined` | data |
| components/ui/ToastContainer.tsx:83 | `toast.action !== undefined` | data |
