# Ship

Trigger: ship

Goal: Take a free-form task description from issue to merged PR on a team repo, in four plain steps.

Steps:
1. Create issue: turn the task description into one GitHub issue with a short title, context, and acceptance criteria.
2. Middle step: do whatever is needed in between (implement, review, test, fix) on this run's cobra/<run-id> branch until the tests pass.
3. Create PR: push the branch and open a pull request that links the issue and summarizes the change and test results.
4. Merge PR: only if merging is allowed for the person running this (designated lead or admin) and checks pass; otherwise leave the PR open and say why.

Output: The issue number, branch, PR number, test results, and either the merge commit or the reason the PR was left open.
