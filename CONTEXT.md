# Inro

A personal workspace for carrying, previewing, and preserving agent-generated content over time.

## Language

**Inro**:
The project: a small local container for carrying generated Documents, named after the traditional Japanese belt-worn box used for seals, identity documents, or medicines.
_Avoid_: Personal Agent Preview Server as the product name

**Document**:
A stable user-visible container for related generated content over time.
_Avoid_: Artifact, preview

**Revision**:
An immutable submission of content belonging to a Document.
_Avoid_: Version, update

**Document Key**:
An agent-supplied stable identifier used to intentionally route submissions to the same Document.
_Avoid_: Title key, title identity

**Source Agent**:
The client application identity that submitted a Revision.
_Avoid_: Model, provider, author

**Sandboxed Preview**:
A constrained view of a Revision that prioritizes local safety over full document behavior.
_Avoid_: Rendered version, raw preview

**Revision Summary**:
An optional human-readable note describing what changed in a Revision.
_Avoid_: Commit message, label

**Submission**:
An external agent request that creates a new Document or adds a Revision to an existing Document.
_Avoid_: Upload, send request

**Idempotency Key**:
An agent-supplied retry identifier that makes repeated Submissions return the original result instead of creating duplicate Revisions.
_Avoid_: Retry token, dedupe key

**Document Deletion**:
A permanent removal of a Document and all of its Revisions.
_Avoid_: Entry deletion, archive, hide

## Relationships

- A **Document** has one or more **Revisions**.
- A **Revision** belongs to exactly one **Document**.
- A **Document** has exactly one latest **Revision**.
- A **Document Key** identifies at most one **Document**.
- A **Document** title is display text, not identity.
- A **Source Agent** is recorded on each **Revision**.
- A **Revision** can be viewed as a **Sandboxed Preview**.
- A **Revision** may have one **Revision Summary**.
- A **Submission** creates exactly one **Revision**.
- A **Submission** either creates one **Document** or targets one existing **Document**.
- An **Idempotency Key** applies to one **Source Agent** and one Submission target.
- A **Document Deletion** removes exactly one **Document** and all of its **Revisions**.

## Example dialogue

> **Dev:** "When the agent sends corrected math notes five minutes later, is that a new **Document**?"
> **Domain expert:** "No — it is a new **Revision** of the same **Document** unless the agent explicitly starts a separate **Document**. The **Source Agent** is whichever client submitted that **Revision**."

## Flagged ambiguities

- "artifact" and "preview" were used near **Document**; resolved: **Document** is the canonical stable container, and **Revision** is each immutable submission.
- "title key" implied display titles could identify **Documents**; resolved: use **Document Key** for intentional identity, while titles remain display-only.
- "rendered version" was too vague for unsafe HTML; resolved: **Sandboxed Preview** is the default safe view.
- "overwrite" was used to mean advancing a **Document** to its latest **Revision**, not mutating an existing **Revision**.
- "entries" was used for listing items; resolved: these are **Documents**, and deletion means **Document Deletion**.
- "send" is a CLI action; resolved: the domain concept is a **Submission**.
- **Idempotency Key** scope is per **Source Agent** and Submission target, not global per **Source Agent**.
