import { describe, expect, test } from "bun:test";
import {
  assertPilotAuthTransition,
  parsePilotAuth,
  pilotAuthIdentitySha256,
} from "../benchmarks/model/auth.js";

function auth(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      openai: {
        type: "oauth",
        access: "access-1",
        refresh: "refresh-1",
        expires: 2_000,
        accountId: "account-1",
      },
      openrouter: { type: "api", key: "router-1" },
      ...overrides,
    }),
  );
}

describe("pilot authentication", () => {
  test("accepts only the two required providers", () => {
    expect(parsePilotAuth(auth(), 1_000).openai.accountId).toBe("account-1");
    expect(() => parsePilotAuth(auth({ extra: { type: "api", key: "secret" } }), 1_000)).toThrow();
    expect(() =>
      parsePilotAuth(
        auth({
          openai: {
            type: "oauth",
            access: "access-1",
            refresh: "refresh-1",
            expires: 999,
            accountId: "account-1",
          },
        }),
        1_000,
      ),
    ).toThrow();
  });

  test("allows token rotation without provider identity changes", () => {
    const next = auth({
      openai: {
        type: "oauth",
        access: "access-2",
        refresh: "refresh-2",
        expires: 3_000,
        accountId: "account-1",
      },
    });
    expect(() => assertPilotAuthTransition(auth(), next, 1_000)).not.toThrow();
    expect(pilotAuthIdentitySha256(auth())).toBe(pilotAuthIdentitySha256(next));
    expect(() =>
      assertPilotAuthTransition(
        auth({
          openai: {
            type: "oauth",
            access: "expired-access",
            refresh: "refresh-1",
            expires: 999,
            accountId: "account-1",
          },
        }),
        next,
        1_000,
      ),
    ).not.toThrow();
    expect(() =>
      assertPilotAuthTransition(
        auth(),
        auth({
          openai: {
            type: "oauth",
            access: "access-2",
            refresh: "refresh-2",
            expires: 3_000,
            accountId: "account-2",
          },
        }),
        1_000,
      ),
    ).toThrow();
    expect(() =>
      assertPilotAuthTransition(
        auth(),
        auth({ openrouter: { type: "api", key: "router-2" } }),
        1_000,
      ),
    ).toThrow();
  });
});
