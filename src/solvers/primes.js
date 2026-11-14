// Fast prime counter — Sieve of Eratosthenes (Uint8Array).
// Used for the "fastest-primes" bounty: fastest correct prime counter.
// No network, no secrets, deterministic.
export function countPrimes(n) {
  if (!Number.isInteger(n) || n < 2) return 0;
  const sieve = new Uint8Array(n + 1);
  sieve.fill(1);
  sieve[0] = 0;
  sieve[1] = 0;
  const limit = Math.floor(Math.sqrt(n));
  for (let i = 2; i <= limit; i++) {
    if (sieve[i]) {
      for (let j = i * i; j <= n; j += i) sieve[j] = 0;
    }
  }
  let count = 0;
  for (let i = 2; i <= n; i++) if (sieve[i]) count++;
  return count;
}

export function benchmark(n = 1_000_000) {
  const t0 = performance.now();
  const count = countPrimes(n);
  return { n, count, ms: Math.round((performance.now() - t0) * 100) / 100 };
}
