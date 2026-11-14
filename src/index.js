#!/usr/bin/env node
/**
 * aiprove-agent — fully-autonomous agent for the AIProve bounty board.
 * Bounty target: best-autonomous-agent (slug: best-autonomous-agent)
 * API base: https://aiprove.fun — skill doc: GET /skill.md
 *
 * SAFETY — read before running:
 * - The signing key is read ONLY from env var AGENT_PRIVATE_KEY at runtime.
 *   It is never hardcoded, never logged, never written to a file, and never
 *   included in a transcript. The transcript strips it and the Bearer token.
 * - The agent signs ONLY the AIProve challenge message (EIP-191 personal_sign)
 *   shown to the operator first. It never blind-signs opaque calldata.
 * - No on-chain transaction is broadcast by this agent. Auth is a signed
 *   message; bounty work is REST calls to aiprove.fun.
 * - Code submissions are sent ONLY with a real repoUrl + commit that exist
 *   (git remote + git rev-parse HEAD, or REPO_URL / COMMIT_SHA env). Never
 *   fabricate a repoUrl/commit.
 *
 * Usage:
 *   node src/index.js --dry-run        # no auth, no enter, no submit
 *   node src/index.js                  # live: auth + enter + submit what it can
 *   node src/index.js --only btc-tomorrow
 *   node src/index.js --max 5
 *
 * Env (see .env.example):
 *   AGENT_PRIVATE_KEY   required for live mode only
 *   API_BASE_URL        default https://aiprove.fun
 *   REPO_URL / COMMIT_SHA / AGENT_HANDLE   optional
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { countPrimes, benchmark } from "./solvers/primes.js";
import { evaluate, SELF_TESTS } from "./solvers/expr.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "logs");
const WORK_DIR = join(ROOT, "work");
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

// --- .env loading (no dotenv dependency; values are never logged) ---
function loadDotEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const API_BASE = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/$/, "");
const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const DRY_RUN = args.includes("--dry-run");
const MAX = Number(argVal("--max") || 0) || Infinity;
const ONLY = argVal("--only") || argVal("--bounty") || null;
const HANDLE = process.env.AGENT_HANDLE || undefined;

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const TRANSCRIPT = join(LOG_DIR, `transcript-${stamp}.log`);
const SUBMISSIONS_LOG = join(LOG_DIR, "submissions.jsonl");

// --- secret stripping: token + private key never appear in logs/transcripts ---
let SECRET_VALUES = [];
function redact(text) {
  let out = String(text);
  for (const s of SECRET_VALUES) {
    if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  // Bearer tokens, private keys in any shape
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-~+/=]{10,}/g, "Bearer [REDACTED]");
  out = out.replace(/0x[0-9a-fA-F]{64}/g, (m) =>
    SECRET_VALUES.includes(m) ? "[REDACTED-PRIVATE-KEY]" : m);
  return out;
}
function log(msg, obj) {
  const line = obj === undefined ? msg : `${msg} ${redact(JSON.stringify(obj))}`;
  const entry = `[${new Date().toISOString()}] ${redact(line)}`;
  console.log(entry);
  appendFileSync(TRANSCRIPT, entry + "\n");
}
function shortToken(t) { return t ? `${t.slice(0, 8)}…${t.slice(-4)}` : ""; }

// --- HTTP helpers ---
async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${redact(JSON.stringify(data)).slice(0, 500)}`);
  return data;
}
async function apiText(path) {
  const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.text();
}

// --- Auth: challenge -> show what is signed -> sign -> verify ---
// If a session token was already obtained by the operator signing the
// challenge with their own wallet (work/token.json), use it directly:
// the agent never holds the operator's private key.
async function authenticate() {
  try {
    const tokenPath = join(WORK_DIR, "token.json");
    if (existsSync(tokenPath)) {
      const saved = JSON.parse(readFileSync(tokenPath, "utf8"));
      if (saved.token && saved.address) {
        SECRET_VALUES.push(saved.token);
        log(`Authenticated with operator-signed session token. Token prefix: ${shortToken(saved.token)} expiresAt=${saved.expiresAt ?? "n/a"}`);
        return { address: saved.address, token: saved.token, expiresAt: saved.expiresAt };
      }
    }
  } catch (e) {
    log(`Saved token unreadable, falling back to key auth: ${redact(e.message)}`);
  }
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error("AGENT_PRIVATE_KEY is not set. Set it in env/.env for live mode, or use --dry-run.");
  SECRET_VALUES.push(key);
  const { Wallet } = await import("ethers"); // dynamic: dry-run needs no ethers
  const wallet = new Wallet(key);
  const address = wallet.address;
  log(`Auth identity (testnet wallet): ${address}`);
  const { challenge } = await api(`/api/auth/challenge?address=${address}`);
  if (!challenge) throw new Error("No challenge returned by /api/auth/challenge");
  // Show exactly what will be signed — no blind signing.
  log("Challenge to sign (EIP-191 personal_sign):\n" + challenge);
  const signature = await wallet.signMessage(challenge);
  log(`Signature produced (prefix only): ${signature.slice(0, 12)}…`);
  const verified = await api("/api/auth/verify", {
    method: "POST",
    body: { address, signature },
  });
  if (!verified.token) throw new Error(`Auth verify failed: ${redact(JSON.stringify(verified)).slice(0, 300)}`);
  SECRET_VALUES.push(verified.token);
  log(`Authenticated. Token prefix: ${shortToken(verified.token)} expiresAt=${verified.expiresAt ?? "n/a"}`);
  return { address, token: verified.token, expiresAt: verified.expiresAt };
}

// --- Repo provenance: only real repoUrl + commit ---
async function getRepoInfo() {
  const envUrl = process.env.REPO_URL || "";
  const envCommit = process.env.COMMIT_SHA || "";
  if (envUrl && envCommit) return { repoUrl: envUrl, commit: envCommit, source: "env" };
  try {
    const { stdout: url } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: ROOT });
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT });
    const repoUrl = url.trim();
    const sha = commit.trim();
    if (repoUrl.startsWith("https://github.com/") && /^[0-9a-f]{7,40}$/.test(sha)) {
      return { repoUrl, commit: sha, source: "git" };
    }
  } catch { /* not a git repo or no remote — code submissions stay blocked */ }
  return null;
}

// --- Forecast reasoning (transparent, capped confidence, no fabricated data) ---
async function coinChange24h(coinId) {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d?.[coinId]?.usd_24h_change ?? null;
  } catch { return null; }
}
function clampConfidence(base) {
  return Math.round(Math.min(0.65, Math.max(0.52, base)) * 100) / 100;
}
async function forecastPrediction(bounty) {
  const slug = bounty.slug || "";
  const title = (bounty.title || "").toLowerCase();
  // Direction calls on BTC / ETH: use the last 24h trend, predict continuation.
  if (slug.includes("btc") || title.includes("btc")) {
    const ch = await coinChange24h("bitcoin");
    if (ch === null) return { answer: "yes", confidence: 0.52, reason: "no live price data; neutral prior" };
    const answer = ch >= 0 ? "yes" : "no";
    return { answer, confidence: clampConfidence(0.52 + Math.abs(ch) / 100), reason: `BTC 24h change ${ch.toFixed(2)}%; momentum continuation` };
  }
  if (slug.includes("eth") || title.includes("eth")) {
    const ch = await coinChange24h("ethereum");
    if (ch === null) return { answer: "yes", confidence: 0.52, reason: "no live price data; neutral prior" };
    const answer = ch >= 0 ? "yes" : "no";
    return { answer, confidence: clampConfidence(0.52 + Math.abs(ch) / 100), reason: `ETH 24h change ${ch.toFixed(2)}%; momentum continuation` };
  }
  // "within $X" / stock / gold / SPY closes: no free reliable live feed here — neutral.
  return { answer: "yes", confidence: 0.52, reason: "neutral prior; no verified live feed for this underlying in this agent" };
}

// --- Planning: what can this agent autonomously do for each bounty? ---
function planBounty(b) {
  const slug = b.slug || "";
  const cat = (b.cat || "").toLowerCase();
  const metric = (b.metric || "").toLowerCase();
  const title = (b.title || "").toLowerCase();

  if (slug.includes("refer")) return { action: "skip", reason: "referrals need other agents; no self-referrals" };
  if (slug === "signal-eth-pnl-24h") return { action: "forecast", reason: "ETH 24h long/short call; submit {answer, confidence} with stated reasoning" };
  if (cat === "forecast" || metric.includes("brier") || metric.includes("direction") || title.includes("predict") || title.includes("will btc") || title.includes("call ")) {
    if (slug.includes("top5") || title.includes("top 5")) {
      return { action: "skip", reason: "top-5 token ranking needs a live market-cap feed the agent does not have" };
    }
    return { action: "forecast", reason: "prediction task; submit {answer, confidence} with stated reasoning" };
  }
  if (slug === "fastest-primes") return { action: "code", reason: "local sieve solver in src/solvers/primes.js; submit repo@commit" };
  if (slug === "code-golf-expr") return { action: "code", reason: "local expression evaluator in src/solvers/expr.js; submit repo@commit" };
  if (slug === "sample-agent-skillmd") return { action: "code", reason: "this repo IS the sample agent; submit repo@commit" };
  if (slug === "best-autonomous-agent") return { action: "code", reason: "this repo IS the autonomous agent; submit repo@commit" };
  if (slug === "bug-hunt-utils") return { action: "skip", reason: "needs the utils.js dataset from the bounty detail; no dataset link in the brief" };
  if (slug === "eth-pnl-fixed") return { action: "skip", reason: "needs the fixed ETH dataset from the bounty; no dataset link in the brief" };
  if (cat === "content" || cat === "design" || cat === "marketing") {
    return { action: "skip", reason: "needs human creative / social posting (article, art, meme, X post); agent does not post to X or generate media" };
  }
  return { action: "skip", reason: `no autonomous solver implemented for cat=${b.cat} lane=${b.lane}` };
}

function recordSubmission(entry) {
  appendFileSync(SUBMISSIONS_LOG, redact(JSON.stringify({ ts: new Date().toISOString(), ...entry })) + "\n");
}

// --- Main loop ---
async function main() {
  log(`aiprove-agent starting. mode=${DRY_RUN ? "dry-run (no auth, no enter, no submit)" : "live"} api=${API_BASE} target=best-autonomous-agent`);
  log(`Transcript: ${TRANSCRIPT}`);

  // 1. Read the skill doc from the API (source of truth for the loop).
  const skill = await apiText("/skill.md");
  log(`Fetched skill.md (${skill.length} chars). First line: ${skill.split("\n")[0]}`);

  // 2. Local solver self-tests (prove the code bounties' work is real).
  const primeBench = benchmark(1_000_000);
  log(`Solver self-test: primes up to 1,000,000 = ${primeBench.count} in ${primeBench.ms} ms (expected 78498)`);
  if (primeBench.count !== 78498) throw new Error("Prime solver self-test failed");
  for (const [expr, expected] of SELF_TESTS) {
    const got = evaluate(expr);
    if (Math.abs(got - expected) > 1e-9) throw new Error(`Expr solver failed: ${expr} = ${got}, expected ${expected}`);
  }
  log(`Solver self-test: expression evaluator passed ${SELF_TESTS.length}/${SELF_TESTS.length} cases`);

  // 3. List open bounties.
  const { bounties = [] } = await api("/api/bounties?status=open");
  let list = bounties.filter((b) => b.status === "open");
  if (ONLY) list = list.filter((b) => b.slug === ONLY);
  // Urgent first.
  list.sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  const limited = list.slice(0, MAX);
  log(`Open bounties: ${bounties.length} total, ${limited.length} in scope${ONLY ? ` (only=${ONLY})` : ""}`);

  const plans = limited.map((b) => ({ ...b, plan: planBounty(b) }));
  for (const b of plans) {
    log(`PLAN ${b.slug} | ${b.title} | ${b.amt} ${b.unit} (~$${b.usd}) | closes ${b.closes} | lane ${b.lane} | ${b.plan.action.toUpperCase()} — ${b.plan.reason}`);
  }
  writeFileSync(join(WORK_DIR, "plan.json"), JSON.stringify(plans.map(({ plan, ...b }) => ({ slug: b.slug, title: b.title, amt: b.amt, unit: b.unit, usd: b.usd, closes: b.closes, plan })), null, 2));

  if (DRY_RUN) {
    log("DRY-RUN COMPLETE: no auth, no enter, no submit performed. Plan written to work/plan.json.");
    return;
  }

  // 4. Live mode: authenticate (key from env only, challenge shown before signing).
  const { address, token } = await authenticate();

  // 5. Repo provenance for code submissions.
  const repo = await getRepoInfo();
  log(repo ? `Repo provenance: ${repo.repoUrl} @ ${repo.commit} (source: ${repo.source})`
           : "No real repoUrl/commit found (no git remote / REPO_URL). Code submissions will be SKIPPED, never fabricated.");

  // 6. Enter + complete what can be completed.
  for (const b of plans) {
    try {
      const entered = await api(`/api/bounties/${b.slug}/enter`, {
        method: "POST", token, body: { ...(HANDLE ? { handle: HANDLE } : {}) },
      });
      log(`ENTER ${b.slug}: ${redact(JSON.stringify(entered)).slice(0, 200)}`);
    } catch (e) {
      log(`ENTER ${b.slug} failed (continuing; submit auto-enters): ${redact(e.message)}`);
    }

    try {
      if (b.plan.action === "forecast") {
        const pred = await forecastPrediction(b);
        log(`FORECAST ${b.slug}: answer=${pred.answer} confidence=${pred.confidence} reason=${pred.reason}`);
        const res = await api(`/api/bounties/${b.slug}/submit`, {
          method: "POST", token, body: { prediction: { answer: pred.answer, confidence: pred.confidence }, ...(HANDLE ? { handle: HANDLE } : {}) },
        });
        log(`SUBMIT ${b.slug}: ${redact(JSON.stringify(res)).slice(0, 300)}`);
        recordSubmission({ slug: b.slug, type: "prediction", prediction: pred, result: res });
      } else if (b.plan.action === "code") {
        if (!repo) {
          log(`SKIP SUBMIT ${b.slug}: no real repoUrl/commit — set up a GitHub repo first (see README).`);
          recordSubmission({ slug: b.slug, type: "code", skipped: "no-repo-provenance" });
          continue;
        }
        const transcript = [
          `aiprove-agent run ${new Date().toISOString()}`,
          `bounty: ${b.slug} — ${b.title}`,
          `plan: ${b.plan.reason}`,
          `solver self-tests: primes 78498/1e6, expr ${SELF_TESTS.length}/${SELF_TESTS.length} passed`,
          `agent: ${address}`,
          "secrets stripped locally; server stores only a transcript hash.",
        ].join("\n");
        const res = await api(`/api/bounties/${b.slug}/submit`, {
          method: "POST", token,
          body: { repoUrl: repo.repoUrl, commit: repo.commit, transcript, ...(HANDLE ? { handle: HANDLE } : {}) },
        });
        log(`SUBMIT ${b.slug}: ${redact(JSON.stringify(res)).slice(0, 300)}`);
        recordSubmission({ slug: b.slug, type: "code", repoUrl: repo.repoUrl, commit: repo.commit, result: res });
      } else {
        log(`SKIP ${b.slug}: ${b.plan.reason}`);
        recordSubmission({ slug: b.slug, type: "skip", reason: b.plan.reason });
      }
    } catch (e) {
      log(`ERROR ${b.slug}: ${redact(e.message)}`);
      recordSubmission({ slug: b.slug, type: "error", error: redact(e.message).slice(0, 300) });
    }
  }

  // 7. Status check.
  try {
    const me = await api("/api/me", { token });
    log(`STATUS /api/me: ${redact(JSON.stringify(me)).slice(0, 400)}`);
  } catch (e) {
    log(`STATUS check failed: ${redact(e.message)}`);
  }
  log("Live run complete. See logs/submissions.jsonl for results.");
}

main().catch((e) => {
  try { log(`FATAL: ${redact(e.stack || e.message)}`); } catch { console.error(e); }
  process.exit(1);
});
