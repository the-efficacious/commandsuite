/**
 * Login route — TOTP-only, codeless authentication for human users.
 *
 * One input (6-digit authenticator code) and a submit button. The
 * server iterates enrolled slots and logs the caller in as whichever
 * slot's current TOTP secret matches. No name input — the code
 * itself identifies the user. On success the session signal flips to
 * authenticated and the router renders the shell. On failure we show
 * the server's error text and clear the code input so the user can
 * re-enter on the next 30-second rotation.
 */

import { signal } from '@preact/signals';
import { AlertCircle, AlertTriangle, BrandMark, X } from 'csuite-web-ui';
import type { JSX } from 'preact';
import { LoginError, loginWithTotp, sessionNotice } from '../lib/session.js';

const code = signal('');
const error = signal<string | null>(null);
const submitting = signal(false);

async function handleSubmit(event: Event) {
  event.preventDefault();
  if (submitting.value) return;
  error.value = null;
  submitting.value = true;
  // Fail-safe: if the network hangs we don't want the submit button
  // stuck in the "Signing in…" state indefinitely.
  const timeout = window.setTimeout(() => {
    if (submitting.value) {
      submitting.value = false;
      error.value = 'login timed out — check your connection and try again';
    }
  }, 15000);
  try {
    await loginWithTotp(code.value.trim());
  } catch (err) {
    if (err instanceof LoginError) {
      error.value = err.message;
    } else {
      error.value = err instanceof Error ? err.message : 'unexpected error';
    }
    code.value = '';
  } finally {
    window.clearTimeout(timeout);
    submitting.value = false;
  }
}

function onCode(event: JSX.TargetedInputEvent<HTMLInputElement>) {
  // Strip non-digits and cap at 6 — TOTP codes are always 6 digits.
  const digits = event.currentTarget.value.replace(/\D/g, '').slice(0, 6);
  code.value = digits;
}

export function Login() {
  const canSubmit = !submitting.value && /^\d{6}$/.test(code.value);
  const notice = sessionNotice.value;
  return (
    <main class="min-h-screen flex items-center justify-center relative" style="padding:24px">
      {/* Subtle grid background — masked radial fade, doesn't interfere
          with the centered card. */}
      <div
        aria-hidden="true"
        class="absolute inset-0 pointer-events-none"
        style="background-image: linear-gradient(to right, rgba(14,28,43,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(14,28,43,0.06) 1px, transparent 1px); background-size: 64px 64px; mask-image: radial-gradient(ellipse at center, black 20%, transparent 65%);"
      />
      <form
        onSubmit={handleSubmit}
        class="card elev relative w-full max-w-sm"
        style="display:flex;flex-direction:column;gap:20px"
      >
        <div style="text-align:center">
          {/* Heptagon mark — matches the dashboard top-bar mark
              (uses `var(--ink)`: dark navy in light mode, warm cream
              in dusk). */}
          <BrandMark
            size={48}
            stroke="var(--ink)"
            strokeWidth={3}
            class="mx-auto"
            style="margin-bottom:14px"
          />
          <div
            class="font-display"
            style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--ink);line-height:1.05"
          >
            CommandSuite
          </div>
          <div style="font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin-top:8px">
            Enter your authenticator code
          </div>
        </div>

        {notice !== null && (
          <div role="status" class="callout warn">
            <div class="icon" aria-hidden="true">
              <AlertTriangle size={16} />
            </div>
            <div class="body">
              <div class="msg">{notice}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                sessionNotice.value = null;
              }}
              aria-label="Dismiss"
              class="close"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}

        <div class="field">
          <label class="field-label" for="totp-code">
            6-digit code
          </label>
          <input
            id="totp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code.value}
            onInput={onCode}
            placeholder="000000"
            // biome-ignore lint/a11y/noAutofocus: login is a single-field single-purpose page — users land here specifically to type a 6-digit code
            autoFocus
            class="input"
            style="text-align:center;font-family:var(--f-mono);font-size:26px;letter-spacing:0.3em;font-weight:600"
          />
        </div>

        {error.value && (
          <div role="alert" class="callout err">
            <div class="icon" aria-hidden="true">
              <AlertCircle size={16} />
            </div>
            <div class="body">
              <div class="msg">{error.value}</div>
            </div>
          </div>
        )}

        <button type="submit" disabled={!canSubmit} class="btn btn-primary btn-lg">
          {submitting.value ? 'Signing in…' : 'Sign in →'}
        </button>
      </form>
    </main>
  );
}

export function __resetLoginState(): void {
  code.value = '';
  error.value = null;
  submitting.value = false;
}
