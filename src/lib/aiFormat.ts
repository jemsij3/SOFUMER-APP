/**
 * Client-side defensive AI text/list helpers & session conversation storage.
 * Ensures non-string, null, undefined, or malformed payloads never crash UI rendering
 * (e.g., never calling `.trim()` on non-strings or rendering objects in React).
 */

export function safeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const cleaned = value.trim();
    return cleaned || fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => safeText(item, ''))
      .filter(Boolean);
    return parts.join('\n') || fallback;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    for (const key of ['answer', 'reply', 'comparison', 'insights', 'rationale', 'text', 'content', 'response', 'message']) {
      if (typeof rec[key] === 'string' && (rec[key] as string).trim()) {
        return (rec[key] as string).trim();
      }
    }
  }
  return fallback;
}

export function safeStringArray(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = safeText(item, '');
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function safeFaqList(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const q = safeText(rec.question, '');
      const a = safeText(rec.answer, '');
      if (q && a) out.push({ question: q, answer: a });
    }
  }
  return out;
}
