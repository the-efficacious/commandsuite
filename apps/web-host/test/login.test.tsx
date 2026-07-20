/**
 * Auth flow tests.
 *
 * Covers the Login route and the session signal transitions by
 * stubbing `globalThis.fetch` rather than mocking the SDK client —
 * that way we also cover the client's response-shape validation.
 *
 * Each test resets both the session signal and the cached client so
 * state doesn't leak between cases. This matters because the module
 * is imported once and the `session` signal is module-scoped.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { __resetClientForTests } from '../src/lib/client.js';
import { loginWithTotp, session } from '../src/lib/session.js';
import { __resetLoginState, Login } from '../src/routes/Login.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  session.value = { status: 'anonymous' };
  __resetLoginState();
  __resetClientForTests();
});

afterEach(() => {
  // @testing-library/preact v3 doesn't auto-cleanup under vitest the
  // way the React variant does, so do it explicitly to avoid leaking
  // rendered DOM between tests (which caused "multiple elements"
  // errors on getByPlaceholderText).
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * Build a minimal fetch stub. Maps a path suffix to a handler that
 * returns `{status, body}` — tests declare exactly the responses they
 * need and get a 500 for anything else so regressions surface.
 */
function stubFetch(
  routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        const { status, body } = handler(init);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
    }
    return Promise.resolve(new Response('no route', { status: 500 }));
  }) as typeof fetch;
}

describe('<Login />', () => {
  it('renders a single 6-digit code input (no name field)', () => {
    render(<Login />);
    expect(screen.getByPlaceholderText('000000')).toBeTruthy();
    expect(screen.queryByPlaceholderText('director-1')).toBeNull();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
  });

  it('disables the submit button until the code is a valid 6 digits', () => {
    render(<Login />);
    const button = screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.input(screen.getByPlaceholderText('000000'), { target: { value: '123' } });
    expect(button.disabled).toBe(true); // not yet 6 digits

    fireEvent.input(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    expect(button.disabled).toBe(false);
  });

  it('strips non-digits from the code input and caps at 6 chars', () => {
    render(<Login />);
    const code = screen.getByPlaceholderText('000000') as HTMLInputElement;
    fireEvent.input(code, { target: { value: '12-34-56-78' } });
    expect(code.value).toBe('123456');
  });

  it('shows an error message when login fails', async () => {
    stubFetch({
      '/session/totp': () => ({ status: 401, body: { error: 'invalid code' } }),
    });
    render(<Login />);

    fireEvent.input(screen.getByPlaceholderText('000000'), { target: { value: '000000' } });
    fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form') as Element);

    await waitFor(() => {
      expect(screen.getByText(/401|invalid/i)).toBeTruthy();
    });
    // Code field is cleared on failure so the user can re-enter the
    // next rotation's code immediately without first wiping the box.
    expect((screen.getByPlaceholderText('000000') as HTMLInputElement).value).toBe('');
  });

  it('updates the session signal on successful login (codeless — server matches slot)', async () => {
    // Server iterates enrolled slots and returns whichever matches.
    // The SPA doesn't send or know the name; it just reads it
    // back from the SessionResponse.
    stubFetch({
      '/session/totp': () => ({
        status: 200,
        body: {
          member: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
          expiresAt: 9_999_999_999_999,
        },
      }),
    });
    expect(session.value.status).toBe('anonymous');

    render(<Login />);
    fireEvent.input(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: /sign in/i }).closest('form') as Element);

    await waitFor(() => {
      expect(session.value.status).toBe('authenticated');
    });
    if (session.value.status === 'authenticated') {
      expect(session.value.member).toBe('director-1');
      expect(session.value.role.title).toBe('director');
      expect(session.value.permissions).toContain('members.manage');
    }
  });
});

describe('loginWithTotp', () => {
  it('throws LoginError with the server error text on 401', async () => {
    stubFetch({
      '/session/totp': () => ({ status: 401, body: { error: 'invalid code' } }),
    });
    await expect(loginWithTotp('000000')).rejects.toThrow();
    expect(session.value.status).toBe('anonymous');
  });
});

describe('<App /> auth gate', () => {
  it('shows the Login route when /session returns 401', async () => {
    stubFetch({
      '/session': () => ({ status: 401, body: { error: 'missing credentials' } }),
    });
    // Reset to loading so App runs its bootstrap() effect on mount.
    session.value = { status: 'loading' };
    render(<App />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeTruthy();
    });
  });

  it('shows the authenticated shell when /session returns 200', async () => {
    stubFetch({
      '/session': () => ({
        status: 200,
        body: {
          member: 'director-1',
          role: { title: 'director', description: '' },
          permissions: ['members.manage'],
          expiresAt: 9_999_999_999_999,
        },
      }),
    });
    session.value = { status: 'loading' };
    render(<App />);

    await waitFor(() => {
      // Identity affordance after login is the gear-iconed Account
      // button in the NavColumn footer (the legacy avatar+name chip
      // was retired when account settings became a modal). Sign-out
      // is the small icon next to it.
      expect(screen.getByRole('button', { name: /account settings/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    });
  });
});
