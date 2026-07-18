export type ModelTask = {
  id: string;
  category: string;
  prompt: string;
  files: Record<string, string>;
  expectedFiles: Record<string, string>;
  absentFiles?: string[];
};

export const modelTasks: ModelTask[] = [
  {
    id: "single-constant",
    category: "mechanical",
    prompt: "In src/config.ts, change DEFAULT_RETRIES from 2 to 5. Make no other changes.",
    files: {
      "src/config.ts": "export const DEFAULT_RETRIES = 2;\nexport const TIMEOUT_MS = 5000;\n",
    },
    expectedFiles: {
      "src/config.ts": "export const DEFAULT_RETRIES = 5;\nexport const TIMEOUT_MS = 5000;\n",
    },
  },
  {
    id: "duplicate-block-target",
    category: "ambiguity",
    prompt:
      "In src/pricing.ts, change only calculateTax so its rate is 0.21. Leave calculateDiscount unchanged.",
    files: {
      "src/pricing.ts":
        "export function calculateTax(value: number) {\n  const rate = 0.1;\n  return value * rate;\n}\n\nexport function calculateDiscount(value: number) {\n  const rate = 0.1;\n  return value * rate;\n}\n",
    },
    expectedFiles: {
      "src/pricing.ts":
        "export function calculateTax(value: number) {\n  const rate = 0.21;\n  return value * rate;\n}\n\nexport function calculateDiscount(value: number) {\n  const rate = 0.1;\n  return value * rate;\n}\n",
    },
  },
  {
    id: "two-disjoint-edits",
    category: "batch",
    prompt:
      "In src/labels.ts, change the primary label to 'Continue' and the danger label to 'Remove'. Do not alter secondary.",
    files: {
      "src/labels.ts":
        'export const labels = {\n  primary: "Next",\n  secondary: "Back",\n  danger: "Delete",\n};\n',
    },
    expectedFiles: {
      "src/labels.ts":
        'export const labels = {\n  primary: "Continue",\n  secondary: "Back",\n  danger: "Remove",\n};\n',
    },
  },
  {
    id: "precise-insertion",
    category: "boundary",
    prompt:
      "In src/hooks.ts, add `await audit();` immediately after `await validate();` inside run, before save. Change nothing else.",
    files: {
      "src/hooks.ts":
        "export async function run() {\n  await validate();\n  await save();\n}\n\nasync function validate() {}\nasync function save() {}\nasync function audit() {}\n",
    },
    expectedFiles: {
      "src/hooks.ts":
        "export async function run() {\n  await validate();\n  await audit();\n  await save();\n}\n\nasync function validate() {}\nasync function save() {}\nasync function audit() {}\n",
    },
  },
  {
    id: "delete-debug-block",
    category: "range",
    prompt: "Remove only the three-line DEBUG logging block from src/worker.ts.",
    files: {
      "src/worker.ts":
        'export function work(value: string) {\n  // DEBUG start\n  console.log("input", value);\n  // DEBUG end\n  return value.trim();\n}\n',
    },
    expectedFiles: {
      "src/worker.ts": "export function work(value: string) {\n  return value.trim();\n}\n",
    },
  },
  {
    id: "preserve-crlf",
    category: "encoding",
    prompt:
      "In src/windows.ts, change `enabled = false` to `enabled = true`. Preserve the file's existing line endings and all other bytes.",
    files: {
      "src/windows.ts": 'export const name = "windows";\r\nexport const enabled = false;\r\n',
    },
    expectedFiles: {
      "src/windows.ts": 'export const name = "windows";\r\nexport const enabled = true;\r\n',
    },
  },
  {
    id: "preserve-mixed-eol",
    category: "encoding",
    prompt:
      "In src/mixed.txt, replace beta with BETA. Preserve every existing line delimiter and all other content exactly.",
    files: { "src/mixed.txt": "alpha\r\nbeta\ngamma\rdelta" },
    expectedFiles: { "src/mixed.txt": "alpha\r\nBETA\ngamma\rdelta" },
  },
  {
    id: "json-leaf",
    category: "structured",
    prompt:
      "In settings.json, set features.experimental to true without reformatting or changing any other value.",
    files: {
      "settings.json":
        '{\n  "name": "fixture",\n  "features": {\n    "stable": true,\n    "experimental": false\n  }\n}\n',
    },
    expectedFiles: {
      "settings.json":
        '{\n  "name": "fixture",\n  "features": {\n    "stable": true,\n    "experimental": true\n  }\n}\n',
    },
  },
  {
    id: "create-file",
    category: "creation",
    prompt:
      'Create src/version.ts containing exactly `export const version = "1.0.0";` followed by one newline. Do not change README.md.',
    files: { "README.md": "fixture\n" },
    expectedFiles: {
      "README.md": "fixture\n",
      "src/version.ts": 'export const version = "1.0.0";\n',
    },
  },
  {
    id: "whole-short-file",
    category: "whole-file",
    prompt:
      "Replace config.env with exactly two lines: `MODE=production` and `LOG_LEVEL=warn`, including a final newline.",
    files: { "config.env": "MODE=development\nLOG_LEVEL=debug\nLEGACY=true\n" },
    expectedFiles: { "config.env": "MODE=production\nLOG_LEVEL=warn\n" },
  },
  {
    id: "duplicate-boundary",
    category: "ambiguity",
    prompt:
      'In src/routes.ts, add `routes.push("/health");` after the admin route and before `return routes;`. Do not add it after the public route.',
    files: {
      "src/routes.ts":
        'export function publicRoutes() {\n  const routes = [];\n  routes.push("/public");\n  return routes;\n}\n\nexport function adminRoutes() {\n  const routes = [];\n  routes.push("/admin");\n  return routes;\n}\n',
    },
    expectedFiles: {
      "src/routes.ts":
        'export function publicRoutes() {\n  const routes = [];\n  routes.push("/public");\n  return routes;\n}\n\nexport function adminRoutes() {\n  const routes = [];\n  routes.push("/admin");\n  routes.push("/health");\n  return routes;\n}\n',
    },
  },
  {
    id: "paired-files",
    category: "multi-file",
    prompt:
      "Rename the exported color from blue to indigo in both src/theme.ts and src/theme.test.ts. Make no other changes.",
    files: {
      "src/theme.ts": 'export const color = "blue";\n',
      "src/theme.test.ts": 'import { color } from "./theme";\n\nexpect(color).toBe("blue");\n',
    },
    expectedFiles: {
      "src/theme.ts": 'export const color = "indigo";\n',
      "src/theme.test.ts": 'import { color } from "./theme";\n\nexpect(color).toBe("indigo");\n',
    },
  },
];
