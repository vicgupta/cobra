// Starter templates for /agents/skills/new. Each is plain text only: picking one fills in the
// name, description and steps, and every field stays editable. Each "##" heading becomes one
// agent step when the skill is saved (see planFromBody). To add a template, append an entry.
export type SkillTemplate = { key: string; label: string; name: string; description: string; body: string };

const t = (key: string, label: string, description: string, body: string): SkillTemplate => ({ key, label, name: key, description, body: body.trim() + "\n" });
/** Read-only templates repeat the rule in every step, because each step is handed only its own section. */
const readOnly = (body: string) => body.replace(/(## [^\n]+\n[^#]*?)(?=\n\n## |\s*$)/g, (m) => `${m.trimEnd()} Don't change any files.`);

export const SKILL_TEMPLATES: SkillTemplate[] = [
  t("one-line", "One-line SOP", "A single instruction", "Fix the failing test and explain the root cause."),
  t("implement-review", "Implement + review", "Two agent steps: make the change, then review it",
    "# Reviewed change\n\n## Implement\nMake the change with tests.\n\n## Review\nCheck correctness, tests and style."),
  t("fix-bug", "Fix a bug", "Reproduce a bug, fix the root cause and add a regression test", `
# Fix a bug

## Reproduce
Read the bug report. Find or write the smallest command or test that shows the bug, and confirm it fails.

## Find the root cause
Trace the failure to the code that causes it. Explain why it happens, not just where.

## Fix
Make the smallest change that fixes the root cause. Don't refactor unrelated code.

## Add a regression test
Add a test that failed before the fix and passes now. Run the full test suite.

## Summarize
Write a short summary: the cause, the fix, the files changed and the test added.`),
  t("add-feature", "Add a feature", "Plan, build, test and document a new feature", `
# Add a feature

## Plan
Read the request and the relevant code. List the files to change and any open questions. Keep the scope small.

## Implement
Build the feature following the existing style and patterns of the repo.

## Test
Add tests for the new behavior and its edge cases. Run the full test suite and fix any failures.

## Update docs
Update the README, usage docs or changelog where users will look for this feature.`),
  t("write-tests", "Write tests", "Find untested code and add tests for it", `
# Write tests

## Find untested code
Run the test suite with coverage if the repo supports it. List the important functions and branches that have no tests.

## Write tests
Add focused tests for the most important gaps first: normal cases, edge cases and error paths. Use the repo's existing test framework. Don't change production code.

## Run them
Run the full test suite. All tests must pass; fix the tests, not the code, unless you found a real bug (report it).

## Report coverage
Summarize what is now covered, the coverage before and after if available, and what is still untested.`),
  t("code-review", "Code review (read-only)", "Review a change and list findings by severity, without changing files", readOnly(`
# Code review

Read-only: do not change, commit or push any files.

## Read the diff
Read the change (the branch, pull request or diff you were given) and the code around it. Understand what it is meant to do.

## Check correctness
Look for bugs, missed edge cases, broken error handling, race conditions and missing tests.

## Check security and style
Look for injection, leaked secrets, unsafe input handling and permission mistakes. Note naming, readability and consistency with the repo.

## List findings
List each finding with its severity (critical, major, minor, nit), the file and line, and a suggested fix. End with an overall verdict.`)),
  t("refactor", "Refactor", "Improve code structure without changing behavior", `
# Refactor

## Identify the target
Find the code to refactor and say what is wrong with it (duplication, long functions, unclear names). Run the tests first and note the result.

## Refactor
Restructure the code in small steps without changing behavior. Don't add features or change public interfaces unless asked.

## Run tests
Run the full test suite and any linters or type checks. Everything that passed before must still pass. Summarize what changed and why.`),
  t("update-dependencies", "Update dependencies", "Upgrade outdated packages safely and note breaking changes", `
# Update dependencies

## List outdated dependencies
Use the package manager to list outdated dependencies. Group them into patch, minor and major updates.

## Upgrade safely
Upgrade patch and minor versions first, then majors one at a time. Read the changelog of each major upgrade and adapt the code if needed. Update the lockfile.

## Run tests
Run the build, linters and full test suite after the upgrades. Roll back any upgrade you can't make pass.

## Note breaking changes
List what was upgraded, from which version to which, any breaking changes and code changes made, and anything left for later.`),
  t("security-audit", "Security audit (read-only)", "Scan for secrets, vulnerable dependencies and risky code, then report", readOnly(`
# Security audit

Read-only: do not change, commit or push any files, and never print a secret's value.

## Scan for secrets
Search the code and config for committed keys, tokens and passwords. Report the file and line, never the value.

## Check dependencies
Run the package manager's audit tool and list dependencies with known vulnerabilities and their fixed versions.

## Look for risky patterns
Look for injection (SQL, shell, HTML), unsafe deserialization, missing auth checks, weak crypto and overly broad permissions.

## Report
List each finding with severity, location, why it matters and a suggested fix, most severe first.`)),
  t("fix-failing-ci", "Fix failing CI", "Read the CI logs, reproduce the failure locally and fix it", `
# Fix failing CI

## Read the logs
Find the failing job and step. Quote the first real error, not the noise after it.

## Reproduce
Run the same command locally with the same versions. Decide whether it's a real bug, a flaky test or an environment problem.

## Fix
Fix the cause in code, tests or CI config. Don't skip or disable tests to make CI pass. Run the command again to confirm it passes, and summarize the cause and the fix.`),
  t("write-docs", "Write docs", "Write or update the README and usage docs", `
# Write docs

## Read the project
Read the code, scripts and existing docs to understand what the project does and how it's used.

## Update the README
Cover what it is, how to install it, how to run it and how to run the tests. Keep it short and accurate.

## Write usage docs
Add examples of the main commands, options or API calls. Check every example against the code. Change only documentation files.`),
  t("open-pr", "Open a pull request", "Put the current work on a branch, commit it and write a PR description", `
# Open a pull request

## Branch
Create a new branch with a short descriptive name from the default branch. Never work directly on main.

## Commit
Review the changes, run the tests, and commit in small logical commits with clear messages. Don't commit secrets or build output.

## Write the PR description
Push the branch and open a pull request. Describe what changed, why, how it was tested and anything reviewers should check.`),
];
