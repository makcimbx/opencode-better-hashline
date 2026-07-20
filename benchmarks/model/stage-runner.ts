import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface StagedRunner {
  bytes: Uint8Array;
  sha256: string;
}

export async function readApprovedRunner(
  path: string,
  expectedSha256: string,
): Promise<StagedRunner> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("Approved runner SHA-256 is invalid.");
  }
  const bytes = new Uint8Array(await readFile(path));
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error("Approved runner bytes do not match the external approval bundle.");
  }
  return { bytes, sha256: actualSha256 };
}

export async function buildRunnerBundle(sourceRoot: string): Promise<StagedRunner> {
  const result = await Bun.build({
    entrypoints: [join(sourceRoot, "benchmarks", "model", "run.ts")],
    format: "esm",
    minify: false,
    packages: "bundle",
    sourcemap: "none",
    splitting: false,
    target: "bun",
  });
  if (!result.success) {
    throw new Error(`Unable to build staged model runner: ${result.logs.join("\n")}`);
  }
  if (result.outputs.length !== 1 || result.outputs[0]?.kind !== "entry-point") {
    throw new Error("The staged model runner must be exactly one JavaScript entry-point.");
  }
  const output = result.outputs[0];
  if (!output) throw new Error("The staged model runner has no output.");
  const bytes = new Uint8Array(await output.arrayBuffer());
  const source = new TextDecoder().decode(bytes);
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
  const externalImports = new Bun.Transpiler({ loader: "js", target: "bun" })
    .scanImports(source)
    .map((item) => item.path)
    .filter(
      (specifier) =>
        !specifier.startsWith("node:") && !specifier.startsWith("bun:") && !builtins.has(specifier),
    );
  if (externalImports.length > 0) {
    throw new Error(
      `The staged runner has unbundled package imports: ${externalImports.join(", ")}`,
    );
  }
  return { bytes, sha256: sha256(bytes) };
}
