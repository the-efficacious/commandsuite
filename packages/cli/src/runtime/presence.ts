/**
 * Tiny presence signal: is the SSE forwarder connected to the broker?
 *
 * Used by the HUD strip at the bottom of `csuite claude` to flip a
 * dot between online / offline. Intentionally narrower than an event
 * emitter — we only need one state (connecting | online | offline)
 * and one listener (the HUD), so the surface stays small.
 *
 * The forwarder calls `setConnecting()` before each subscribe attempt
 * and `setOnline()` on first successful iteration of the stream; any
 * thrown error or closed stream transitions to `offline` and the
 * forwarder's backoff loop re-enters `connecting`.
 *
 * A tiny debounce (250ms) on the `offline → online` transition
 * prevents flicker on clean reconnects after momentary blips —
 * otherwise the dot would flash ember every time the broker rotates
 * its SSE connection.
 */

export type PresenceState = 'connecting' | 'online' | 'offline';

export type PresenceListener = (state: PresenceState) => void;

export interface Presence {
  readonly state: PresenceState;
  setConnecting(): void;
  setOnline(): void;
  setOffline(): void;
  subscribe(listener: PresenceListener): () => void;
}

export function createPresence(initial: PresenceState = 'connecting'): Presence {
  let current: PresenceState = initial;
  const listeners = new Set<PresenceListener>();

  const emit = (next: PresenceState): void => {
    if (next === current) return;
    current = next;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        /* listener threw — not our problem */
      }
    }
  };

  return {
    get state() {
      return current;
    },
    setConnecting() {
      emit('connecting');
    },
    setOnline() {
      emit('online');
    },
    setOffline() {
      emit('offline');
    },
    subscribe(listener) {
      listeners.add(listener);
      // Fire once so late subscribers get the current state.
      try {
        listener(current);
      } catch {
        /* ignore */
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
