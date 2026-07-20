/**
 * Toast queue tests. Exercise the signal-backed queue in isolation —
 * the container component is a thin render over `toasts.value`, so
 * most behaviour (enqueue / dismiss / dedupe / bounded size) can be
 * verified without touching the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetToastsForTests,
  clearAllToasts,
  dismissToast,
  toast,
  toasts,
} from '../src/lib/toast.js';

describe('toast queue', () => {
  beforeEach(() => {
    __resetToastsForTests();
  });

  afterEach(() => {
    __resetToastsForTests();
  });

  it('enqueues a toast and returns its id', () => {
    const id = toast.info({ body: 'hello' });
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.id).toBe(id);
    expect(toasts.value[0]?.body).toBe('hello');
    expect(toasts.value[0]?.kind).toBe('info');
  });

  it('default duration is longer for warn/error than info/success', () => {
    toast.info({ body: 'i' });
    toast.success({ body: 's' });
    toast.warn({ body: 'w' });
    toast.error({ body: 'e' });
    const [i, s, w, e] = toasts.value;
    expect(i?.duration).toBe(5000);
    expect(s?.duration).toBe(5000);
    expect(w?.duration).toBe(7000);
    expect(e?.duration).toBe(7000);
  });

  it('respects an explicit duration override and sticky (null)', () => {
    toast.info({ body: 'custom', duration: 1234 });
    toast.info({ body: 'sticky', duration: null });
    const [custom, sticky] = toasts.value;
    expect(custom?.duration).toBe(1234);
    expect(sticky?.duration).toBeNull();
  });

  it('dismissToast removes by id and fires onDismiss', () => {
    const onDismiss = vi.fn();
    const id = toast.info({ body: 'x', onDismiss });
    dismissToast(id);
    expect(toasts.value).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('dismissToast is a no-op for an unknown id', () => {
    toast.info({ body: 'x' });
    dismissToast('not-a-real-id');
    expect(toasts.value).toHaveLength(1);
  });

  it('tag dedupes — a new toast with the same tag replaces the old one', () => {
    const replaced = vi.fn();
    toast.info({ body: 'first', tag: 'stream-status', onDismiss: replaced });
    const newId = toast.warn({ body: 'second', tag: 'stream-status' });
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.id).toBe(newId);
    expect(toasts.value[0]?.body).toBe('second');
    expect(replaced).toHaveBeenCalledOnce();
  });

  it('bounds the queue at MAX_TOASTS (5) — oldest drops', () => {
    for (let i = 0; i < 7; i++) toast.info({ body: `msg-${i}` });
    expect(toasts.value).toHaveLength(5);
    expect(toasts.value[0]?.body).toBe('msg-2');
    expect(toasts.value[4]?.body).toBe('msg-6');
  });

  it('clearAllToasts empties the queue and fires each onDismiss', () => {
    const a = vi.fn();
    const b = vi.fn();
    toast.info({ body: '1', onDismiss: a });
    toast.success({ body: '2', onDismiss: b });
    clearAllToasts();
    expect(toasts.value).toHaveLength(0);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('action is preserved on the enqueued toast', () => {
    const onClick = vi.fn();
    toast.error({ body: 'oops', action: { label: 'Retry', onClick } });
    expect(toasts.value[0]?.action?.label).toBe('Retry');
    expect(toasts.value[0]?.action?.onClick).toBe(onClick);
  });
});
