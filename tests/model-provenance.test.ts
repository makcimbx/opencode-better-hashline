import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  assertEffectiveToolIdentitiesUnchanged,
  assertPackageManifestsEqual,
  comparePackageManifests,
  deriveEffectiveToolIdentities,
  deriveInstalledPackageManifest,
  deriveNpmTarballManifest,
  type EffectiveToolIdentityOptions,
  type ProvenanceCommandRunner,
  packageTreeSha256,
} from "../benchmarks/model/provenance.js";

type TarFixtureEntry = {
  path: string;
  body?: string;
  type?: number;
  linkName?: string;
};

const TAR_BLOCK_SIZE = 512;

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`Fixture tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeTarString(header, offset, length, encoded);
}

function tarArchive(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "", "utf8");
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    writeTarString(header, 0, 100, entry.path);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type ?? 0x30;
    writeTarString(header, 157, 100, entry.linkName ?? "");
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body);
    const padding = (TAR_BLOCK_SIZE - (body.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

function refreshTarChecksum(archive: Buffer, offset = 0): void {
  archive.fill(0x20, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = offset; index < offset + TAR_BLOCK_SIZE; index += 1) {
    checksum += archive[index] ?? 0;
  }
  writeTarString(archive, offset + 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
}

function npmTgz(entries: readonly TarFixtureEntry[]): Buffer {
  return gzipSync(tarArchive(entries));
}

describe("package provenance", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "better-hashline-provenance-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("matches exact tarball and installed package manifests", async () => {
    const expected = deriveNpmTarballManifest(
      npmTgz([
        { path: "package/nested/b.txt", body: "bravo\n" },
        { path: "package/a.txt", body: "alpha\n" },
      ]),
    );
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "a.txt"), "alpha\n");
    await writeFile(join(root, "nested", "b.txt"), "bravo\n");

    const actual = await deriveInstalledPackageManifest(root);
    expect(actual).toEqual(expected);
    expect(comparePackageManifests(expected, actual)).toEqual({
      matches: true,
      missing: [],
      extra: [],
      changed: [],
    });
    expect(() => assertPackageManifestsEqual(expected, actual)).not.toThrow();
    expect(packageTreeSha256([...actual].reverse())).toBe(packageTreeSha256(expected));
  });

  test("accepts a plain package reached through a canonicalized ancestor", async () => {
    const actualParent = join(root, "actual-parent");
    const actualRoot = join(actualParent, "package");
    const aliasParent = join(root, "alias-parent");
    const aliasRoot = join(aliasParent, "package");
    await mkdir(actualRoot, { recursive: true });
    await writeFile(join(actualRoot, "a.txt"), "alpha\n");
    await symlink(actualParent, aliasParent, "junction");

    expect(await deriveInstalledPackageManifest(aliasRoot)).toEqual(
      deriveNpmTarballManifest(npmTgz([{ path: "package/a.txt", body: "alpha\n" }])),
    );
  });

  test("attests installed package metadata in bounded Windows batches", async () => {
    if (process.platform !== "win32") return;
    const packageRoot = join(root, "batched-package");
    await mkdir(packageRoot);
    const entries = Array.from({ length: 65 }, (_, index) => ({
      path: `package/file-${index}.txt`,
      body: `${index}\n`,
    }));
    await Promise.all(
      entries.map((entry, index) => writeFile(join(packageRoot, `file-${index}.txt`), entry.body)),
    );

    expect(await deriveInstalledPackageManifest(packageRoot)).toEqual(
      deriveNpmTarballManifest(npmTgz(entries)),
    );
  });

  test("reports missing, extra, and content-changed files exactly", async () => {
    const expected = deriveNpmTarballManifest(
      npmTgz([
        { path: "package/a.txt", body: "one" },
        { path: "package/nested/b.txt", body: "two" },
      ]),
    );
    await writeFile(join(root, "a.txt"), "ONE");
    await writeFile(join(root, "extra.txt"), "extra");

    const actual = await deriveInstalledPackageManifest(root);
    const comparison = comparePackageManifests(expected, actual);
    expect(comparison.matches).toBe(false);
    expect(comparison.missing).toEqual(["nested/b.txt"]);
    expect(comparison.extra).toEqual(["extra.txt"]);
    expect(comparison.changed.map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(comparison.changed[0]?.expected.size).toBe(3);
    expect(comparison.changed[0]?.actual.size).toBe(3);
    expect(() => assertPackageManifestsEqual(expected, actual)).toThrow(
      "Installed package does not match npm tarball",
    );
  });

  test("rejects installed symbolic links without traversing them", async () => {
    const external = await mkdtemp(join(tmpdir(), "better-hashline-provenance-external-"));
    try {
      await writeFile(join(external, "secret.txt"), "secret\n");
      await symlink(external, join(root, "linked"), "junction");
      await expect(deriveInstalledPackageManifest(root)).rejects.toThrow(
        "Installed package contains a symbolic link",
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("rejects installed hardlinks", async () => {
    const external = join(root, "external.txt");
    await writeFile(external, "shared");
    await link(external, join(root, "linked.txt"));
    await expect(deriveInstalledPackageManifest(root)).rejects.toThrow("plain regular file");
  });

  test("rejects traversal, duplicates, links, and special tar entries", () => {
    expect(() =>
      deriveNpmTarballManifest(npmTgz([{ path: "package/../escape", body: "no" }])),
    ).toThrow("Unsafe package path");
    expect(() =>
      deriveNpmTarballManifest(
        npmTgz([
          { path: "package/same.txt", body: "first" },
          { path: "package/same.txt", body: "second" },
        ]),
      ),
    ).toThrow("Duplicate npm tar entry");
    expect(() =>
      deriveNpmTarballManifest(
        npmTgz([{ path: "package/link", type: 0x32, linkName: "../../secret" }]),
      ),
    ).toThrow("Npm tar entry is not a regular file");
    expect(() =>
      deriveNpmTarballManifest(npmTgz([{ path: "package/device", type: 0x33 }])),
    ).toThrow("Npm tar entry is not a regular file");
    expect(() =>
      deriveNpmTarballManifest(
        npmTgz([{ path: "package/linked", body: "data", linkName: "target" }]),
      ),
    ).toThrow("Regular npm tar entry has a link target");
  });

  test("rejects malformed gzip, tar framing, fields, and padding", () => {
    expect(() => deriveNpmTarballManifest(new Uint8Array())).toThrow("compressed byte bounds");
    expect(() => deriveNpmTarballManifest(Buffer.from("not-gzip"))).toThrow("gzip stream");
    expect(() => deriveNpmTarballManifest(gzipSync("x"))).toThrow("Invalid tar length");
    expect(() => deriveNpmTarballManifest(npmTgz([{ path: "outside.txt", body: "no" }]))).toThrow(
      "outside package",
    );

    const missingTerminator = tarArchive([{ path: "package/a.txt", body: "a" }]).subarray(
      0,
      TAR_BLOCK_SIZE * 2,
    );
    expect(() => deriveNpmTarballManifest(gzipSync(missingTerminator))).toThrow(
      "missing its zero terminator",
    );

    const malformedTerminator = tarArchive([]);
    malformedTerminator[TAR_BLOCK_SIZE] = 1;
    expect(() => deriveNpmTarballManifest(gzipSync(malformedTerminator))).toThrow(
      "canonical zero terminator",
    );

    const invalidUtf8 = tarArchive([{ path: "package/a.txt", body: "a" }]);
    invalidUtf8[0] = 0xff;
    refreshTarChecksum(invalidUtf8);
    expect(() => deriveNpmTarballManifest(gzipSync(invalidUtf8))).toThrow("not valid UTF-8");

    const malformedName = tarArchive([{ path: "package/a.txt", body: "a" }]);
    malformedName["package/a.txt".length + 1] = 0x78;
    refreshTarChecksum(malformedName);
    expect(() => deriveNpmTarballManifest(gzipSync(malformedName))).toThrow(
      "Malformed tar name field",
    );

    const invalidOctal = tarArchive([{ path: "package/a.txt", body: "a" }]);
    invalidOctal[124] = 0x39;
    refreshTarChecksum(invalidOctal);
    expect(() => deriveNpmTarballManifest(gzipSync(invalidOctal))).toThrow(
      "Unsupported tar size encoding",
    );

    const nonzeroPadding = tarArchive([{ path: "package/a.txt", body: "a" }]);
    nonzeroPadding[TAR_BLOCK_SIZE + 1] = 1;
    expect(() => deriveNpmTarballManifest(gzipSync(nonzeroPadding))).toThrow(
      "Non-zero tar padding",
    );

    const truncated = tarArchive([{ path: "package/a.txt", body: "a" }]).subarray(
      0,
      TAR_BLOCK_SIZE,
    );
    writeTarOctal(truncated, 124, 12, TAR_BLOCK_SIZE * 2);
    refreshTarChecksum(truncated);
    expect(() => deriveNpmTarballManifest(gzipSync(truncated))).toThrow("Truncated npm tar entry");
  });

  test("rejects malformed canonical package manifests", () => {
    expect(() => packageTreeSha256([null] as never)).toThrow("Invalid package manifest entry");
    expect(() =>
      packageTreeSha256([{ path: "a", size: 1, sha256: "a".repeat(64), extra: true }] as never),
    ).toThrow("Invalid package manifest entry fields");
    expect(() =>
      packageTreeSha256([{ path: "C:/escape", size: 1, sha256: "a".repeat(64) }]),
    ).toThrow("Unsafe package path");
    expect(() => packageTreeSha256([{ path: "a", size: -1, sha256: "a".repeat(64) }])).toThrow(
      "Invalid package manifest size",
    );
    expect(() => packageTreeSha256([{ path: "a", size: 1, sha256: "bad" }])).toThrow(
      "Invalid package manifest SHA256",
    );
    expect(() =>
      packageTreeSha256([
        { path: "a", size: 1, sha256: "a".repeat(64) },
        { path: "a", size: 1, sha256: "a".repeat(64) },
      ]),
    ).toThrow("Duplicate package manifest path");
  });

  test("binds pathnames to content despite checksum-preserving pathname swaps", () => {
    const originalTar = tarArchive([
      { path: "package/ab.txt", body: "A" },
      { path: "package/ba.txt", body: "B" },
    ]);
    const swappedTar = Buffer.from(originalTar);
    writeTarString(swappedTar, 0, 100, "package/ba.txt");
    writeTarString(swappedTar, TAR_BLOCK_SIZE * 2, 100, "package/ab.txt");

    const expected = deriveNpmTarballManifest(gzipSync(originalTar));
    const swapped = deriveNpmTarballManifest(gzipSync(swappedTar));
    const comparison = comparePackageManifests(expected, swapped);
    expect(comparison.missing).toEqual([]);
    expect(comparison.extra).toEqual([]);
    expect(comparison.changed.map((entry) => entry.path)).toEqual(["ab.txt", "ba.txt"]);
    expect(packageTreeSha256(swapped)).not.toBe(packageTreeSha256(expected));
  });
});

describe("effective tool provenance", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "better-hashline-tool-provenance-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("records exact effective identities and detects each tool mutation", async () => {
    const toolsDirectory = join(root, "tools");
    const npmPrefix = join(root, "npm-prefix");
    const npmPackage = join(npmPrefix, "node_modules", "npm");
    const npmBin = join(npmPackage, "bin");
    const initialNpmBin = join(toolsDirectory, "node_modules", "npm", "bin");
    const openCodePackage = join(root, "node_modules", "opencode-ai");
    const openCodeBin = join(openCodePackage, "bin");
    await mkdir(npmBin, { recursive: true });
    await mkdir(initialNpmBin, { recursive: true });
    await mkdir(openCodeBin, { recursive: true });

    const bunPath = join(toolsDirectory, "bun.bin");
    const npmWrapperPath = join(toolsDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
    const nodePath = join(toolsDirectory, process.platform === "win32" ? "node.exe" : "node");
    const npmCliPath = join(npmBin, "npm-cli.js");
    const npmPrefixScript = join(initialNpmBin, "npm-prefix.js");
    const initialNpmCli = join(initialNpmBin, "npm-cli.js");
    const openCodePath = join(
      openCodeBin,
      process.platform === "win32" ? "opencode.exe" : "opencode",
    );
    await writeFile(bunPath, "bun-binary-v1");
    await writeFile(npmWrapperPath, "npm-wrapper-v1");
    await writeFile(nodePath, "node-binary-v1");
    await writeFile(initialNpmCli, "initial-npm-cli");
    await writeFile(npmPrefixScript, "npm-prefix-script");
    await writeFile(npmCliPath, "effective-npm-cli-v1");
    await writeFile(
      join(npmPackage, "package.json"),
      JSON.stringify({ name: "npm", version: "11.18.0", bin: { npm: "bin/npm-cli.js" } }),
    );
    await writeFile(openCodePath, "opencode-binary-v1");
    await writeFile(
      join(openCodePackage, "package.json"),
      JSON.stringify({
        name: "opencode-ai",
        version: "1.18.3",
        bin: { opencode: `bin/${process.platform === "win32" ? "opencode.exe" : "opencode"}` },
      }),
    );

    const canonical = {
      bun: await realpath(bunPath),
      node: await realpath(nodePath),
      npmCli: await realpath(npmCliPath),
      npmPrefix: await realpath(npmPrefix),
      npmPrefixScript: await realpath(npmPrefixScript),
      npmWrapper: await realpath(npmWrapperPath),
      openCode: await realpath(openCodePath),
    };
    const run: ProvenanceCommandRunner = (command) => {
      const [executable, ...args] = command;
      if (executable === canonical.bun && args[0] === "--version") return "1.3.14\n";
      if (executable === canonical.bun && args[0] === "--revision") {
        return "1.3.14+fixture\n";
      }
      if (executable === canonical.node && args[0] === "-p") return `${canonical.node}\n`;
      if (executable === canonical.node && args[0] === "--version") return "v24.0.0\n";
      if (executable === canonical.node && args[0] === canonical.npmPrefixScript) {
        return `${canonical.npmPrefix}\n`;
      }
      if (
        executable === canonical.node &&
        args[0] === canonical.npmCli &&
        args[1] === "--version"
      ) {
        return "11.18.0\n";
      }
      if (executable === canonical.openCode && args[0] === "--version") return "1.18.3\n";
      throw new Error(`Unexpected fixture command: ${JSON.stringify(command)}`);
    };
    const options: EffectiveToolIdentityOptions = {
      cwd: root,
      run,
      bun: { executablePath: bunPath },
      npm: { discoveryWrapperPath: npmWrapperPath },
      opencode: { packageDirectory: openCodePackage },
    };

    const before = await deriveEffectiveToolIdentities(options);
    expect(before.bun).toMatchObject({ version: "1.3.14", revision: "1.3.14+fixture" });
    expect(before.npm.discoveryWrapper.path).toBe(npmWrapperPath);
    expect(before.npm.discoveryWrapper.realPath).toBe(canonical.npmWrapper);
    expect(before.npm.node).toMatchObject({ version: "v24.0.0" });
    expect(before.npm.cli).toMatchObject({
      path: canonical.npmCli,
      packageVersion: "11.18.0",
      observedVersion: "11.18.0",
    });
    expect(before.npm.effectiveCommand).toEqual([canonical.node, canonical.npmCli]);
    expect(before.npm.cli.packageTreeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(before.opencode).toMatchObject({
      packageVersion: "1.18.3",
      observedVersion: "1.18.3",
    });
    expect(() => assertEffectiveToolIdentitiesUnchanged(before, before)).not.toThrow();
    await expect(
      deriveEffectiveToolIdentities({
        ...options,
        run: (command, cwd) => (command[0] === canonical.openCode ? "1.18.4\n" : run(command, cwd)),
      }),
    ).rejects.toThrow("does not match package version");

    for (const mutation of [
      { path: bunPath, tool: "bun", bytes: "bun-binary-v2" },
      { path: npmCliPath, tool: "npm", bytes: "effective-npm-cli-v2" },
      { path: openCodePath, tool: "opencode", bytes: "opencode-binary-v2" },
    ]) {
      const original = await readFile(mutation.path);
      await writeFile(mutation.path, mutation.bytes);
      const after = await deriveEffectiveToolIdentities(options);
      expect(() => assertEffectiveToolIdentitiesUnchanged(before, after)).toThrow(mutation.tool);
      await writeFile(mutation.path, original);
    }
  });
});
