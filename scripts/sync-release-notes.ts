interface ChangelogSection {
  name: string;
  start: number;
  headingEnd: number;
  end: number;
}

function changelogSections(source: string): ChangelogSection[] {
  const matches = [...source.matchAll(/^## \[([^\]]+)](?:[^\r\n]*)(?:\r?\n|$)/gm)];
  return matches.map((match, index) => ({
    name: match[1] ?? "",
    start: match.index,
    headingEnd: match.index + match[0].length,
    end: matches[index + 1]?.index ?? source.length,
  }));
}

function sectionBody(source: string, section: ChangelogSection): string {
  return source.slice(section.headingEnd, section.end).trim();
}

function hasEntries(body: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() !== "" && !/^#{3,}\s/.test(line));
}

function renderedNotes(source: string, section: ChangelogSection, body: string): string {
  const heading = source.slice(section.start, section.headingEnd).trimEnd();
  return `${heading}\n\n${body}\n`;
}

export function syncReleaseNotes(source: string): { changelog: string; notes: string } {
  const sections = changelogSections(source);
  const unreleased = sections.find((section) => section.name === "Unreleased");
  const release = sections.find((section) => section.name !== "Unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  if (!release) throw new Error("CHANGELOG.md has no generated release section");

  const unreleasedBody = sectionBody(source, unreleased);
  const releaseBody = sectionBody(source, release);
  const body = hasEntries(unreleasedBody) ? unreleasedBody : releaseBody;
  if (!body) throw new Error(`Release ${release.name} has no notes`);

  const firstSectionStart = Math.min(unreleased.start, release.start);
  if (sections.some((section) => section.start < release.start && section.name !== "Unreleased")) {
    throw new Error(`Release ${release.name} is not the newest changelog version`);
  }

  const historyStart = release.end;
  let history = source.slice(historyStart);
  if (unreleased.start >= historyStart) {
    const relativeStart = unreleased.start - historyStart;
    const relativeEnd = unreleased.end - historyStart;
    history = history.slice(0, relativeStart) + history.slice(relativeEnd);
  }

  const notes = renderedNotes(source, release, body);
  const template = "## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n";
  const prefix = source.slice(0, firstSectionStart).trimEnd();
  const changelog = `${prefix}\n\n${template}\n${notes}\n${history.trimStart()}`;
  return { changelog: `${changelog.trimEnd()}\n`, notes };
}

export function extractReleaseNotes(source: string, version: string): string {
  const section = changelogSections(source).find((candidate) => candidate.name === version);
  if (!section) throw new Error(`CHANGELOG.md has no release ${version}`);
  const body = sectionBody(source, section);
  if (!body) throw new Error(`Release ${version} has no notes`);
  return renderedNotes(source, section, body);
}
