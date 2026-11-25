import { preferredLineEnding } from '../core';
import type { TextChange } from '../core';
import { mapText } from '../formats';

export interface TextMatch {
  readonly from: number;
  readonly to: number;
}
export function findTextMatches(
  source: string,
  query: string,
  matchCase = false,
): readonly TextMatch[] {
  const needle = mapText(query).text;
  if (!needle) return [];
  const map = mapText(source),
    pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
  const matches: TextMatch[] = [];
  for (const match of map.text.matchAll(pattern)) {
    const from = map.boundaries[match.index],
      to = map.boundaries[match.index + match[0].length];
    if (from != null && to != null) matches.push(Object.freeze({ from, to }));
  }
  return Object.freeze(matches);
}
export function replacementChanges(
  source: string,
  matches: readonly TextMatch[],
  replacement: string,
): readonly TextChange[] {
  const insert = mapText(replacement).text.replace(/\n/g, preferredLineEnding(source));
  return matches.map((match) => ({ ...match, insert }));
}
