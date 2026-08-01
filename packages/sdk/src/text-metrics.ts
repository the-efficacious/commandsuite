/**
 * A deliberately simple estimate for authored prompt text.
 *
 * Characters are Unicode code points, not UTF-16 code units. Tokens are
 * estimated as ceil(characters / 4), a common English-prose rule of thumb.
 * It is not a tokenizer and callers must label the value as an estimate.
 */
export interface TextMetrics {
  characters: number;
  estimatedTokens: number;
}

export function measureText(text: string): TextMetrics {
  const characters = Array.from(text).length;
  return { characters, estimatedTokens: Math.ceil(characters / 4) };
}

export function formatTextMetrics(text: string): string {
  const { characters, estimatedTokens } = measureText(text);
  return `${characters} characters · ≈${estimatedTokens} estimated tokens (characters ÷ 4)`;
}
