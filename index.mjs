#!/usr/bin/env node
// tool-schema-lint — a reliability linter for the JSON tool/function schemas you hand an LLM.
// Why this exists: an agent's tool-calling reliability is bounded by the QUALITY of its tool
// definitions. A thin description makes the model pick the wrong tool; a param with no description
// or no type makes it fill arguments wrong; a `required` entry that names a property that doesn't
// exist is a real bug that produces malformed calls. This linter reads your tool schemas (Anthropic
// or OpenAI style) and flags those pitfalls before they cost you a bad run.
//
// Zero dependencies. Usage:
//   npx tool-schema-lint <path-to-tools.json>      # Anthropic or OpenAI tool schema
//   node index.mjs tools.json --json               # machine-readable output
//
// Exit codes: 0 = clean, 1 = warnings/issues found, 2 = file not found / invalid JSON / usage error.
//
// MIT licensed. Built by Penloom Studio — https://penloomstudio.com
// Free field guide (reliability rules + paste-ready guardrails): https://penloomstudio.com/field-guide.html

import fs from "fs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find(a => !a.startsWith("--"));

if (!file) {
  console.error(`tool-schema-lint: no input file.\nUsage: npx tool-schema-lint <path-to-tools.json> [--json]`);
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`tool-schema-lint: file not found: ${file}\nUsage: npx tool-schema-lint <path-to-tools.json> [--json]`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error(`tool-schema-lint: ${file} is not valid JSON.\n  ${e.message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Normalize input. Support Anthropic style, OpenAI style, {tools:[...]}, and
// a single tool object. We extract a uniform shape: { name, description, schema }
// where `schema` is the JSON Schema describing the params (input_schema/parameters).
// ---------------------------------------------------------------------------
function normalizeTool(t) {
  if (!t || typeof t !== "object") return null;
  // OpenAI wrapper: { type:"function", function:{ name, description, parameters } }
  if (t.function && typeof t.function === "object") {
    const f = t.function;
    return { name: f.name, description: f.description, schema: f.parameters, _style: "openai" };
  }
  // OpenAI bare function object: { name, description, parameters }
  if ("parameters" in t && !("input_schema" in t)) {
    return { name: t.name, description: t.description, schema: t.parameters, _style: "openai" };
  }
  // Anthropic style: { name, description, input_schema }
  if ("input_schema" in t) {
    return { name: t.name, description: t.description, schema: t.input_schema, _style: "anthropic" };
  }
  // Last resort: a name + description object with neither schema key.
  if ("name" in t) {
    return { name: t.name, description: t.description, schema: undefined, _style: "unknown" };
  }
  return null;
}

function extractTools(root) {
  // { tools:[...] }
  if (root && typeof root === "object" && Array.isArray(root.tools)) return root.tools;
  // bare array
  if (Array.isArray(root)) return root;
  // single tool object
  if (root && typeof root === "object") return [root];
  return [];
}

const rawTools = extractTools(parsed);
const findings = []; // { severity:"error"|"warn"|"info", code, message, tool, param }

function add(severity, code, message, tool, param) {
  findings.push({ severity, code, message, tool: tool ?? null, param: param ?? null });
}

if (rawTools.length === 0) {
  add("error", "no-tools", "No tool definitions found. Expected an array of tools, an object with a `tools` array, or a single tool object.", null, null);
}

// ---------------------------------------------------------------------------
// Heuristic dictionaries (kept deliberately conservative — see README "honesty").
// ---------------------------------------------------------------------------
const VAGUE_NAMES = new Set([
  "run", "do", "get", "set", "go", "call", "exec", "execute", "handle",
  "process", "action", "fn", "func", "tool", "task", "use", "make", "fetch",
]);
// Param names that signal a closed set of values -> enum is usually the right call.
const ENUM_SIGNAL = /(^|_)(status|state|type|kind|mode|level|direction|order|sort|category|format|unit|currency|priority|severity|role|method|operation|action|frequency|interval|period|granularity|visibility|comparison|operator|timeframe|sentiment)($|_)/i;
// Cryptic / placeholder param names.
const CRYPTIC_NAMES = new Set([
  "x", "y", "z", "q", "a", "b", "c", "n", "i", "j", "k",
  "tmp", "temp", "val", "var", "arg", "args", "obj", "data", "foo", "bar", "baz", "p", "v",
]);
// Booleans that don't say what they toggle.
const AMBIGUOUS_BOOL = new Set([
  "flag", "value", "val", "bool", "b", "enabled", "enable", "toggle", "check", "option", "opt",
]);

const snakeCaseish = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

let toolCount = 0;
const perToolScores = [];

rawTools.forEach((raw, idx) => {
  const tool = normalizeTool(raw);
  if (!tool) {
    add("error", "malformed-tool", `Tool at index ${idx} is not a recognizable tool object (no name / parameters / input_schema).`, `#${idx}`, null);
    return;
  }
  toolCount++;
  const tname = tool.name || `#${idx}`;

  // --- 1. Tool name -------------------------------------------------------
  if (!tool.name || typeof tool.name !== "string" || !tool.name.trim()) {
    add("error", "tool-no-name", "Tool has no `name`. The model selects tools by name; an unnamed tool is uncallable.", tname, null);
  } else {
    const nm = tool.name.trim();
    if (nm.length > 64) {
      add("warn", "tool-name-long", `Tool name is ${nm.length} chars (> 64). Many runtimes cap tool names at 64; keep it short and descriptive.`, tname, null);
    }
    if (VAGUE_NAMES.has(nm.toLowerCase())) {
      add("warn", "tool-name-vague", `Tool name "${nm}" is a bare verb — the model can't tell it apart from sibling tools. Name it for what it does (e.g. "get_weather", "create_invoice").`, tname, null);
    } else if (!snakeCaseish.test(nm) && !/^[a-z][a-zA-Z0-9]*$/.test(nm)) {
      add("info", "tool-name-style", `Tool name "${nm}" isn't snake_case/camelCase. Consistent naming helps the model disambiguate (heuristic).`, tname, null);
    }
  }

  // --- 2. Tool description ------------------------------------------------
  const desc = typeof tool.description === "string" ? tool.description.trim() : "";
  if (!desc) {
    add("error", "tool-no-description", "Tool has no `description`. With nothing to read, the model guesses when to call it — the #1 cause of wrong-tool calls.", tname, null);
  } else if (desc.length < 20) {
    add("warn", "tool-description-thin", `Tool description is only ${desc.length} chars — too thin to disambiguate from sibling tools. Say what it does, when to use it, and when NOT to.`, tname, null);
  }

  // --- Schema / parameters -----------------------------------------------
  const schema = tool.schema;
  let toolDeductions = 0;
  const deduct = (n) => { toolDeductions += n; };

  // Account for tool-level findings already added for this tool.
  // (Scoring is computed globally below from the findings list, so we just
  //  validate the schema structure here and emit param-level findings.)

  if (schema === undefined || schema === null) {
    // No declared parameters. That's legal (some tools take none) — only flag
    // if the description clearly implies inputs. We stay quiet to avoid noise.
    perToolScores.push({ name: tname, deductions: toolDeductions });
    return;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    add("error", "schema-malformed", "Parameter schema (`input_schema`/`parameters`) is not a JSON Schema object.", tname, null);
    perToolScores.push({ name: tname, deductions: toolDeductions });
    return;
  }

  const props = (schema.properties && typeof schema.properties === "object") ? schema.properties : null;
  const required = Array.isArray(schema.required) ? schema.required : null;

  // schema.type should be "object" when there are properties.
  if (props && schema.type && schema.type !== "object") {
    add("warn", "schema-type-mismatch", `Top-level schema declares type "${schema.type}" but has \`properties\`. A params schema should be an "object".`, tname, null);
  }
  if (props && !schema.type) {
    add("info", "schema-no-type", "Top-level params schema has `properties` but no `type:\"object\"`. Some validators require it.", tname, null);
  }

  // --- 4. required references real properties (REAL BUG) ------------------
  if (required) {
    for (const r of required) {
      if (typeof r !== "string") {
        add("error", "required-not-string", `\`required\` contains a non-string entry (${JSON.stringify(r)}).`, tname, null);
        continue;
      }
      if (!props || !(r in props)) {
        add("error", "required-missing-prop", `\`required\` lists "${r}", but there is no property named "${r}". The model is told to send an argument that the schema doesn't define — calls will be malformed.`, tname, r);
      }
    }
  }
  if (props && Object.keys(props).length > 0 && !required) {
    add("info", "no-required", "Schema has parameters but no `required` array. If any param is mandatory, list it in `required` so the model knows it can't omit it.", tname, null);
  }

  // --- Per-property checks ------------------------------------------------
  if (props) {
    for (const [pname, pschemaRaw] of Object.entries(props)) {
      const pschema = (pschemaRaw && typeof pschemaRaw === "object") ? pschemaRaw : {};
      const ptype = pschema.type;
      const pdesc = typeof pschema.description === "string" ? pschema.description.trim() : "";

      // 3. every param has a description
      if (!pdesc) {
        add("warn", "param-no-description", `Parameter "${pname}" has no \`description\`. The model fills undocumented params from the name alone — often wrongly.`, tname, pname);
      }

      // 5. cryptic / single-letter names (heuristic)
      if (CRYPTIC_NAMES.has(pname.toLowerCase())) {
        add("info", "param-cryptic-name", `Parameter "${pname}" is single-letter/placeholder-style (heuristic). A descriptive name (e.g. "query", "limit") is filled more reliably.`, tname, pname);
      }

      // 7. untyped params, or object with no shape
      if (!ptype) {
        // enum alone is enough to constrain; const is too.
        if (!pschema.enum && pschema.const === undefined && !pschema.oneOf && !pschema.anyOf && !pschema.$ref) {
          add("warn", "param-untyped", `Parameter "${pname}" has no \`type\` (and no enum/const). Untyped params are under-specified — the model can't tell if it should send a string, number, or object.`, tname, pname);
        }
      } else if (ptype === "object") {
        const hasProps = pschema.properties && typeof pschema.properties === "object" && Object.keys(pschema.properties).length > 0;
        const closed = pschema.additionalProperties === false;
        if (!hasProps && !closed) {
          add("warn", "param-open-object", `Parameter "${pname}" is type "object" with no \`properties\` and no \`additionalProperties:false\`. The model can't tell what keys to put in it — define the shape or close it.`, tname, pname);
        }
      } else if (ptype === "array") {
        if (!pschema.items) {
          add("warn", "param-array-no-items", `Parameter "${pname}" is type "array" with no \`items\` schema. Declare the element type so the model knows what to put in the list.`, tname, pname);
        }
      }

      // 6. categorical string with no enum (HEURISTIC — suggestion only)
      if ((ptype === "string" || !ptype) && !pschema.enum && pschema.const === undefined) {
        const descSignals = /\b(one of|either|allowed values|must be|can be|options? (are|:)|choose from)\b/i.test(pdesc);
        if (ENUM_SIGNAL.test(pname) || descSignals) {
          add("info", "param-enum-suggested", `Parameter "${pname}" looks categorical (a fixed set of values) but has no \`enum\` (heuristic). Adding an enum stops the model inventing invalid values.`, tname, pname);
        }
      }

      // 8. ambiguous boolean (heuristic)
      if (ptype === "boolean" && AMBIGUOUS_BOOL.has(pname.toLowerCase())) {
        add("info", "param-bool-ambiguous", `Boolean "${pname}" doesn't say what it toggles (heuristic). Name it for the effect (e.g. "include_archived", "dry_run").`, tname, pname);
      }
    }
  }

  perToolScores.push({ name: tname, deductions: toolDeductions });
});

// ---------------------------------------------------------------------------
// Scoring. Start at 100, deduct per finding by severity, capped at 0.
// Deductions are tuned so a clean, well-documented set lands 95–100 and a file
// riddled with real bugs lands low — without any single heuristic able to tank
// a genuinely-good schema.
// ---------------------------------------------------------------------------
const DEDUCT = { error: 18, warn: 6, info: 2 };
let score = 100;
for (const f of findings) score -= (DEDUCT[f.severity] || 0);
score = Math.max(0, score);

const counts = {
  error: findings.filter(f => f.severity === "error").length,
  warn: findings.filter(f => f.severity === "warn").length,
  info: findings.filter(f => f.severity === "info").length,
};

// Exit code: 2 already handled (parse/usage). 0 if no errors AND no warnings; else 1.
const exitCode = (counts.error === 0 && counts.warn === 0) ? 0 : 1;

if (json) {
  console.log(JSON.stringify({
    file,
    tools: toolCount,
    score,
    counts,
    findings,
  }, null, 2));
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Human report.
// ---------------------------------------------------------------------------
const bar = score >= 85 ? "🟢" : score >= 60 ? "🟡" : "🔴";
const SEV_LABEL = { error: "ERROR", warn: "WARN ", info: "INFO " };
const SEV_ORDER = { error: 0, warn: 1, info: 2 };

console.log(`\ntool-schema-lint  ${file}`);
console.log("─".repeat(60));
console.log(`Tool-schema reliability score: ${bar} ${score}/100`);
console.log(`Tools analyzed: ${toolCount}   Errors: ${counts.error}  Warnings: ${counts.warn}  Suggestions: ${counts.info}\n`);

if (findings.length === 0) {
  console.log(" ✓ No issues found. These tool definitions give the model what it needs to call them reliably.\n");
} else {
  const sorted = [...findings].sort((a, b) => {
    const s = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    if (s !== 0) return s;
    return String(a.tool).localeCompare(String(b.tool));
  });
  for (const f of sorted) {
    const where = f.tool ? `[${f.tool}${f.param ? "." + f.param : ""}]` : "";
    console.log(` ${SEV_LABEL[f.severity]} ${where} ${f.message}`);
  }
  console.log("");
  console.log("Legend: ERROR = a real bug that breaks calls · WARN = under-specified, model will guess · INFO = heuristic suggestion.\n");
}

console.log("Why good tool schemas = reliable agents (free field guide): https://penloomstudio.com/field-guide.html");
console.log("23 reliability prompts + tool patterns + an eval rubric + 10 starter agents — The Agent Builder's Toolkit ($19): https://penloomstudio.com\n");

process.exit(exitCode);
