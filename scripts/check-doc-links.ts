import { access, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(absolute)));
    else if (entry.isFile() && extname(entry.name) === ".md") files.push(absolute);
  }
  return files;
}

const failures: string[] = [];
for (const file of await markdownFiles(root)) {
  const source = await Bun.file(file).text();
  const targets = [
    ...source.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g),
    ...source.matchAll(/<(?:a|img)\b[^>]*(?:href|src)="([^"]+)"/g),
  ];
  for (const match of targets) {
    const raw = match[1];
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0] ?? "");
    if (!target) continue;
    try {
      await access(resolve(dirname(file), target));
    } catch {
      failures.push(`${file.slice(root.length + 1)} -> ${raw}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Broken local documentation links:\n${failures.join("\n")}`);
}

console.log("Verified local documentation links.");
