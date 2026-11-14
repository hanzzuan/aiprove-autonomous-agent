import test from "node:test";
import assert from "node:assert/strict";
import { countPrimes } from "../src/solvers/primes.js";
import { evaluate, SELF_TESTS } from "../src/solvers/expr.js";
test("primes up to 1e6 = 78498", () => assert.equal(countPrimes(1_000_000), 78498));
test("primes edge cases", () => { assert.equal(countPrimes(1), 0); assert.equal(countPrimes(10), 4); });
test("expr self-tests", () => { for (const [e, v] of SELF_TESTS) assert.ok(Math.abs(evaluate(e) - v) < 1e-9, e); });
test("expr rejects division by zero", () => assert.throws(() => evaluate("1/0")));
