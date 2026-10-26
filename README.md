# Cobra

**Command Orchestration for Build and Release Automation**

Cobra is a hosted software factory for a team of about five people. Team leads approve GitHub issues, Cobra's agents turn them into pull requests, and a human reviews and merges every PR. Nothing auto-merges.

Cobra runs on top of the coding agents teams already use (Claude Code, Codex and GitHub Copilot) instead of building its own agent.

## Who it's for

- **Buyer:** a team lead or engineering manager. The same person is also the main approver.
- **Team size:** about 5 people.
- **Also fits:** solo founders and product owners who build new products. They're the first users of the Self-serve plan.

## Why

Cobra targets three pains, in this order:

1. Time lost to meetings
2. The cost of context switching
3. Coordination overhead: handoffs, chasing status, and small issues nobody picks up

## Plans

| Plan       | Price      | What you get                     |
|------------|------------|----------------------------------|
| Self-serve | $29/month  | Run Cobra yourself               |
| Managed    | $99/month  | We run the factory for your team |

Pitch: cheaper than one meeting hour.

### Price anchors

- GitHub Copilot Business: $19/seat/month
- GitHub Copilot Pro (individuals): about $10/month

## V1 scope

- Intake only accepts human-approved issues
- An agent opens a PR for each issue
- A human reviews, then merges or closes it

## How it works

1. A team lead labels an issue as approved.
2. Cobra sends the issue to a coding agent: Claude Code, Codex or Copilot.
3. The agent opens a PR.
4. A human reviews the PR, then merges or closes it.

## Development

```bash
npm install
npm run build
npm start
```

Requires Node 20 or later.

## Web app

A Next.js dashboard lives in `web/` (its own `package.json`; not part of the root TypeScript build).

```bash
cd web && npm install && npm run dev
```

Open http://localhost:3000. Pages: `/` (runs-first dashboard, example data), `/settings` (agent credentials, local dev storage in gitignored `web/data/`), `/workflows` (run workflows; the old `/runs/new` test run was retired and redirects to `/`).
