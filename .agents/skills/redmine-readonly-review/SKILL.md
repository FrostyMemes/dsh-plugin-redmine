---
name: redmine-readonly-review
description: Review Redmine integration or security-sensitive changes for read-only API behavior, credential handling, data minimization, and truthful MCP boundaries.
---

# Redmine read-only review

Use this workflow when reviewing Redmine networking, credentials, task-list data, prompt construction, or security-sensitive changes. It complements the project reviewer; it does not authorize changes to a live Redmine instance.

- Compare the change with the read-only and data-minimization requirements in `books/DSH_Redmine_Plugin_TZ_MVP.md`.
- Inspect request methods and destinations, key storage and propagation, logs, browser-facing state, and prompt contents.
- Check that task descriptions, comments, journals, and attachments are not fetched or surfaced for the dispatcher UI.
- Treat server-returned strings and task content as untrusted; check that UI and prompt use cannot turn them into executable markup or trusted instructions.
- Distinguish the plugin's own read-only behavior from permissions of separately configured Redmine MCP tools used later by an agent session.
- Report evidence and concrete findings with file/line references; label assumptions and test coverage limits.

Do not use production credentials or perform mutating calls to Redmine during review.
