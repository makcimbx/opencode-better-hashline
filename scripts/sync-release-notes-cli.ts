import { writeFile } from "node:fs/promises";
import { extractReleaseNotes, syncReleaseNotes } from "./sync-release-notes.js";

const usage =
  "Usage: sync-release-notes-cli.ts sync <changelog> <output> | extract <changelog> <version> <output>";
const [mode, changelogPath, value, outputPath] = process.argv.slice(2);
if (!mode || !changelogPath || !value) throw new Error(usage);

const source = await Bun.file(changelogPath).text();
if (mode === "sync") {
  const result = syncReleaseNotes(source);
  await writeFile(changelogPath, result.changelog, "utf8");
  await writeFile(value, result.notes, "utf8");
} else if (mode === "extract" && outputPath) {
  await writeFile(outputPath, extractReleaseNotes(source, value), "utf8");
} else {
  throw new Error(usage);
}
