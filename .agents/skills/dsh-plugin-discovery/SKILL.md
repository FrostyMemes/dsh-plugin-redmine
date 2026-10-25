---
name: dsh-plugin-discovery
description: Research DSH plugin integration work before implementation when target-version capabilities, global UI integration, workspace selection, session creation, or host/client boundaries need confirmation.
---

# DSH plugin discovery

Use this workflow for the research stage of changes that integrate a plugin with DSH. Keep the product behavior in `books/DSH_Redmine_Plugin_TZ_MVP.md`; this skill guides technical discovery and does not prescribe a code structure.

- Identify the actual DSH version or commit and the relevant host, client, plugin, workspace, and session interfaces.
- Prefer installed-source evidence for the target build. Use current upstream documentation as a lead, then verify compatibility with the target.
- Separate confirmed capabilities, version-dependent behavior, proposed fallbacks, and unresolved blockers.
- Keep browser code, DSH Host responsibilities, and external Redmine requests within their intended trust boundaries.
- Return a concise report with evidence and implications for the agreed user experience before recommending an implementation approach.

Do not implement a presumed API or report a capability as available when it has not been verified.
