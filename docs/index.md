# Recipes — Documentation

This folder is the source of truth for how the Recipes app works, why it is
built the way it is, and the rules we follow when we change it. It exists to
do two jobs:

1. **Remember the rules.** The decisions here are easy to forget and expensive
   to rediscover. Write them down once, link to them forever.
2. **Onboard a new dev in one sitting.** A capable engineer should be able to
   read the keystone doc and be productive the same day.

If a rule lives only in someone's head or in a commit message, it does not
exist. Put it here.

---

## Start here

| Doc | What it covers |
|---|---|
| **[how-it-works.md](./how-it-works.md)** | The keystone. The whole system end to end: the user journey, the layers and why they exist, auth & permissions, the "backend", mocks, the manifest + orchestrator, how we ship PRs, and how deployments work. |

> The keystone doc is the one you read first and the one every other doc is
> measured against. New docs narrow in on a single topic; they do not restate
> the keystone, they link to it.

---

## How we write docs (the standard)

This is the first doc in the project, so it sets the bar. Future docs follow
these rules.

**Location & format**
- All docs live in `docs/` as plain Markdown. No build step, no site
  generator, no dependencies. A "site" here means *a folder you can read on
  GitHub or in any editor*. Keep it that way until there is a real reason not
  to.
- One topic per file. File names are `kebab-case.md` and describe the topic,
  not the author or the date (`auth.md`, not `notes-2026.md`).
- Every doc opens with a one-sentence statement of what it covers, and — when
  the topic is non-trivial — a short table of contents.

**Status labels**
Forward-looking docs are normal here; we write down the plan before we build
it. To keep "what is true today" separate from "what we intend", tag any
section, row, or claim that is not yet real in the code:

- `[Implemented]` — true in the code on `dev` right now. The default; only
  written when a section mixes states.
- `[Convention]` — the rule we follow by agreement. May not be machine-
  enforced yet (e.g. a PR checklist item with no CI gate).
- `[Planned]` — agreed direction, not built. Do not rely on it.

If you change the code, update the label in the same PR. A stale `[Planned]`
that shipped, or an `[Implemented]` that regressed, is a documentation bug.

**Tone**
- Explain the *why*, not just the *what*. The code already says what it does;
  docs exist for the reasoning the code can't carry.
- Be concrete. Reference real paths (`src/bridge/ai.ts`), real commands, real
  field names. A doc that can't be acted on is decoration.
- Short and true beats long and aspirational. Cut anything you can't stand
  behind.

**When you add a doc**
1. Create `docs/<topic>.md`.
2. Add a row to the **Start here** table above.
3. Link it from the relevant section of the keystone so it's reachable by
   reading, not just by browsing the folder.

---

## Source of truth, when docs and code disagree

The code is authoritative for *behavior*; these docs are authoritative for
*intent and rules*. If they conflict, that is a bug in one of them — fix it,
don't leave it. The manifest block in `package.json` (`conjureos.*`) is the
authoritative contract between this app and the ConjureOS host; the keystone
doc explains it but does not replace it.
