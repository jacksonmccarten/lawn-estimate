---
tags: [index]
---

# pre-hack — start here

This folder is an Obsidian vault and the project's documentation. Open it
with **Open folder as vault** → `pre-hack/docs`.

## Map

- [[ENGINEERING_DESIGN]] — the design of record: architecture, data model, build sequence, decisions
- [[COMPLIANCE_REQUIREMENTS]] — legal, tax and licensing requirements (R1–R31)
- [[gotchas]] — footguns, blocked paths, things that surprised us
- [[deploy]] — deploy the database, API and Lambdas with CDK
- [[local-loop]] — run the widget, the API and the dashboard together on one machine
- `structure/` — how the repository is laid out, workspace by workspace; start at [[Project Structure]] or the [[Architecture.canvas|Architecture]] canvas
- `decisions/` — one note per decision, created from [[decision|the decision template]]

## Conventions

- Link notes with `[[wikilinks]]`, not relative markdown links.
- Every note starts with frontmatter; `tags` at minimum.
- One topic per note. Add new notes to the map above.
- A change that alters behavior described in a note updates the note in the
  same commit.
