import { measureText } from 'csuite-sdk/text-metrics';

export function TextMetrics({ text }: { text: string }) {
  const metrics = measureText(text);
  return (
    <output
      style="font-family:var(--f-mono);font-size:11px;color:var(--muted);letter-spacing:.02em"
      aria-label={`${metrics.characters} characters, approximately ${metrics.estimatedTokens} estimated tokens`}
    >
      {metrics.characters} characters · ≈{metrics.estimatedTokens} estimated tokens (characters ÷ 4)
    </output>
  );
}
