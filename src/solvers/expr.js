// Small expression evaluator — tokenizer + recursive descent.
// Used for the "code-golf-expr" bounty: smallest expression evaluator
// that passes every test. Supports + - * / % ^ (right-assoc), parentheses,
// unary minus, decimals. Throws on invalid input / division by zero.
// No network, no secrets, deterministic.
export function evaluate(input) {
  const s = String(input).replace(/\s+/g, "");
  if (!s) throw new Error("empty expression");
  let i = 0;
  const peek = () => s[i];
  const next = () => s[i++];

  function parseNumber() {
    let start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (start === i) throw new Error(`expected number at ${i} in ${input}`);
    const v = Number(s.slice(start, i));
    if (!Number.isFinite(v)) throw new Error(`invalid number in ${input}`);
    return v;
  }
  function parsePrimary() {
    if (peek() === "(") {
      next();
      const v = parseAdd();
      if (next() !== ")") throw new Error(`expected ) in ${input}`);
      return v;
    }
    if (peek() === "-") { next(); return -parsePrimary(); }
    if (peek() === "+") { next(); return parsePrimary(); }
    return parseNumber();
  }
  function parsePow() {
    let v = parsePrimary();
    if (peek() === "^") { next(); v = Math.pow(v, parsePow()); }
    return v;
  }
  function parseMul() {
    let v = parsePow();
    for (;;) {
      const op = peek();
      if (op === "*" || op === "/" || op === "%") {
        next();
        const r = parsePow();
        if (op === "*") v *= r;
        else if (op === "/") { if (r === 0) throw new Error("division by zero"); v /= r; }
        else v %= r;
      } else return v;
    }
  }
  function parseAdd() {
    let v = parseMul();
    for (;;) {
      const op = peek();
      if (op === "+" || op === "-") { next(); const r = parseMul(); v = op === "+" ? v + r : v - r; }
      else return v;
    }
  }
  const result = parseAdd();
  if (i !== s.length) throw new Error(`unexpected ${peek()} at ${i} in ${input}`);
  return result;
}

export const SELF_TESTS = [
  ["1+2*3", 7],
  ["(1+2)*3", 9],
  ["10/4", 2.5],
  ["2^3^2", 512],
  ["-5+3", -2],
  ["10%3", 1],
];
