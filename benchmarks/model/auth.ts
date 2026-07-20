interface PilotAuth {
  openai: {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
  };
  openrouter: { type: "api"; key: string };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parsePilotAuthStructure(bytes: Uint8Array): PilotAuth {
  const root = record(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const openai = record(root?.openai);
  const openrouter = record(root?.openrouter);
  if (
    !root ||
    !exactKeys(root, ["openai", "openrouter"]) ||
    !openai ||
    !exactKeys(openai, ["access", "accountId", "expires", "refresh", "type"]) ||
    openai.type !== "oauth" ||
    typeof openai.access !== "string" ||
    openai.access.length === 0 ||
    typeof openai.refresh !== "string" ||
    openai.refresh.length === 0 ||
    typeof openai.accountId !== "string" ||
    openai.accountId.length === 0 ||
    typeof openai.expires !== "number" ||
    !Number.isFinite(openai.expires) ||
    !openrouter ||
    !exactKeys(openrouter, ["key", "type"]) ||
    openrouter.type !== "api" ||
    typeof openrouter.key !== "string" ||
    openrouter.key.length === 0
  ) {
    throw new Error(
      "Native-alias pilot authentication must contain only valid OpenAI OAuth and OpenRouter API credentials.",
    );
  }
  return {
    openai: {
      type: "oauth",
      access: openai.access,
      refresh: openai.refresh,
      expires: openai.expires,
      accountId: openai.accountId,
    },
    openrouter: { type: "api", key: openrouter.key },
  };
}

export function parsePilotAuth(bytes: Uint8Array, now = Date.now()): PilotAuth {
  const auth = parsePilotAuthStructure(bytes);
  if (auth.openai.expires <= now) {
    throw new Error("Native-alias pilot OpenAI OAuth credentials are expired.");
  }
  return auth;
}

export function pilotAuthIdentitySha256(bytes: Uint8Array): string {
  const auth = parsePilotAuthStructure(bytes);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return jsonSha256({
    openaiAccountIdSha256: digest(auth.openai.accountId),
    openrouterKeySha256: digest(auth.openrouter.key),
  });
}

export function assertPilotAuthTransition(
  previousBytes: Uint8Array,
  nextBytes: Uint8Array,
  now = Date.now(),
): void {
  const previous = parsePilotAuthStructure(previousBytes);
  const next = parsePilotAuth(nextBytes, now);
  if (
    next.openai.accountId !== previous.openai.accountId ||
    next.openrouter.key !== previous.openrouter.key
  ) {
    throw new Error("Pilot authentication identity changed during execution.");
  }
}

import { createHash } from "node:crypto";
import { jsonSha256 } from "../../src/presentation.js";
