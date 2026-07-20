/**
 * ChannelCreate — "name your channel" form.
 *
 * The slug input doubles as the display name. We deliberately don't
 * carry a separate description field — Slack-style descriptions
 * decay (nobody updates them) and our agents read the slug as
 * context anyway. Instead the hint under the name nudges good
 * naming up front: "make it self-descriptive."
 *
 * Slug normalization happens client-side (lowercase, swap spaces for
 * dashes, strip junk) so a user can type "Customer Research" and the
 * field auto-shapes into `customer-research`. The server still
 * validates per `validateSlug` — bad input lands as a friendly
 * inline error.
 */

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { createChannel } from '../lib/channels.js';
import { selectChannel } from '../lib/view.js';

const slugInput = signal('');
const submitError = signal<string | null>(null);
const submitting = signal(false);

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function ChannelCreate() {
  // Reset state on mount so the form is clean each visit.
  useEffect(() => {
    slugInput.value = '';
    submitError.value = null;
    submitting.value = false;
  }, []);

  const onInput = (e: JSX.TargetedInputEvent<HTMLInputElement>) => {
    slugInput.value = normalizeSlug(e.currentTarget.value);
  };

  const onSubmit = async (e: JSX.TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    const slug = slugInput.value;
    if (slug.length === 0) {
      submitError.value = 'name is required';
      return;
    }
    submitting.value = true;
    submitError.value = null;
    try {
      const created = await createChannel(slug);
      slugInput.value = '';
      selectChannel(created.slug);
    } catch (err) {
      submitError.value = err instanceof Error ? err.message : 'failed to create channel';
    } finally {
      submitting.value = false;
    }
  };

  return (
    <div class="flex-1 overflow-y-auto" style="padding:32px">
      <form
        onSubmit={onSubmit}
        class="max-w-xl mx-auto"
        style="display:flex;flex-direction:column;gap:18px"
      >
        <header>
          <h1
            class="font-display"
            style="font-size:22px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);margin:0"
          >
            Create a channel
          </h1>
          <p style="font-family:var(--f-sans);font-size:13.5px;color:var(--muted);margin:6px 0 0;line-height:1.5">
            Channels are how your team — including its agents — collaborate around a shared focus.
          </p>
        </header>

        <label class="flex flex-col" style="gap:6px">
          <span class="eyebrow" style="color:var(--graphite)">
            Name
          </span>
          <div
            class="flex items-center"
            style="border:1px solid var(--rule-strong);border-radius:var(--r-sm);background:var(--ice);padding:8px 12px;gap:6px"
          >
            <span
              aria-hidden="true"
              style="color:var(--muted);font-family:var(--f-mono);font-size:14px"
            >
              #
            </span>
            <input
              type="text"
              value={slugInput.value}
              onInput={onInput}
              placeholder="customer-research"
              maxLength={32}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
              required
              style="flex:1;background:transparent;border:0;outline:0;color:var(--ink);font-family:var(--f-mono);font-size:14px;min-width:0"
              aria-describedby="channel-slug-hint"
            />
          </div>
          <span
            id="channel-slug-hint"
            style="font-family:var(--f-sans);font-size:12px;color:var(--muted);line-height:1.4"
          >
            Make it self-descriptive — agents on this team use the channel name to understand its
            context. Lowercase letters, digits, and dashes only.
          </span>
        </label>

        {submitError.value !== null && (
          <div
            role="alert"
            style="font-family:var(--f-sans);font-size:13px;color:var(--err);background:rgba(211,47,47,0.08);border:1px solid var(--err);border-radius:var(--r-sm);padding:10px 12px"
          >
            {submitError.value}
          </div>
        )}

        <div class="flex items-center" style="gap:10px">
          <button
            type="submit"
            disabled={submitting.value || slugInput.value.length === 0}
            class="btn btn-primary"
          >
            {submitting.value ? 'Creating…' : 'Create channel'}
          </button>
          <button type="button" onClick={() => history.back()} class="btn btn-ghost">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** Test helper. */
export function __resetChannelCreateForTests(): void {
  slugInput.value = '';
  submitError.value = null;
  submitting.value = false;
}
