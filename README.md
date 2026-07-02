# tool-schema-lint

**A reliability linter for the JSON tool/function schemas you hand an LLM.**

Your agent's tool-calling is only as reliable as the tool definitions behind it. When a description is vague, the model **picks the wrong tool**. When a parameter has no `description` or no `type`, the model **fills the argument wrong**. And when a `required` array names a property that doesn't actually exist in the schema, every call the model makes is **malformed before it leaves the model** — a real bug that's easy to ship and hard to spot by eye.

`tool-schema-lint` reads your tool schemas (Anthropic *or* OpenAI format) and flags those pitfalls before they cost you a bad run.

```bash
npx github:Penloom-Studio/tool-schema-lint your-tools.json
```

No install, no dependencies, nothing leaves your machine.

## Supported formats (auto-detected)

- **Anthropic** — an array of `{ name, description, input_schema }`.
- **OpenAI** — an array of `{ type:"function", function:{ name, description, parameters } }`, or an object with a top-level `tools: [...]` array.
- A **single tool object** of either style.

## What it checks

| Check | Severity | Why it matters |
|---|---|---|
| Tool has a non-trivial `description` (≥ ~20 chars) | ERROR / WARN | A missing or one-word description is the #1 cause of wrong-tool calls. |
| `required` lists only properties that actually exist | **ERROR** | A `required` entry with no matching property tells the model to send an argument the schema never defined — calls come out malformed. |
| Tool `name` is descriptive, not a bare verb (`run`, `do`, `get`) and ≤ 64 chars | WARN | The model selects by name; bare verbs can't be told apart from sibling tools. |
| Every parameter has its own `description` | WARN | Undocumented params get filled from the name alone — often wrongly. |
| Params have a declared `type` | WARN | Untyped params are under-specified; the model can't tell string from object. |
| `object` params declare `properties` or `additionalProperties:false` | WARN | An open object gives the model no idea what keys to send. |
| `array` params declare `items` | WARN | The model needs the element type to build the list. |
| Categorical strings (`status`, `mode`, `type`, `level`, …) have an `enum` | INFO *(heuristic)* | An enum stops the model inventing invalid values. A suggestion, not a hard rule. |
| Param names aren't cryptic (`x`, `q`, `tmp`) | INFO *(heuristic)* | Descriptive names are filled more reliably. |
| Booleans say what they toggle (not `flag`/`value`) | INFO *(heuristic)* | `dry_run` beats `flag`. |

It prints a 0–100 reliability score grouped by severity. Use `--json` for CI.

```bash
node index.mjs your-tools.json --json
```

**Honesty note:** checks marked *(heuristic)* are pattern-based suggestions and can be wrong for your domain — they're INFO, never errors, and never tank the score. The ERROR-tier checks are real, deterministic bugs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean — no errors and no warnings. |
| `1` | Issues found (warnings and/or errors). |
| `2` | File not found, invalid JSON, or usage error. |

## Example

Running it on a deliberately-broken schema:

```
tool-schema-lint  bad-tools.json
────────────────────────────────────────────────────────────
Tool-schema reliability score: 🔴 24/100
Tools analyzed: 2   Errors: 2  Warnings: 5  Suggestions: 5

 ERROR [do_thing] Tool has no `description`. With nothing to read, the model guesses when to call it — the #1 cause of wrong-tool calls.
 ERROR [run.user_id] `required` lists "user_id", but there is no property named "user_id". The model is told to send an argument that the schema doesn't define — calls will be malformed.
 WARN  [run] Tool name "run" is a bare verb — the model can't tell it apart from sibling tools.
 WARN  [run.options] Parameter "options" is type "object" with no `properties` and no `additionalProperties:false`.
 INFO  [run.status] Parameter "status" looks categorical but has no `enum` (heuristic).
```

A well-formed schema scores 100/100 with no findings. Try it on the included fixtures:

```bash
npx github:Penloom-Studio/tool-schema-lint examples/good-tools.json   # 🟢 100/100
npx github:Penloom-Studio/tool-schema-lint examples/bad-tools.json    # 🔴 surfaces every check
```

## CI usage

Fail the build when a tool schema regresses:

```yaml
# .github/workflows/tools.yml
name: lint-tool-schemas
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx github:Penloom-Studio/tool-schema-lint tools/agent-tools.json
```

Or as a pre-commit guard:

```bash
npx github:Penloom-Studio/tool-schema-lint tools/agent-tools.json || {
  echo "Fix the tool-schema issues above before committing."; exit 1;
}
```

## Going further

This linter catches *where* a tool schema will trip up the model. If you want the fixes:

- **The Tool-Calling Reliability Pack ($2.99)** — the exact fixes for what this linter flags: a 60-second schema scorecard, the mechanism in plain English (why the model picks the wrong tool and fills args wrong), five real before→after schema rewrites, and drop-in templates you can paste today (Claude tool use, OpenAI function-calling, any framework): **[get it →](https://buy.stripe.com/8x2aEWfVwgqG7PB7qD3F608)**
- **The Agent Builder's Toolkit ($19)** — going deeper: 23 reliability-focused system prompts, the tool-design patterns this linter operationalizes, an eval rubric for grading agent runs, and 10 starter agents: **[get it →](https://buy.stripe.com/aFa3cu9x8deub1N9yL3F601)**

Built by [Penloom Studio](https://penloomstudio.com). MIT licensed — fork it, ship it, send a PR.
