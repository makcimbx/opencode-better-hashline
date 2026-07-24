# Tool Contract Guidelines

This rubric applies to every model-visible tool contract in this repository: tool and
field descriptions, schemas, system guidance, success receipts, error messages, and
the normative protocol documentation.

## Authority

When surfaces disagree, resolve them in this order:

1. Runtime behavior in `src/filesystem.ts`, `src/render.ts`, and the other bounded
   protocol modules.
2. Model-visible schemas, descriptions, receipts, and system guidance in
   `src/plugin.ts`.
3. The normative contract in [`protocol.md`](protocol.md).
4. README and architecture overviews.
5. Tests and verification fixtures, which lock the intended contract but do not
   override runtime behavior.

Historical changelog entries and retained benchmark results are immutable evidence.
Correct their interpretation in current documentation rather than rewriting them.

## Description Rubric

Review each tool and each operating mode against all of these questions:

1. **What:** Does the first sentence state the tool's distinct job?
2. **When:** Does it identify the state or workflow in which the tool should be used?
3. **When not:** Does it reject the most likely competing tool or incompatible input
   shape?
4. **Arguments:** Are required fields, defaults, formats, relationships, dynamic
   bounds, and path resolution rules constructible without guessing?
5. **Result:** Does it explain the useful success output, snapshot consumption, and
   any optional or unavailable result?
6. **Limits:** Does it state destructive, nontransactional, authorization,
   pagination, and lifecycle constraints without overstating guarantees?
7. **Recovery:** Can the caller choose one safe next action after every expected
   failure class?
8. **Ordering:** Are irreversible and easy-to-confuse rules placed before detail?
9. **Consistency:** Do schema, system guidance, runtime messages, protocol docs, and
   tests describe the same behavior?
10. **Signal:** Is each rule owned by the narrowest useful surface instead of being
    repeated everywhere?

A contract passes only when a new contributor can construct the call and recover
safely without reading implementation code. Prefer precise, compact prose over
examples. Add examples only for complex or format-sensitive calls, and keep invalid
states out of the schema when provider-compatible validation can express them.

## Placement

- Put field types, defaults, local bounds, and field relationships in schema
  descriptions.
- Put tool selection, incompatible workflows, state prerequisites, and concurrency
  rules in tool or system descriptions.
- Put exact cross-operation semantics and edge cases in `protocol.md`.
- Put the next safe action in the runtime error that observes the failure.
- Keep stable error codes separate from explanatory recovery text.
- Do not call an operation atomic when any included lifecycle path can publish
  partially.
- Describe canonical authorization behavior rather than inferring it from relative
  or absolute path syntax.
- Present `hashline_write` as a strict `filePath`/`content` create-only call that automatically
  plans zero to 64 missing parents; never ask callers to opt into parent creation.
- Recover bounded transient read-only uncertainty inside the tool when a complete retry can still
  prove the same path, identity, bytes, permission plan, and publication result. Report successful
  exact stabilization as concise result information, not as an error that forces the model to retry.
- Never retry a target publication syscall, silently widen authorization, substitute a path, fuzzy
  match, or continue after provenance is lost. Those cases remain phase-correct failures.
- Keep recovery budgets small, delayed, abort-aware, and deterministic; exhaustion must retain a
  stable error code and the next safe action.
- For text readback, state that either window implies the request, explicit `false` conflicts with a
  window, and lifecycle operations reject `true` and all windows.
- For `replace_file`, distinguish non-empty newline-state inheritance from empty `lines`, which infer
  `finalNewline:false` and still reject explicit `true`.

## Recovery Matrix

| Observed phase | Required guidance |
| --- | --- |
| Validation or planning | State that no mutation occurred, identify one bounded field or constraint, and say whether the same snapshot remains usable. |
| Transient read-only observation | Retry a bounded complete proof inside the same call; if exact state settles, continue and optionally report material reuse without asking the model to repair anything. |
| Freshness failure before publication | State that this call published nothing; require a fresh read and replanning when coordinates or identity may have changed. |
| Ambiguous failure after publication started | State what may already exist or have changed; forbid blind retry; require inspection and a fresh read. |
| `PARTIAL_PUBLICATION` | Name every affected path class, require reconciliation to one intended state, then restart/reread when the native-alias epoch was invalidated. |
| Preview-only `N!|` line | Explain that pagination cannot issue that line; suggest a bounded configuration change or manual restructuring, never treating the preview as editable content. |
| Configuration or alias admission failure | Prohibit mutation bypass; require repair/restart and a newly delivered `hashline_read`. |

Never imply that an error means "nothing changed" unless the runtime knows publication
has not started. Never suggest an unchanged retry when the snapshot was consumed or
the same deterministic validation will fail again.

## Review And Tests

For every model-visible contract change:

1. Run the rubric across the unique hashline surface, every native-alias state, and
   migration mode.
2. Add deterministic tests for selection wording, argument repair, success output,
   and the error-to-next-call transition that changed.
3. Update `protocol.md`, the relevant overview, and `CHANGELOG.md`.
4. Record wire bytes and schema/fingerprint changes according to
   [`../CONTRIBUTING.md`](../CONTRIBUTING.md); require restart and a fresh delivered
   read after an identity change.
5. Keep retained benchmark JSON and closed pilot identities unchanged. New model
   evaluation requires a new versioned task identity and explicit cost approval.

High-value held-out recovery scenarios include existing-file routing, strict two-field creation with
automatic zero/multi-parent plans and verified concurrent-prefix reuse, inferred readback windows and
the explicit-false conflict, empty-file newline inference, immutable batch coordinates, forbidden-field
repair, complete-coverage lifecycle recovery, no-clobber move recovery, stale versus unique rebase,
alias binding, bounded observation exhaustion, queued-operation fencing after partial publication,
partial move reconciliation, and partial parent creation.

## Sources

This rubric adapts current public guidance from:

- [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic tool definition guidance](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
- [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Model Context Protocol tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
