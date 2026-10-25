# Cobra

**Command Orchestration for Build and Release Automation**

Cobra is a hosted software factory for small teams of about five people, and for solo founders. Team leads approve GitHub issues, Cobra's agents turn them into pull requests, and a human reviews and merges every PR. Nothing auto-merges.

## Why

Cobra targets three pains, in this order:

1. Time lost to meetings
2. The cost of context switching
3. Coordination overhead

## Plans

| Plan       | Price      | What you get                     |
|------------|------------|----------------------------------|
| Self-serve | $29/month  | Run Cobra yourself               |
| Managed    | $99/month  | We run the factory for your team |

## V1 scope

- Intake only accepts human-approved issues
- An agent opens a PR for each issue
- A human reviews, then merges or closes it

## Development

```bash
npm install
npm run build
npm start
```

Requires Node 20 or later.
