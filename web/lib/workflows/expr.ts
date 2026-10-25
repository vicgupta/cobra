// Expressions: ${{ path }} interpolation and simple conditions.
// Paths: inputs.<name>, steps.<id>.outputs.<key>, steps.<id>.status,
// result.<key> (inside a step's own outputs), run.id. No env/secrets access by design.
// Conditions: <operand> [== | != <operand>], combined with && / ||, prefixed with !.
// Operands are paths, 'single-quoted' strings, numbers, true/false.
export type Scope = Record<string, unknown>;

const EXPR = /\$\{\{\s*(.+?)\s*\}\}/g;
export const PATH = /^[a-z_][a-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/i;

export function lookup(scope: Scope, path: string): unknown {
  let cur: unknown = scope;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Every path referenced by ${{ }} in a string, for static ref checks. */
export function refsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EXPR)) out.push(...operandPaths(m[1]));
  return out;
}

export function operandPaths(expr: string): string[] {
  return expr.split(/&&|\|\||==|!=/).map((s) => s.trim().replace(/^!+/, "").trim()).filter((s) => s && !/^'.*'$/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) && s !== "true" && s !== "false");
}

function operand(scope: Scope, raw: string): unknown {
  const s = raw.trim();
  if (/^'.*'$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (!PATH.test(s)) throw new Error(`Invalid expression operand: ${s}`);
  return lookup(scope, s);
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === "" || v === 0 || v === "false");

export function evaluate(scope: Scope, expr: string): unknown {
  const e = expr.trim();
  if (e.includes("||")) return e.split("||").some((p) => truthy(evaluate(scope, p)));
  if (e.includes("&&")) return e.split("&&").every((p) => truthy(evaluate(scope, p)));
  if (e.startsWith("!") && !e.startsWith("!=")) return !truthy(evaluate(scope, e.slice(1)));
  const m = /^(.*?)(==|!=)(.*)$/.exec(e);
  if (m) {
    const a = operand(scope, m[1]), b = operand(scope, m[3]);
    const eq = String(a) === String(b);
    return m[2] === "==" ? eq : !eq;
  }
  return operand(scope, e);
}

export function condition(scope: Scope, expr: string): boolean {
  const inner = /^\s*\$\{\{(.*)\}\}\s*$/.exec(expr);
  return truthy(evaluate(scope, inner ? inner[1] : expr));
}

/** Replaces ${{ }} in a string. A string that is exactly one expression keeps the value's type. */
export function interpolate(scope: Scope, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const whole = /^\s*\$\{\{\s*(.+?)\s*\}\}\s*$/.exec(value);
  if (whole) return evaluate(scope, whole[1]);
  return value.replace(EXPR, (_, e: string) => {
    const v = evaluate(scope, e);
    return v === undefined || v === null ? "" : String(v);
  });
}
