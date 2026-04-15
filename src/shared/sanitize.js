/**
 * Sanitizes user text and caps approximate "tokens" by word count (≤ maxTokens).
 * Gemini tokenizer is subword-based; word cap is a practical proxy for the 30-token budget.
 */
export function sanitizeAndCapTokens(input, maxTokens = 30) {
  if (input == null) return "";
  let s = String(input).normalize("NFKC");
  s = s.replace(/[\u0000-\u001F\u007F]/g, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";

  const words = s.split(" ");
  if (words.length <= maxTokens) return words.join(" ");
  return words.slice(0, maxTokens).join(" ");
}
