# Automation library

The Tasks page includes an **Automation library**: five ready-made engineering packs. Each pack is a starting point — a prefilled skill, a suggested Eastern-time schedule, and suggested result delivery. You pick the repo and the agent, you can edit everything, and a confirm step creates the skill and the task.

Packs:

| Pack | Suggested schedule (ET) |
|---|---|
| Morning PR & issue brief | Weekdays at 9:00 AM |
| Stale PR reminder | Weekdays at 10:00 AM |
| CI failure digest | Weekdays at 8:00 AM |
| Unanswered review follow-up | Weekdays at 11:00 AM |
| Weekly repo health | Mondays at 9:00 AM |

Default run type is a **test run** (nothing is posted or changed). Switch to a real run on the form or later in the task if you want the agent to comment or open work. Delivery defaults to an in-app notification on success or failure (email if you turn it on and the team has a mailbox).

Activation is `POST /api/automation-library` (sign-in required). If creating the task fails, the new skill is not kept.
