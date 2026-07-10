---
name: feature-dev
description: "Anthropic Claude Code official guided feature development workflow. Use when implementing a new feature systematically: discovery, codebase exploration, clarifying questions, architecture design, implementation, quality review, and summary."
---

# Feature Development

This is a Codex-compatible wrapper for Anthropic Claude Code's official `feature-dev` plugin.

At the start of a feature implementation, announce: "I'm using the Anthropic official feature-dev workflow to implement this feature."

Follow the official workflow from `../../commands/feature-dev.md` and use the companion agent prompts in `../../agents/` as reference material:

- `code-explorer.md`: explore relevant code paths, patterns, architecture, and key files.
- `code-architect.md`: design implementation approaches and compare trade-offs.
- `code-reviewer.md`: review code for correctness, simplicity, project conventions, and missing tests.

## Workflow

1. Discovery: clarify what needs to be built and summarize the requested feature.
2. Codebase exploration: inspect existing implementation patterns before designing or editing.
3. Clarifying questions: ask concrete questions when behavior, edge cases, constraints, or integration details are underspecified.
4. Architecture design: present a small set of implementation approaches when the feature is non-trivial, including a recommendation and trade-offs.
5. Implementation: wait for explicit approval if the workflow has reached a design choice, then make scoped changes following existing project conventions.
6. Quality review: inspect the completed change for bugs, maintainability issues, convention mismatches, and missing tests.
7. Summary: report what changed, important decisions, verification performed, and any remaining risks.

## Rules

- Understand the codebase before editing.
- Prefer the repository's existing patterns and helper APIs.
- Keep changes scoped to the requested feature.
- Do not skip clarifying questions when important behavior is ambiguous.
- Add or update tests according to the risk and blast radius of the change.
- Do not modify code until the user has permitted changes when local instructions require permission.
