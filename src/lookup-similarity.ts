import type { LookupItem } from "./catalog";

export function normalizeLookupCandidate(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function findSimilarLookupItems(
  value: string,
  items: LookupItem[],
  excludeId?: string,
): { exact: LookupItem | null; similar: LookupItem[] } {
  const candidate = normalizeLookupCandidate(value);
  if (!candidate) return { exact: null, similar: [] };

  let exact: LookupItem | null = null;
  const similar: LookupItem[] = [];
  for (const item of items) {
    if (item.id === excludeId) continue;
    const existing = normalizeLookupCandidate(item.name);
    if (existing === candidate) {
      exact = item;
      continue;
    }

    const longest = Math.max(candidate.length, existing.length);
    const distanceLimit = longest <= 5 ? 1 : longest <= 10 ? 2 : 3;
    const contains = Math.min(candidate.length, existing.length) >= 4
      && (candidate.includes(existing) || existing.includes(candidate));
    if (contains || editDistance(candidate, existing) <= distanceLimit) similar.push(item);
  }

  return { exact, similar: similar.slice(0, 5) };
}
