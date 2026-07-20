/**
 * Loading — the centered "━━ Loading foo…" indicator used during panel
 * fetches. Replaces a half-dozen copies of the same inline markup.
 */

export interface LoadingProps {
  label?: string;
}

export function Loading({ label = 'Loading…' }: LoadingProps) {
  return (
    <div
      class="flex-1 flex items-center justify-center"
      style="color:var(--muted);font-family:var(--f-mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase"
    >
      ━━ {label}
    </div>
  );
}
