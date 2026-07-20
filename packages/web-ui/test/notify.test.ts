/**
 * notifyNewMessage gating tests — exercises the decision logic for
 * when an incoming live message surfaces a foreground toast.
 */

import type { Message } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetIdentityForTests, setIdentity } from '../src/lib/identity.js';
import { __resetMessagesForTests, dmThreadKey } from '../src/lib/messages.js';
import { __setVisibilityForTests, notifyNewMessage } from '../src/lib/notify.js';
import { __resetRouterForTests, navigate } from '../src/lib/router.js';
import { __resetToastsForTests, toasts } from '../src/lib/toast.js';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm1',
    ts: 1,
    to: null,
    from: 'build-bot',
    title: null,
    body: 'hello there',
    level: 'info',
    data: {},
    attachments: [],
    ...overrides,
  };
}

function useViewer(): void {
  setIdentity({
    member: 'director-1',
    role: { title: 'director', description: 'director role' },
    permissions: [],
  });
}

beforeEach(() => {
  __resetIdentityForTests();
  __resetMessagesForTests();
  __resetToastsForTests();
  __resetRouterForTests();
  __setVisibilityForTests(() => true);
});

afterEach(() => {
  __setVisibilityForTests(null);
});

describe('notifyNewMessage', () => {
  it('toasts a primary-thread message when viewer is elsewhere', () => {
    useViewer();
    // Default route after router reset is 'home' → view.kind = 'overview'.
    notifyNewMessage(msg({}));
    expect(toasts.value).toHaveLength(1);
    const t = toasts.value[0];
    expect(t?.title).toBe('build-bot · #team');
    expect(t?.body).toBe('hello there');
    expect(t?.tag).toBe('msg:primary');
    expect(t?.action?.label).toBe('View');
  });

  it('skips when the sender is the viewer', () => {
    useViewer();
    notifyNewMessage(msg({ from: 'director-1' }));
    expect(toasts.value).toHaveLength(0);
  });

  it('skips when identity is unset (shell not yet mounted)', () => {
    notifyNewMessage(msg({}));
    expect(toasts.value).toHaveLength(0);
  });

  it('skips when the tab is not visible — push handles that path', () => {
    useViewer();
    __setVisibilityForTests(() => false);
    notifyNewMessage(msg({}));
    expect(toasts.value).toHaveLength(0);
  });

  it('skips when the viewer is already reading the target thread', () => {
    useViewer();
    navigate({ kind: 'thread-channel', slug: 'general' });
    notifyNewMessage(msg({}));
    expect(toasts.value).toHaveLength(0);
  });

  it('toasts an inbound DM when viewer is on overview', () => {
    useViewer();
    notifyNewMessage(msg({ to: 'director-1', from: 'build-bot' }));
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.tag).toBe(`msg:${dmThreadKey('build-bot')}`);
    expect(toasts.value[0]?.title).toBe('build-bot · DM');
  });

  it('does not toast the inbound DM when viewing that DM thread', () => {
    useViewer();
    navigate({ kind: 'thread-dm', name: 'build-bot' });
    notifyNewMessage(msg({ to: 'director-1', from: 'build-bot' }));
    expect(toasts.value).toHaveLength(0);
  });

  it('collapses rapid-fire messages in the same thread via the tag', () => {
    useViewer();
    notifyNewMessage(msg({ id: 'a', body: 'first' }));
    notifyNewMessage(msg({ id: 'b', body: 'second' }));
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.body).toBe('second');
  });

  it('objective-thread message deep-links to the objective detail', () => {
    useViewer();
    notifyNewMessage(msg({ data: { thread: 'obj:123', kind: 'objective' } }));
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.tag).toBe('msg:obj:123');
    expect(toasts.value[0]?.title).toBe('build-bot · objective');
  });

  it('objective-thread message is suppressed when reading that objective', () => {
    useViewer();
    navigate({ kind: 'objective-detail', id: '123' });
    notifyNewMessage(msg({ data: { thread: 'obj:123', kind: 'objective' } }));
    expect(toasts.value).toHaveLength(0);
  });

  it('empty body falls back to "New activity" (tickle / payloadless push)', () => {
    useViewer();
    notifyNewMessage(msg({ body: '' }));
    expect(toasts.value[0]?.body).toBe('New activity');
  });

  it('truncates overly long bodies with an ellipsis', () => {
    useViewer();
    const long = 'x'.repeat(300);
    notifyNewMessage(msg({ body: long }));
    const body = toasts.value[0]?.body ?? '';
    expect(body.length).toBeLessThanOrEqual(140);
    expect(body.endsWith('…')).toBe(true);
  });
});
