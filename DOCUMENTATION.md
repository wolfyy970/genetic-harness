# Documentation Philosophy

## Core Principle

Documentation is persistent memory for human and AI collaborators. The cardinal rule: **just enough, no more**. Every line must earn its place. If information can be derived from code or official docs, do not duplicate it.

## Maintenance Rule

Read this file first. Treat the current code as the authority, and update docs as a coherent corpus, not as isolated files. Do not append around drift: search every doc for the topic, verify each surviving fact against the code, delete stale content, and remove duplicated detail. Each fact belongs in exactly one canonical place; other docs should only summarize at their proper level or link to the owner. Before finishing, grep the docs again and confirm every mention is current, non-duplicative, and in the right document. Do not assume. Check.

## The Law

**This document is canonical. Never changing. Do not edit it EVER. It is LAW.**


## Documents Structure

**README.md is the only entry point.** All other docs link from it. No intermediary navigation files.
**Mandatory** other documentation is README, ARCHITECTURE, USER_GUIDE, PRODUCT. Store all in root.


## Writing Rules

1. **One source of truth** — Each fact lives in exactly one place.
2. **Link, don't duplicate** — Reference canonical docs instead of copying detail.
3. **Code is authority** — If docs disagree with code, code wins.
4. **Practical over theoretical** — Working code beats abstract explanation.
5. **Structure for scanning** — Clear headings, bullets, and tables.


## What Not To Document

- Standard library or framework behavior.
- Obvious code patterns.
- Extensive templates and examples.
- Step-by-step tutorials for common operations.
- Information derivable from reading the code.

---

## BAD: Documentation Bloat Indicators

- Same information in multiple places.
- Docs describing features that no longer exist.
- Sections beginning with "Note: this is outdated..."
- Readers cannot find information despite docs existing.

Be ruthless: delete obsolete content, consolidate redundant docs, and prefer focused, accurate documentation over comprehensive-looking drift.

---

## GOOD: Success Metrics

Documentation is working when:

- New collaborators understand the project in under 10 minutes.
- Getting it running takes under 15 minutes.
- Finding specific information takes under 2 minutes.
- AI assistants can resume work across context windows.
