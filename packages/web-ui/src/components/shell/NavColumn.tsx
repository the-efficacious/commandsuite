/**
 * NavColumn — the one left column.
 *
 *   ┌───────────────────────┐
 *   │  ▲ demo-team         │  team header
 *   │    ship the thing…    │
 *   ├───────────────────────┤
 *   │  Home                 │
 *   │  Inbox          ⓫     │
 *   │  Objectives     ⓷     │
 *   │  Files                │
 *   │  Members              │  admin only
 *   ├───────────────────────┤
 *   │  ━━ CHAT              │
 *   │  # Team Chat    ⓶     │
 *   │  ● alice             │
 *   │  ○ bob           ⓷    │
 *   ├───────────────────────┤
 *   │  [AV] alice        ⏏  │  user chip (click name → profile)
 *   └───────────────────────┘
 *
 * Team identity lives at the top, the viewer's own identity at the
 * bottom. The narrow-viewport drawer behavior is unchanged — the
 * whole column slides in driven by `isSidebarOpen`.
 */

import type { ActivityState, ChannelSummary, Teammate } from 'csuite-sdk/types';
import { hasPermission } from 'csuite-sdk/types';
import type { ComponentChildren } from 'preact';
import { briefing } from '../../lib/briefing.js';
import { channels, joinedChannels } from '../../lib/channels.js';
import { embeddedShell, teamSettingsHandler } from '../../lib/embedded.js';
import { handleSignOut, hasSignOutHandler } from '../../lib/handlers.js';
import { inboxCount } from '../../lib/inbox.js';
import {
  channelThreadKey,
  dmThreadKey,
  GENERAL_CHANNEL_ID,
  GENERAL_THREAD,
  messagesByThread,
} from '../../lib/messages.js';
import { objectives } from '../../lib/objectives.js';
import { presenceActivity, roster } from '../../lib/roster.js';
import { currentTeam } from '../../lib/team.js';
import { lastReadByThread, unreadCount } from '../../lib/unread.js';
import {
  isSidebarOpen,
  selectAccount,
  selectChannel,
  selectChannelCreate,
  selectChannelsBrowse,
  selectDmWith,
  selectFiles,
  selectInbox,
  selectMembers,
  selectNotifications,
  selectObjectivesList,
  selectOverview,
  selectSecrets,
  selectToolSources,
  view,
} from '../../lib/view.js';
import {
  BrandMark,
  Folder,
  Hash,
  Home,
  Inbox,
  Lock,
  LogOut,
  Plus,
  Settings,
  Target,
  Users,
  Webhook,
  Wrench,
} from '../icons/index.js';

export interface NavColumnProps {
  viewer: string;
}

export function NavColumn({ viewer }: NavColumnProps) {
  const v = view.value;
  const r = roster.value;
  const b = briefing.value;
  const lastRead = lastReadByThread.value;
  const msgMap = messagesByThread.value;

  const teammatesSource: Teammate[] = r?.teammates ?? b?.teammates ?? [];
  const teammates = teammatesSource.filter((t) => t.name !== viewer);

  const onlineByName = new Map<string, number>();
  // Live 3-state activity, orthogonal to the connection count above.
  // Only non-idle states are stored; a missing entry reads as idle.
  const activityByName = new Map<string, ActivityState>();
  if (r) {
    for (const a of r.connected) {
      onlineByName.set(a.name, a.connected);
      const state = presenceActivity(a);
      if (state !== 'idle') activityByName.set(a.name, state);
    }
  }

  const homeActive = v.kind === 'overview';
  const inboxActive = v.kind === 'inbox';
  const objectivesActive =
    v.kind === 'objectives-list' || v.kind === 'objective-detail' || v.kind === 'objective-create';
  const filesActive = v.kind === 'files';
  const membersActive = v.kind === 'members';
  const toolsActive = v.kind === 'tool-sources' || v.kind === 'tool-source-detail';
  const secretsActive = v.kind === 'secrets' || v.kind === 'secret-detail';
  const notificationsActive = v.kind === 'notifications' || v.kind === 'notification-detail';
  const inbox = inboxCount.value;
  const drawerOpen = isSidebarOpen.value;
  const isAdmin = b !== null && hasPermission(b.permissions, 'members.manage');
  const canManageTools = b !== null && hasPermission(b.permissions, 'tools.manage');
  const canManageSecrets = b !== null && hasPermission(b.permissions, 'secrets.manage');
  const canManageNotifications = b !== null && hasPermission(b.permissions, 'notifications.manage');
  const activeObjectiveCount = objectives.value.filter(
    (o) => o.assignee === viewer && (o.status === 'active' || o.status === 'blocked'),
  ).length;
  const channelList = joinedChannels();
  const channelsLoaded = channels.value !== null;
  const browseActive = v.kind === 'channels-browse';
  const createActive = v.kind === 'channel-create';

  // The shared `.drawer-backdrop` rendered in AppShell handles the
  // click-out dismissal for both navcol and inspector. NavColumn no
  // longer renders its own backdrop button — that was a duplicate
  // surface that conflicted with the shared layer.
  return (
    <nav
      class={`nav-drawer flex-shrink-0 flex-col
          md:static md:flex md:w-56 md:translate-x-0 md:shadow-none md:z-0
          fixed top-0 left-0 z-50 w-[85vw] max-w-72 transition-transform duration-200
          ${drawerOpen ? 'is-open translate-x-0 flex shadow-2xl' : '-translate-x-full hidden md:flex md:-translate-x-0'}`}
      style="background:var(--paper);border-right:1px solid var(--rule);padding-left:env(safe-area-inset-left);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);bottom:0"
    >
      <TeamHeader viewer={viewer} />

      {/* ── Work section ─────────────────────────────────────────── */}
      <div style="padding:8px 0;border-bottom:1px solid var(--rule)">
        <NavItem
          label="Home"
          glyph={<Home size={15} aria-hidden="true" />}
          active={homeActive}
          onClick={selectOverview}
          ariaLabel="Open team home"
        />
        <NavItem
          label="Inbox"
          glyph={<Inbox size={15} aria-hidden="true" />}
          active={inboxActive}
          onClick={selectInbox}
          ariaLabel={inbox > 0 ? `Open inbox (${inbox} items)` : 'Open inbox'}
          trailing={inbox > 0 && !inboxActive ? <UnreadBadge count={inbox} /> : undefined}
        />
        <NavItem
          label="Objectives"
          glyph={<Target size={15} aria-hidden="true" />}
          active={objectivesActive}
          onClick={selectObjectivesList}
          ariaLabel={
            activeObjectiveCount > 0
              ? `Open objectives panel (${activeObjectiveCount} on your plate)`
              : 'Open objectives panel'
          }
          trailing={
            activeObjectiveCount > 0 && !objectivesActive ? (
              <UnreadBadge count={activeObjectiveCount} />
            ) : undefined
          }
        />
        <NavItem
          label="Files"
          glyph={<Folder size={15} aria-hidden="true" />}
          active={filesActive}
          onClick={() => selectFiles(`/${viewer}`)}
          ariaLabel="Browse files"
        />
        {isAdmin && (
          <NavItem
            label="Members"
            glyph={<Users size={15} aria-hidden="true" />}
            active={membersActive}
            onClick={selectMembers}
            ariaLabel="Manage members"
          />
        )}
        {canManageTools && (
          <NavItem
            label="Tools"
            glyph={<Wrench size={15} aria-hidden="true" />}
            active={toolsActive}
            onClick={selectToolSources}
            ariaLabel="Manage tool sources"
          />
        )}
        {canManageSecrets && (
          <NavItem
            label="Secrets"
            glyph={<Lock size={15} aria-hidden="true" />}
            active={secretsActive}
            onClick={selectSecrets}
            ariaLabel="Manage secrets"
          />
        )}
        {canManageNotifications && (
          <NavItem
            label="Notifications"
            glyph={<Webhook size={15} aria-hidden="true" />}
            active={notificationsActive}
            onClick={selectNotifications}
            ariaLabel="Manage external notifications"
          />
        )}
      </div>

      {/* ── Channels + Direct sections ───────────────────────────── */}
      <ul
        class="flex-1 overflow-y-auto"
        style="padding:12px 0 8px;list-style:none;margin:0;-webkit-overflow-scrolling:touch;overscroll-behavior:none;touch-action:manipulation"
      >
        <li class="flex items-center justify-between" style="padding:0 12px 6px">
          <button
            type="button"
            onClick={selectChannelsBrowse}
            aria-label="Browse all channels"
            class="eyebrow"
            style={`margin:0;background:transparent;border:0;padding:0;cursor:pointer;letter-spacing:.16em;text-transform:uppercase;color:${browseActive ? 'var(--ink)' : 'var(--muted)'}`}
          >
            Channels
          </button>
          <button
            type="button"
            onClick={selectChannelCreate}
            aria-label="Create a channel"
            title="Create a channel"
            class="flex items-center justify-center"
            style="background:transparent;border:none;color:var(--muted);line-height:1;cursor:pointer;padding:2px 4px;border-radius:var(--r-xs)"
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </li>
        {!channelsLoaded && (
          <li class="eyebrow" style="padding:4px 12px;font-style:italic;color:var(--muted)">
            loading…
          </li>
        )}
        {channelList.map((c) => (
          <li key={c.id}>
            <ChannelRow
              channel={c}
              active={isChannelActive(v, c)}
              viewer={viewer}
              lastRead={lastRead}
              msgMap={msgMap}
            />
          </li>
        ))}
        {createActive && (
          <li class="eyebrow" style="padding:4px 12px;color:var(--steel)" aria-hidden="true">
            + new channel
          </li>
        )}

        <li>
          <p class="eyebrow" style="padding:14px 12px 6px">
            Direct
          </p>
        </li>
        {teammates.map((t) => {
          const connected = onlineByName.get(t.name) ?? 0;
          const online = connected > 0;
          const activity = activityByName.get(t.name) ?? 'idle';
          const working = activity === 'working';
          const blocked = activity === 'blocked';
          const active = v.kind === 'thread' && v.key === dmThreadKey(t.name);
          const unread = unreadCount(dmThreadKey(t.name), viewer, lastRead, msgMap);
          // Activity label (working / needs input) takes precedence over
          // the connection label (online / offline) in the a11y text — a
          // working or blocked member is online by definition.
          const stateLabel = blocked
            ? 'needs input'
            : working
              ? 'working'
              : online
                ? 'online'
                : 'offline';
          return (
            <li key={t.name}>
              <button
                type="button"
                onClick={() => selectDmWith(t.name)}
                aria-label={
                  unread > 0
                    ? `Message ${t.name} (${stateLabel}, ${unread} unread)`
                    : `Message ${t.name} (${stateLabel})`
                }
                title={`${t.name} · ${stateLabel} · ${t.role.title}`}
                class={`navitem w-full${active ? ' active' : ''}`}
                style={`text-align:left;font-weight:${active ? 700 : 500}`}
              >
                <span class={`dot${online ? ' ok' : ' muted'}`} aria-hidden="true" />
                <span
                  class={`truncate flex-1${unread > 0 && !active ? ' font-semibold' : ''}`}
                  style={unread > 0 && !active ? 'font-weight:700' : ''}
                >
                  {t.name}
                </span>
                {working && (
                  // Working spinner — the agent is actively processing a
                  // turn (model generation and/or tool execution). Driven
                  // by `activity === 'working'` on the roster.
                  <span
                    class="spinner sm"
                    aria-label="working"
                    aria-hidden="false"
                    role="status"
                    style="flex-shrink:0"
                  />
                )}
                {blocked && (
                  // Blocked — the agent is stuck waiting on a human (needs
                  // input / an approval it can't self-resolve). This is the
                  // "an operator should look" state, so it gets a distinct
                  // amber attention badge, visually separate from both the
                  // working spinner and the plain idle dot.
                  <span
                    class="badge ember solid"
                    aria-label="needs input"
                    role="status"
                    style="flex-shrink:0;font-size:8.5px;padding:1px 5px;letter-spacing:.06em"
                  >
                    NEEDS INPUT
                  </span>
                )}
                {unread > 0 && !active && <UnreadBadge count={unread} />}
              </button>
            </li>
          );
        })}
      </ul>

      {embeddedShell.value ? <TeamSettingsButton /> : <AccountSettingsButton />}
    </nav>
  );
}

function TeamSettingsButton() {
  const handler = teamSettingsHandler.value;
  if (handler === null) return null;
  return (
    <div style="padding:10px 12px;border-top:1px solid var(--rule);flex-shrink:0">
      <button
        type="button"
        onClick={handler}
        aria-label="Team settings"
        class="navitem w-full"
        style="text-align:left"
      >
        <Settings size={16} aria-hidden="true" class="flex-shrink-0" />
        <span class="truncate flex-1">Team settings</span>
      </button>
    </div>
  );
}

function TeamHeader({ viewer }: { viewer: string }) {
  const team = currentTeam.value;
  if (!team) {
    return (
      <div style="padding:14px 14px 12px;border-bottom:1px solid var(--rule);min-height:58px" />
    );
  }
  return (
    <button
      type="button"
      onClick={selectOverview}
      aria-label={`${team.name} home`}
      class="w-full flex items-center gap-2"
      style="padding:12px 14px;border-bottom:1px solid var(--rule);background:transparent;border:none;border-bottom:1px solid var(--rule);text-align:left;cursor:pointer"
    >
      <BrandMark
        size={20}
        stroke="var(--steel)"
        strokeWidth={5}
        filledVertices={false}
        class="flex-shrink-0"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <div
          class="font-display truncate"
          style="font-size:14.5px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);line-height:1.1"
        >
          {team.name}
        </div>
        <div
          class="truncate"
          style="font-family:var(--f-sans);font-size:11px;color:var(--muted);line-height:1.2;margin-top:2px"
        >
          {viewer}
        </div>
      </div>
    </button>
  );
}

/**
 * Standalone-mode footer (OSS, no host-provided rail). Visually
 * parallels the embedded `TeamSettingsButton`: a gear-iconed
 * "Account" button that opens the account settings modal, with a
 * quick-action sign-out icon next to it. The avatar+name presence
 * we used to render here was a duplicate identity anchor relative to
 * the Header's profile button (which has since been retired); the
 * gear keeps a single affordance in a single spot.
 */
function AccountSettingsButton() {
  const showSignOut = hasSignOutHandler.value !== null;
  return (
    <div
      class="flex items-center gap-2"
      style="padding:10px 12px;border-top:1px solid var(--rule);flex-shrink:0"
    >
      <button
        type="button"
        onClick={selectAccount}
        aria-label="Account settings"
        class="navitem flex-1"
        style="text-align:left"
      >
        <Settings size={16} aria-hidden="true" class="flex-shrink-0" />
        <span class="truncate flex-1">Account</span>
      </button>
      {showSignOut && (
        <button
          type="button"
          onClick={() => {
            handleSignOut();
          }}
          aria-label="Sign out"
          title="Sign out"
          class="flex-shrink-0 flex items-center justify-center"
          style="width:28px;height:28px;background:transparent;border:none;color:var(--muted);cursor:pointer;border-radius:6px"
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** Pill-shape unread counter. Caps at "99+". */
function UnreadBadge({ count }: { count: number }) {
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      class="badge solid"
      style="font-size:9.5px;padding:2px 6px;min-width:20px;justify-content:center"
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

function NavItem({
  label,
  glyph,
  active,
  onClick,
  ariaLabel,
  trailing,
  disabled,
}: {
  label: string;
  glyph?: ComponentChildren;
  active: boolean;
  onClick: () => void;
  ariaLabel?: string;
  trailing?: ComponentChildren;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      aria-disabled={disabled ? 'true' : undefined}
      title={label}
      class={`navitem w-full${active ? ' active' : ''}${disabled ? ' is-disabled' : ''}`}
      style={`text-align:left${disabled ? ';color:var(--muted);cursor:default' : ''}`}
      tabIndex={disabled ? -1 : 0}
    >
      {glyph !== undefined && (
        <span
          aria-hidden="true"
          class="flex items-center justify-center flex-shrink-0"
          style={`color:${active ? 'var(--ink)' : 'var(--muted)'};width:18px;height:18px`}
        >
          {glyph}
        </span>
      )}
      <span class="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function isChannelActive(v: ReturnType<typeof view.peek>, c: ChannelSummary): boolean {
  if (v.kind !== 'thread') return false;
  if (c.id === GENERAL_CHANNEL_ID) return v.key === GENERAL_THREAD;
  return v.key === channelThreadKey(c.id);
}

function ChannelRow({
  channel,
  active,
  viewer,
  lastRead,
  msgMap,
}: {
  channel: ChannelSummary;
  active: boolean;
  viewer: string;
  lastRead: Map<string, number>;
  msgMap: Map<string, import('csuite-sdk/types').Message[]>;
}) {
  const threadKey =
    channel.id === GENERAL_CHANNEL_ID ? GENERAL_THREAD : channelThreadKey(channel.id);
  const unread = unreadCount(threadKey, viewer, lastRead, msgMap);
  return (
    <button
      type="button"
      onClick={() => selectChannel(channel.slug)}
      aria-label={unread > 0 ? `Open #${channel.slug} (${unread} unread)` : `Open #${channel.slug}`}
      title={`#${channel.slug}`}
      class={`navitem w-full${active ? ' active' : ''}`}
      style={`text-align:left;font-weight:${active ? 700 : 500}`}
    >
      <span
        aria-hidden="true"
        class="flex items-center justify-center flex-shrink-0"
        style="color:var(--muted);width:18px;height:18px"
      >
        <Hash size={14} />
      </span>
      <span
        class={`truncate flex-1${unread > 0 && !active ? ' font-semibold' : ''}`}
        style={unread > 0 && !active ? 'font-weight:700' : ''}
      >
        {channel.slug}
      </span>
      {unread > 0 && !active && <UnreadBadge count={unread} />}
    </button>
  );
}
