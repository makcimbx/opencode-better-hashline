import { describe, expect, test } from "bun:test";
import { extractReleaseNotes, syncReleaseNotes } from "../scripts/sync-release-notes.js";

const introduction = `# Changelog

All notable changes are documented here.
`;

describe("release notes", () => {
  test("promotes curated Unreleased sections into the generated release", () => {
    const source = `${introduction}
## [1.2.0](compare-link) (2026-07-21)

### Added

* generated summary

## [1.1.0] - 2026-07-20

### Fixed

- previous fix

## [Unreleased]

### Added

- detailed feature

### Changed

- detailed behavior change

### Fixed

- detailed fix
`;

    const result = syncReleaseNotes(source);

    expect(result.notes).toBe(`## [1.2.0](compare-link) (2026-07-21)

### Added

- detailed feature

### Changed

- detailed behavior change

### Fixed

- detailed fix
`);
    expect(result.changelog).toBe(`${introduction}
## [Unreleased]

### Added

### Changed

### Fixed

## [1.2.0](compare-link) (2026-07-21)

### Added

- detailed feature

### Changed

- detailed behavior change

### Fixed

- detailed fix

## [1.1.0] - 2026-07-20

### Fixed

- previous fix
`);
  });

  test("keeps generated notes when Unreleased only has placeholders", () => {
    const source = `${introduction}
## [Unreleased]

### Added

### Changed

### Fixed

## [1.2.1] (2026-07-21)

### Fixed

* generated fix
`;

    const result = syncReleaseNotes(source);

    expect(result.notes).toContain("* generated fix");
    expect(result.changelog.match(/\* generated fix/g)).toHaveLength(1);
  });

  test("extracts one exact version for a GitHub release", () => {
    const source = `${introduction}
## [Unreleased]

### Added

## [1.2.1] (2026-07-21)

### Fixed

- shipped fix

## [1.2.0] (2026-07-20)

### Added

- old feature
`;

    expect(extractReleaseNotes(source, "1.2.1")).toBe(`## [1.2.1] (2026-07-21)

### Fixed

- shipped fix
`);
  });
});
