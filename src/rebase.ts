import { fail } from "./errors.js";

function findSubsequences(
  haystack: readonly string[],
  needle: readonly string[],
  budget: SearchBudget,
  limit = 2,
): number[] {
  if (needle.length === 0) return [];
  const prefix = new Array<number>(needle.length).fill(0);
  for (let index = 1, matched = 0; index < needle.length; ) {
    budget.consume();
    if (needle[index] === needle[matched]) {
      matched += 1;
      prefix[index] = matched;
      index += 1;
    } else if (matched > 0) {
      matched = prefix[matched - 1] ?? 0;
    } else {
      index += 1;
    }
  }

  const matches: number[] = [];
  for (let index = 0, matched = 0; index < haystack.length; ) {
    budget.consume();
    if (haystack[index] === needle[matched]) {
      index += 1;
      matched += 1;
      if (matched === needle.length) {
        matches.push(index - matched);
        if (matches.length >= limit) return matches;
        matched = prefix[matched - 1] ?? 0;
      }
    } else if (matched > 0) {
      matched = prefix[matched - 1] ?? 0;
    } else {
      index += 1;
    }
  }
  return matches;
}

type ComparableLine = { text: string; eol?: string };

type SearchBudget = {
  consume(): void;
};

function createSearchBudget(maxComparisons: number): SearchBudget {
  let remaining = maxComparisons;
  return {
    consume() {
      remaining -= 1;
      if (remaining < 0) {
        fail(
          "UNSUPPORTED_FILE",
          "Unique relocation exceeded its safety budget. Reread the file and retry in strict mode.",
        );
      }
    },
  };
}

function lineTokens(lines: readonly ComparableLine[]): string[] {
  return lines.map((line) => JSON.stringify([line.text, line.eol ?? ""]));
}

export interface MappedRange {
  /** Zero-based inclusive indexes in the current document. */
  start: number;
  end: number;
}

export interface UniqueMapper {
  mapRange(startLine: number, endLine: number, maxContextLines: number): MappedRange;
  mapBoundary(position: number, maxContextLines: number): number;
}

function mapRange(
  base: readonly string[],
  current: readonly string[],
  startLine: number,
  endLine: number,
  maxContextLines: number,
  budget: SearchBudget,
): MappedRange {
  const start = startLine - 1;
  const end = endLine - 1;
  const target = base.slice(start, end + 1);
  if (findSubsequences(current, target, budget, 1).length === 0) {
    fail("TARGET_CHANGED", `Lines ${startLine}-${endLine} are no longer unchanged.`);
  }

  for (let total = 0; total <= maxContextLines * 2; total += 1) {
    for (let left = 0; left <= total; left += 1) {
      const right = total - left;
      if (left > maxContextLines || right > maxContextLines) continue;
      const contextStart = start - left;
      const contextEnd = end + right;
      if (contextStart < 0 || contextEnd >= base.length) continue;
      const signature = base.slice(contextStart, contextEnd + 1);
      const baseMatches = findSubsequences(base, signature, budget);
      if (baseMatches.length !== 1 || baseMatches[0] !== contextStart) continue;
      const currentMatches = findSubsequences(current, signature, budget);
      if (currentMatches.length !== 1) continue;
      const mappedStart = (currentMatches[0] ?? 0) + left;
      return { start: mappedStart, end: mappedStart + target.length - 1 };
    }
  }

  fail("AMBIGUOUS_RELOCATION", `Lines ${startLine}-${endLine} cannot be uniquely relocated.`);
}

function mapBoundary(
  base: readonly string[],
  current: readonly string[],
  position: number,
  maxContextLines: number,
  budget: SearchBudget,
): number {
  if (position < 0 || position > base.length) {
    fail("INVALID_ARGUMENT", `Boundary ${position} is outside the base snapshot.`);
  }

  if (base.length === 0) {
    if (current.length === 0) return 0;
    fail("BOUNDARY_CHANGED", "The empty-file insertion boundary changed.");
  }
  if (position === 0) {
    const signature = base.slice(0, maxContextLines + 1);
    const baseMatches = findSubsequences(base, signature, budget);
    const currentMatches = findSubsequences(current, signature, budget);
    if (baseMatches.length === 1 && currentMatches.length === 1) {
      if (currentMatches[0] === 0) return 0;
      fail("BOUNDARY_CHANGED", "The beginning-of-file boundary changed.");
    }
    fail("AMBIGUOUS_RELOCATION", "The beginning-of-file boundary is ambiguous.");
  }
  if (position === base.length) {
    const signatureStart = Math.max(0, base.length - maxContextLines - 1);
    const signature = base.slice(signatureStart);
    const baseMatches = findSubsequences(base, signature, budget);
    const currentMatches = findSubsequences(current, signature, budget);
    if (baseMatches.length === 1 && currentMatches.length === 1) {
      const currentStart = currentMatches[0] ?? 0;
      if (currentStart + signature.length === current.length) return current.length;
      fail("BOUNDARY_CHANGED", "The end-of-file boundary changed.");
    }
    fail("AMBIGUOUS_RELOCATION", "The end-of-file boundary is ambiguous.");
  }

  const maximumLeft = Math.min(position, maxContextLines + 1);
  const maximumRight = Math.min(base.length - position, maxContextLines + 1);
  for (let total = 2; total <= maximumLeft + maximumRight; total += 1) {
    for (let left = 1; left <= maximumLeft; left += 1) {
      const right = total - left;
      if (right < 1 || right > maximumRight) continue;
      const signatureStart = position - left;
      const signature = base.slice(signatureStart, position + right);
      const baseMatches = findSubsequences(base, signature, budget);
      if (baseMatches.length !== 1 || baseMatches[0] !== signatureStart) continue;
      const currentMatches = findSubsequences(current, signature, budget);
      if (currentMatches.length !== 1) continue;
      return (currentMatches[0] ?? 0) + left;
    }
  }

  const boundaryPair = base.slice(position - 1, position + 1);
  if (findSubsequences(current, boundaryPair, budget, 1).length === 0) {
    fail("BOUNDARY_CHANGED", "The insertion boundary is no longer adjacent.");
  }
  fail("AMBIGUOUS_RELOCATION", "The insertion boundary is not unique.");
}

export function createUniqueMapper(
  baseLines: readonly ComparableLine[],
  currentLines: readonly ComparableLine[],
  maxComparisons = 50_000_000,
): UniqueMapper {
  const base = lineTokens(baseLines);
  const current = lineTokens(currentLines);
  const budget = createSearchBudget(maxComparisons);
  return {
    mapRange(startLine, endLine, maxContextLines) {
      return mapRange(base, current, startLine, endLine, maxContextLines, budget);
    },
    mapBoundary(position, maxContextLines) {
      return mapBoundary(base, current, position, maxContextLines, budget);
    },
  };
}

export function mapRangeUniquely(
  baseLines: readonly ComparableLine[],
  currentLines: readonly ComparableLine[],
  startLine: number,
  endLine: number,
  maxContextLines: number,
): MappedRange {
  return createUniqueMapper(baseLines, currentLines).mapRange(startLine, endLine, maxContextLines);
}

export function mapBoundaryUniquely(
  baseLines: readonly ComparableLine[],
  currentLines: readonly ComparableLine[],
  position: number,
  maxContextLines: number,
): number {
  return createUniqueMapper(baseLines, currentLines).mapBoundary(position, maxContextLines);
}
