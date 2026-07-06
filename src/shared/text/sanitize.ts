/**
 * Sanitizers for reasoning-model output. Gateways differ in how much
 * chain-of-thought leaks into `content`: some strip it, some leave inline
 * <think>/<thinking> blocks, some truncate mid-thought leaving an unclosed tag.
 */

const COMPLETE_THINK_BLOCK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const UNCLOSED_THINK_TAG = /<think(?:ing)?>[\s\S]*$/i;

/**
 * Remove reasoning blocks and surrounding whitespace from model text.
 * An unclosed opening tag means the reply was truncated mid-reasoning —
 * everything from the tag onward is reasoning, never answer.
 */
export function sanitizeModelText(text: string): string {
  return text.replace(COMPLETE_THINK_BLOCK, '').replace(UNCLOSED_THINK_TAG, '').trim();
}

const FENCED_BLOCK = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/;
const OPENING_FENCE_ONLY = /^```[^\n]*\n([\s\S]*)$/;

/**
 * Unwrap a reply that is a single markdown code fence (```json … ```).
 * A missing closing fence (truncation) drops just the opening line.
 * Text that is not fence-wrapped is returned unchanged.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCED_BLOCK.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  const unclosed = OPENING_FENCE_ONLY.exec(trimmed);
  if (unclosed?.[1] !== undefined) {
    return unclosed[1].trim();
  }
  return trimmed;
}
