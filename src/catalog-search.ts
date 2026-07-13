export type CatalogSearchFields = {
  titles: string[];
  aliases: string[];
  metadata: string[];
  lyrics: string[];
};

export type CatalogSearchFieldInput = {
  titles?: Array<string | null | undefined>;
  aliases?: Array<string | null | undefined>;
  metadata?: Array<string | null | undefined>;
  lyrics?: Array<string | null | undefined>;
};

export function normalizeCatalogSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeCatalogSearchText(value ?? "")).filter(Boolean))];
}

export function buildCatalogSearchFields(input: CatalogSearchFieldInput): CatalogSearchFields {
  return {
    titles: normalizedUnique(input.titles ?? []),
    aliases: normalizedUnique(input.aliases ?? []),
    metadata: normalizedUnique(input.metadata ?? []),
    lyrics: normalizedUnique(input.lyrics ?? []),
  };
}

type RomanKeys = {
  base: string;
  loose: string;
  optionalFinalA: string;
};

function romanAscii(token: string): string | null {
  const ascii = token.normalize("NFKD").replace(/\p{M}+/gu, "");
  return /^[a-z]+$/u.test(ascii) ? ascii : null;
}

function romanKeys(token: string): RomanKeys | null {
  const ascii = romanAscii(token);
  if (!ascii) return null;

  const base = ascii
    .replace(/chh/g, "ch")
    .replace(/sh/g, "s")
    .replace(/ph/g, "f")
    .replace(/q/g, "k")
    .replace(/w/g, "v")
    .replace(/a{2,}/g, "a")
    .replace(/(?:e{2,}|i{2,})/g, "i")
    .replace(/(?:o{2,}|u{2,})/g, "u")
    .replace(/([a-z])\1+/g, "$1");
  const loose = base
    .replace(/([kgcjtdpb])h/g, "$1")
    .replace(/f/g, "p")
    .replace(/oi/g, "ai")
    .replace(/ou/g, "au");
  const optionalFinalA = loose.length >= 4 && loose.endsWith("a") ? loose.slice(0, -1) : loose;
  return { base, loose, optionalFinalA };
}

function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distance = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) distance[row][0] = row;
  for (let column = 0; column < columns; column += 1) distance[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitutionCost,
      );
      if (
        row > 1
        && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        distance[row][column] = Math.min(distance[row][column], distance[row - 2][column - 2] + 1);
      }
    }
  }
  return distance[left.length][right.length];
}

function standardTypoDistance(length: number): number {
  if (length < 4) return 0;
  if (length < 8) return 1;
  return 2;
}

function maximumTypoDistance(length: number): number {
  if (length < 4) return 0;
  if (length < 7) return 1;
  if (length < 12) return 2;
  return 3;
}

function tokenSimilarity(queryToken: string, candidateToken: string): number {
  if (queryToken === candidateToken) return 1;
  if (queryToken.length >= 2 && candidateToken.startsWith(queryToken)) return 0.97;

  const queryKeys = romanKeys(queryToken);
  const candidateKeys = romanKeys(candidateToken);
  if (!queryKeys || !candidateKeys) return 0;
  if (queryKeys.base === candidateKeys.base && queryKeys.base.length >= 2) return 0.93;
  if (queryToken.length < 3) return 0;
  if (queryKeys.base.length >= 3 && candidateKeys.base.startsWith(queryKeys.base)) return 0.89;
  if (queryKeys.loose === candidateKeys.loose) return 0.85;
  if (queryKeys.optionalFinalA === candidateKeys.optionalFinalA) return 0.81;

  const longerLength = Math.max(queryKeys.base.length, candidateKeys.base.length);
  const standardDistance = standardTypoDistance(longerLength);
  const allowedDistance = maximumTypoDistance(longerLength);
  if (allowedDistance === 0) return 0;
  const distance = damerauLevenshtein(queryKeys.base, candidateKeys.base);
  if (distance > allowedDistance) return 0;
  const usesOuterTier = distance > standardDistance;
  if (
    usesOuterTier
    && (
      queryKeys.base[0] !== candidateKeys.base[0]
      || Math.abs(queryKeys.base.length - candidateKeys.base.length) > 1
    )
  ) return 0;
  const scoreFloor = usesOuterTier ? 0.62 : 0.72;
  return scoreFloor + (1 - distance / longerLength) * 0.08;
}

function tokenSpanSimilarity(
  queryTokens: string[],
  queryStart: number,
  queryLength: number,
  candidateTokens: string[],
  candidateStart: number,
  candidateLength: number,
): number {
  if (queryLength === 1 && candidateLength === 1) {
    return tokenSimilarity(queryTokens[queryStart], candidateTokens[candidateStart]);
  }
  if (queryLength !== 1 && candidateLength !== 1) return 0;
  const joinedQuery = queryTokens.slice(queryStart, queryStart + queryLength).join("");
  const joinedCandidate = candidateTokens.slice(candidateStart, candidateStart + candidateLength).join("");
  if (
    candidateLength > 1
    && joinedCandidate !== joinedQuery
    && joinedCandidate.startsWith(joinedQuery)
  ) {
    const withoutLastCandidate = candidateTokens
      .slice(candidateStart, candidateStart + candidateLength - 1)
      .join("");
    if (withoutLastCandidate.length >= joinedQuery.length) return 0;
  }
  return joinedTokenSimilarity(joinedQuery, joinedCandidate);
}

function tokenCoverageScore(query: string, candidate: string): number | null {
  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  if (
    queryTokens.length === 0
    || candidateTokens.length === 0
    || queryTokens.length > candidateTokens.length * 3
  ) return null;

  const memo = new Map<string, Map<number, number>>();
  const align = (queryIndex: number, candidateIndex: number): Map<number, number> => {
    if (queryIndex === queryTokens.length) return new Map([[0, 0]]);
    if (candidateIndex === candidateTokens.length) return new Map();
    const key = `${queryIndex}:${candidateIndex}`;
    const cached = memo.get(key);
    if (cached) return cached;

    const outcomes = new Map<number, number>();
    const keepBest = (consumedCandidates: number, similarityTotal: number) => {
      const current = outcomes.get(consumedCandidates);
      if (current === undefined || similarityTotal > current) {
        outcomes.set(consumedCandidates, similarityTotal);
      }
    };

    for (const [consumedCandidates, similarityTotal] of align(queryIndex, candidateIndex + 1)) {
      keepBest(consumedCandidates, similarityTotal);
    }

    const maximumQuerySpan = Math.min(3, queryTokens.length - queryIndex);
    const maximumCandidateSpan = Math.min(3, candidateTokens.length - candidateIndex);
    for (let querySpan = 1; querySpan <= maximumQuerySpan; querySpan += 1) {
      for (let candidateSpan = 1; candidateSpan <= maximumCandidateSpan; candidateSpan += 1) {
        const similarity = tokenSpanSimilarity(
          queryTokens,
          queryIndex,
          querySpan,
          candidateTokens,
          candidateIndex,
          candidateSpan,
        );
        if (similarity === 0) continue;
        const remaining = align(queryIndex + querySpan, candidateIndex + candidateSpan);
        for (const [consumedCandidates, similarityTotal] of remaining) {
          keepBest(
            consumedCandidates + candidateSpan,
            similarityTotal + similarity * querySpan,
          );
        }
      }
    }

    memo.set(key, outcomes);
    return outcomes;
  };

  let best: number | null = null;
  for (const [consumedCandidates, similarityTotal] of align(0, 0)) {
    const averageSimilarity = similarityTotal / queryTokens.length;
    const unmatchedCandidateCount = candidateTokens.length - consumedCandidates;
    const extraTokenPenalty = Math.min(30, unmatchedCandidateCount * 4);
    const score = averageSimilarity * 300 - extraTokenPenalty;
    if (best === null || score > best) best = score;
  }
  return best;
}

function joinedTokenSimilarity(query: string, candidate: string): number {
  if (query.length < 5 || candidate.length < 5) return 0;
  if (query === candidate) return 1;
  if (candidate.startsWith(query)) return 0.97;

  const queryKeys = romanKeys(query);
  const candidateKeys = romanKeys(candidate);
  if (!queryKeys || !candidateKeys) return 0;
  if (queryKeys.base === candidateKeys.base) return 0.93;
  if (queryKeys.base.length >= 5 && candidateKeys.base.startsWith(queryKeys.base)) return 0.89;
  if (queryKeys.loose === candidateKeys.loose) return 0.85;
  if (queryKeys.optionalFinalA === candidateKeys.optionalFinalA) return 0.81;
  return 0;
}

function joinedBoundaryScore(query: string, candidate: string): number | null {
  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = candidate.split(" ").filter(Boolean);
  if (queryTokens.length === 0 || queryTokens.length > 3 || candidateTokens.length === 0) return null;

  const queryJoined = queryTokens.join("");
  const minimumWindow = queryTokens.length === 1 ? 2 : 1;
  const maximumWindow = Math.min(3, candidateTokens.length);
  let best = 0;
  for (let windowSize = minimumWindow; windowSize <= maximumWindow; windowSize += 1) {
    for (let start = 0; start <= candidateTokens.length - windowSize; start += 1) {
      const candidateJoined = candidateTokens.slice(start, start + windowSize).join("");
      best = Math.max(best, joinedTokenSimilarity(queryJoined, candidateJoined));
    }
  }
  return best > 0 ? best : null;
}

function literalScore(text: string, query: string, exact: number, prefix: number, contains: number): number | null {
  if (text === query) return exact;
  if (text.startsWith(query)) return prefix;
  if (text.includes(query)) return contains;
  return null;
}

function bestScore(values: string[], score: (value: string) => number | null): number | null {
  let best: number | null = null;
  for (const value of values) {
    const current = score(value);
    if (current !== null && (best === null || current > best)) best = current;
  }
  return best;
}

export function scoreCatalogSearch(fields: CatalogSearchFields, rawQuery: string): number | null {
  const query = normalizeCatalogSearchText(rawQuery);
  if (!query) return 0;

  const scores: number[] = [];
  const titleLiteral = bestScore(fields.titles, (value) => literalScore(value, query, 1200, 1150, 1100));
  const aliasLiteral = bestScore(fields.aliases, (value) => literalScore(value, query, 1050, 1000, 950));
  const metadataLiteral = bestScore(fields.metadata, (value) => literalScore(value, query, 600, 580, 560));
  const lyricLiteral = bestScore(fields.lyrics, (value) => literalScore(value, query, 350, 330, 310));
  for (const score of [titleLiteral, aliasLiteral, metadataLiteral, lyricLiteral]) {
    if (score !== null) scores.push(score);
  }

  const titleToken = bestScore(fields.titles, (value) => {
    const coverage = tokenCoverageScore(query, value);
    return coverage === null ? null : 600 + coverage;
  });
  const aliasToken = bestScore(fields.aliases, (value) => {
    const coverage = tokenCoverageScore(query, value);
    return coverage === null ? null : 540 + coverage;
  });
  if (titleToken !== null) scores.push(titleToken);
  if (aliasToken !== null) scores.push(aliasToken);

  const titleJoined = bestScore(fields.titles, (value) => {
    const similarity = joinedBoundaryScore(query, value);
    return similarity === null ? null : 780 + similarity * 245;
  });
  const aliasJoined = bestScore(fields.aliases, (value) => {
    const similarity = joinedBoundaryScore(query, value);
    return similarity === null ? null : 680 + similarity * 245;
  });
  if (titleJoined !== null) scores.push(titleJoined);
  if (aliasJoined !== null) scores.push(aliasJoined);

  return scores.length > 0 ? Math.max(...scores) : null;
}
