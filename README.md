# aiprove-agent

Fully-autonomous agent for the **AIProve bounty board** — https://aiprove.fun

Target bounty: **best-autonomous-agent** (`best-autonomous-agent`)
— “Build a fully autonomous agent — no human in the loop. It reads
aiprove.fun/skill.md, signs in with its own keypair, and enters and
completes as many open bounties as it can on its own.”
Reward: 0.3 GLD (~$72) · closes Nov 15, 2026 13:49 UTC · lane AutoGrade.

## What it does

1. Fetches the skill doc (`GET /skill.md`) from the live API.
2. Authenticates with the AIProve identity wallet: `GET /api/auth/challenge`,
   signs the challenge with EIP-191 `personal_sign`, `POST /api/auth/verify`
   → Bearer session token.
3. Lists open bounties (`GET /api/bounties?status=open`), urgent first.
4. Enters each bounty, then completes what it can autonomously:
   - **Forecast bounties** — submits `{answer, confidence}` with stated
     reasoning. BTC/ETH direction uses the live 24h CoinGecko trend
     (momentum continuation, confidence capped 0.52–0.65); other
     underlyings use a neutral 0.52 prior, stated as such.
   - **Code bounties** — local solvers, self-tested on every run:
     `src/solvers/primes.js` (Sieve of Eratosthenes) for `fastest-primes`,
     `src/solvers/expr.js` (recursive-descent evaluator) for `code-golf-expr`.
     This repo itself is the entry for `sample-agent-skillmd` and
     `best-autonomous-agent`.
   - **Skipped, with a reason logged** — content/design/marketing
     (article, art, meme, X post: needs human creative / social posting),
     `bug-hunt-utils` / `eth-pnl-fixed` (dataset not in the brief),
     `top5-pons-24h` (needs a live market-cap feed), referrals
     (no self-referrals).
5. Logs every step to `logs/transcript-<timestamp>.log` (secrets stripped)
   and every submission/skip to `logs/submissions.jsonl`.

## What it does NOT do

- **No private key / seed in the repo, in chat, or in any transcript.**
  The key is read only from `AGENT_PRIVATE_KEY` at runtime.
- **No blind signing.** It signs only the AIProve challenge message,
  printed in full before signing. No opaque calldata, no on-chain
  transaction is broadcast by this agent.
- **No fabricated submissions.** Code submissions need a real
  `repoUrl` + `commit` (git remote + `git rev-parse HEAD`, or
  `REPO_URL` / `COMMIT_SHA`). If none exists, code bounties are
  skipped, never submitted with a made-up repo/commit.
- No posting to X, no image generation, no faucet claiming.

## Setup

```bash
cd ~/workspace/aiprove-agent
npm install          # ethers v6 only
cp .env.example .env # then fill in AGENT_PRIVATE_KEY — .env is git-ignored
```

Set the key in your shell / vault, not in chat:

```bash
export AGENT_PRIVATE_KEY="0x..."   # testnet/airdrop EVM wallet — the AIProve identity
```

The Binance wallet is **not** used here. Do not put its key (or any key)
in this repo.

To make code submissions possible, push this repo to GitHub first:

```bash
git init
git add . && git commit -m "aiprove-agent: autonomous AIProve agent"
git remote add origin https://github.com/<you>/aiprove-agent.git
git push -u origin main
```

The agent auto-detects that remote + HEAD commit. Or set `REPO_URL` /
`COMMIT_SHA` in `.env`.

## Run

```bash
npm run dry-run   # node src/index.js --dry-run
# -> fetches skill.md + live bounties, runs solver self-tests,
#    prints the plan. No auth, no enter, no submit, no key needed.

npm start         # live mode: auth + enter + submit what it can
node src/index.js --only btc-tomorrow
node src/index.js --max 5
```

## Files

| File | Purpose |
|---|---|
| `package.json` | Node ESM, `ethers` only dependency |
| `src/index.js` | Auth, bounty loop, planning, submit, logging |
| `src/solvers/primes.js` | Sieve prime counter |
| `src/solvers/expr.js` | Expression evaluator |
| `.env.example` | Env template (no secrets) |
| `.gitignore` | Ignores `node_modules/`, `.env`, `logs/`, `work/` |
| `logs/` | Transcripts + `submissions.jsonl` (git-ignored) |
| `work/plan.json` | Dry-run / live plan (generated) |

## Current status (2026-11-13)

- Dry-run verified against the live API (21 open bounties at check time).
- Live auth is **blocked**: the AIProve challenge signature from MetaMask
  did not match the testnet wallet address (first attempt: challenge
  expired; second: `signature does not match address`). A correct,
  fresh signature from the testnet wallet in MetaMask is needed — or set
  `AGENT_PRIVATE_KEY` from the vault and run live mode.
- No GitHub repo exists yet for this agent, so code submissions are
  currently blocked by design (no fabricated repoUrl/commit).
