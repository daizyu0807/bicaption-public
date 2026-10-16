const JUNK = new Set(['undefined', 'null']);

/** Merge two comma-separated term lists, case-insensitively, dropping empties and stringified undefined/null. */
export function mergeCommaSeparatedTerms(current: string | undefined, incoming: string | undefined) {
  const merged = new Map<string, string>();
  for (const term of `${current ?? ''},${incoming ?? ''}`.split(',')) {
    const normalized = term.trim();
    if (!normalized || JUNK.has(normalized.toLowerCase())) {
      continue;
    }
    merged.set(normalized.toLowerCase(), normalized);
  }
  return Array.from(merged.values()).join(', ');
}
