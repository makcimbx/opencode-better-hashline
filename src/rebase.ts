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
    if (tokensEqual(needle[index], needle[matched], budget)) {
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
    if (tokensEqual(haystack[index], needle[matched], budget)) {
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
  consume(work: number): void;
};

function createSearchBudget(maxWork: number): SearchBudget {
  let remaining = maxWork;
  return {
    consume(work) {
      remaining -= work;
      if (remaining < 0) {
        fail(
          "UNSUPPORTED_FILE",
          "Unique relocation exceeded its safety budget. Reread the file and retry in strict mode.",
        );
      }
    },
  };
}

function tokensEqual(
  left: string | undefined,
  right: string | undefined,
  budget: SearchBudget,
): boolean {
  if (left === undefined || right === undefined || left.length !== right.length) {
    budget.consume(1);
    return left === right;
  }
  budget.consume(Math.max(left.length, 1));
  return left === right;
}

function matchesAt(
  haystack: readonly string[],
  needle: readonly string[],
  start: number,
  budget: SearchBudget,
): boolean {
  if (start < 0 || start + needle.length > haystack.length) return false;
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (!tokensEqual(haystack[start + offset], needle[offset], budget)) return false;
  }
  return true;
}

function lineTokens(lines: readonly ComparableLine[]): string[] {
  return lines.map((line) => JSON.stringify([line.text, line.eol ?? ""]));
}

function agree(candidate: number | undefined, next: number, message: string): number {
  if (candidate !== undefined && candidate !== next) {
    fail("AMBIGUOUS_RELOCATION", message);
  }
  return next;
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
  const baseTargetMatches = findSubsequences(base, target, budget);
  const targetMatches = findSubsequences(current, target, budget);
  if (targetMatches.length === 0) {
    fail("TARGET_CHANGED", `Lines ${startLine}-${endLine} are no longer unchanged.`);
  }
  if (
    baseTargetMatches.length === 1 &&
    baseTargetMatches[0] === start &&
    targetMatches.length === 1
  ) {
    const mappedStart = targetMatches[0] ?? 0;
    return { start: mappedStart, end: mappedStart + target.length - 1 };
  }

  let candidate: number | undefined;
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
      candidate = agree(
        candidate,
        mappedStart,
        `Lines ${startLine}-${endLine} have contradictory unique relocation evidence.`,
      );
    }
  }

  if (candidate !== undefined) {
    return { start: candidate, end: candidate + target.length - 1 };
  }
  fail("AMBIGUOUS_RELOCATION", `Lines ${startLine}-${endLine} cannot be uniquely relocated.`);
}

function mapEdgeBoundary(
  base: readonly string[],
  current: readonly string[],
  atStart: boolean,
  maxContextLines: number,
  budget: SearchBudget,
): number {
  const maximumLength = Math.min(base.length, maxContextLines + 1);
  let foundAtAnchor = false;
  for (let length = maximumLength; length >= 1; length -= 1) {
    const signature = atStart ? base.slice(0, length) : base.slice(base.length - length);
    const expected = atStart ? 0 : current.length - length;
    if (!matchesAt(current, signature, expected, budget)) continue;
    foundAtAnchor = true;
    const matches = findSubsequences(current, signature, budget);
    if (matches.length === 1 && matches[0] === expected) return atStart ? 0 : current.length;
  }
  if (!foundAtAnchor) {
    fail(
      "BOUNDARY_CHANGED",
      atStart ? "The beginning-of-file boundary changed." : "The end-of-file boundary changed.",
    );
  }
  fail(
    "AMBIGUOUS_RELOCATION",
    atStart
      ? "The beginning-of-file boundary is ambiguous."
      : "The end-of-file boundary is ambiguous.",
  );
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
    return mapEdgeBoundary(base, current, true, maxContextLines, budget);
  }
  if (position === base.length) {
    return mapEdgeBoundary(base, current, false, maxContextLines, budget);
  }

  const boundaryPair = base.slice(position - 1, position + 1);
  const basePairMatches = findSubsequences(base, boundaryPair, budget);
  const pairMatches = findSubsequences(current, boundaryPair, budget);
  if (pairMatches.length === 0) {
    fail("BOUNDARY_CHANGED", "The insertion boundary is no longer adjacent.");
  }
  if (
    basePairMatches.length === 1 &&
    basePairMatches[0] === position - 1 &&
    pairMatches.length === 1
  ) {
    return (pairMatches[0] ?? 0) + 1;
  }

  const maximumLeft = Math.min(position, maxContextLines + 1);
  const maximumRight = Math.min(base.length - position, maxContextLines + 1);
  let candidate: number | undefined;
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
      candidate = agree(
        candidate,
        (currentMatches[0] ?? 0) + left,
        `Boundary ${position} has contradictory unique relocation evidence.`,
      );
    }
  }

  if (candidate !== undefined) return candidate;
  fail("AMBIGUOUS_RELOCATION", "The insertion boundary is not unique.");
}

export function createUniqueMapper(
  baseLines: readonly ComparableLine[],
  currentLines: readonly ComparableLine[],
  maxWork = 50_000_000,
): UniqueMapper {
  const base = lineTokens(baseLines);
  const current = lineTokens(currentLines);
  const budget = createSearchBudget(maxWork);
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
