# Brain Layer as an LLM Wiki — Architecture & Delivery Plan

Status: delivered. All seven phases in section 7 are implemented and covered by tests.
Section 1 records the v0.1.0 baseline this replaced, and is kept as the before-picture.

## 0. Source material and what we are actually adapting

Two inputs, with different authority:

- **Specification** — Andrej Karpathy, ["LLM Wiki"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Three layers (raw sources / wiki / schema), three operations (ingest / query / lint), two special files (`index.md`, `log.md`). The gist is deliberately abstract and says so: it describes the pattern, not an implementation.
- **Reference implementation** — [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) (MIT, compatible with our license — attribution required if we copy template text). An Agent Skills package: `SKILL.md` as the schema layer, `references/*.md` templates, `scripts/check_evidence.py` for the grounding invariant, three-class lint with explicit authority levels. Its design notes are worth more than its code: it lists what it deliberately dropped after three months of production use — source-hash tracking, line-number citations, confidence scores, per-article review dates, automatic scheduling.

The reference targets a coding agent sitting in a terminal with a filesystem and an unbounded editing loop, driven by a human who reads the diffs in Obsidian. Open PiPi is none of those things. It is a Telegram-first runtime with:

- a bounded function-call loop per turn (`src/core/llm.ts`, `src/core/tool-executor.ts`) and a latency budget measured in seconds,
- a daily token cost cap,
- multiple residents in one space with different authority and different privacy expectations (`src/core/authority.ts`, `memory_entries.space_bound_id`),
- an owner who reads a digest on a phone, not a diff.

So the pattern transfers; the execution model does not. Most of the decisions in section 2 are consequences of that one sentence.

## 1. What already exists

`src/core/brain.ts` (739 lines) + `src/skills/brain.skill.ts` ship today as Brain Layer v0.1.0. What is real:

- **Scoped roots.** `data/pipi-brain/global/` and `data/pipi-brain/spaces/<encoded-space-id>/`.
- **Directory skeleton.** `ensureBrainDirs` creates `raw/{chats,links,docs,transcripts}`, `notebook/{daily,project,scratch}`, `wiki/{projects,entities/{people,companies,tools,cities},decisions,principles,playbooks}`, `playbooks/`, `indexes/`.
- **Notes.** `appendNote` writes into `notebook/daily/YYYY-MM-DD.md` as HTML-comment-delimited blocks with JSON metadata, plus append-only `brain-note-event` blocks for status changes.
- **Markdown is authoritative.** `rebuildBrainIndex` reconstructs the whole SQLite index by re-reading the files. This is the single best property of the current design and everything below preserves it.
- **Wiki pages.** JSON frontmatter + body, whole-page write, indexed into a `wiki_pages` table (path, title, excerpt, sources, updated_at).
- **Six tools.** `append_note`, `search_notes`, `promote_note_to_wiki`, `read_wiki_page`, `update_wiki_page`, `compile_notebook`.

### Gap against the specification

| Spec element | Reference implementation | Open PiPi today | Verdict |
|---|---|---|---|
| `raw/` immutable sources | `raw/<topic>/YYYY-MM-DD-slug.md` + metadata header | directories created, **nothing ever writes to them** | missing |
| `wiki/` compiled pages | `wiki/<topic>/<article>.md`, one level | present, two levels under `entities/` | present, needs flattening |
| `index.md` catalog | hand-maintained table per topic | SQLite `wiki_pages`, **no file, no tool exposes it** | missing at both ends |
| `log.md` chronology | append-only, grep-able prefix | `note_events` inside notebook files only | missing |
| **Ingest** | fetch → triage → compile → cascade → post | none | missing |
| **Query** | index-first, then full-text, cite, optionally archive | none (`search_notes` covers notes only) | missing |
| **Lint** | three authority classes + evidence script | none | missing |
| Schema layer | `SKILL.md`, co-evolved with the user | conventions live in tool descriptions | missing |
| Contradiction handling | `Status: Outdated` / `Status: Disputed` blocks | none | missing |
| Grounding invariant | literals grepped in linked raws | none | missing |

Short version: we have the notebook and a place to put pages. We do not have the wiki — the compiling, the cross-referencing, the querying, or the maintenance. And `promote_note_to_wiki` appends the note verbatim under a `## Promoted Notebook Notes` heading, which produces a scrapbook, not a compiled artifact. That is precisely the "re-derive it later" failure the gist argues against, moved from chat history to disk.

## 2. Architecture decisions

### D1 — Markdown is the source of truth; SQLite is a disposable cache

Already true; make it a guarantee rather than a habit. Any state that cannot be reconstructed by `rebuildBrainIndex` from files alone is a bug. Enforced by a test: mutate, delete `indexes/sqlite.db`, rebuild, assert the index is byte-identical.

This is what buys the gist's "the wiki is just a git repo of markdown files" — version history, Obsidian, `grep`, and restore points (`src/core/runtime-backup.ts`) all work without knowing anything about us.

### D2 — `index.md` and `log.md` are projections, not hand-maintained state

The reference has the LLM rewrite `index.md` by hand on every ingest. Correct for a coding agent; wrong here — a Gemini turn re-emitting a growing markdown table is expensive, lossy, and races with itself.

Resolution: **SQLite is the agent's read path; the two files are generated from it after every mutation.** The agent queries structured rows; the human opens `wiki/index.md` in Obsidian or GitHub and sees the same thing. One writer, two readers, no drift.

`log.md` is the exception — it is genuinely append-only, so it is appended directly, and it is mirrored nowhere: its grep-able heading format *is* the query interface, for the agent and the human alike. Keep the reference's format exactly:

```
## [2026-08-13] ingest | Sleep debt and afternoon focus
- Disposition: Update
- Raw: raw/health/2026-08-13-huberman-sleep-a1b2c3d4.md
- Updated: Anna — evening routine
```

`grep "^## \[" log.md | tail -5` must keep working. That is not a nicety; it is how the agent cheaply learns what it did recently without loading the index.

### D3 — The wiki belongs to a space, and visibility is a field, not a convention

Karpathy's wiki has one reader. Ours has a family. `global` and `spaces/<id>` roots already exist; that is not enough on its own.

Rules:

- A page may not be compiled from a memory entry carrying `space_bound_id` unless the target scope **is** that space. Person-private facts stay in `memory_entries` where the existing visibility logic (`getVisiblePersonMemoryEntries`) already handles them.
- Every page carries `visibility: "space" | "owner"` in frontmatter. `wiki_search` filters by the caller's resolved authority (`src/core/authority-guard.ts`), the same way tool visibility already works.
- Promotion from a space scope to `global` is an explicit, owner-approved operation, never inferred.

This is the largest adaptation in the plan and the one that is painful to retrofit. A wiki that quietly compiles one resident's disclosure into a page another resident can read is a privacy incident, not a bug report.

### D4 — Ingest crosses the turn boundary: capture is synchronous, compile is a job

The gist notes a single source may touch 10–15 pages. A Telegram turn cannot do that inside its tool budget, and should not try.

- **In the turn:** `brain_capture` writes the source to `raw/`, enqueues an ingest job, replies in one line. Cheap, fast, always succeeds.
- **Out of the turn:** the compiler runs in `src/task-scheduler.ts` (`node-cron` is already wired through `SkillManifest.crons` in `src/skills/_registry.ts`) with its own model budget, and reports back as a digest.

Rejected alternative: compile inline with a page cap. It produces half-cascaded wikis, which is strictly worse than a delayed one — lint cannot distinguish "not compiled yet" from "compiled wrong", so every subsequent check becomes advisory.

### D5 — Triage before compile, on the cheap model

Four dispositions, taken unchanged from the reference: **New**, **Update**, **Disputed**, **No material**. New/Update/Disputed combine; No material is exclusive.

`No material` is the load-bearing one. Without it, a chat-fed wiki fills with thin pages restating what it already knows, and the index stops being a useful retrieval surface. The rule from the reference is worth quoting into our schema file: *do not force an article out of a thin source.*

Triage runs on the executor model with the **index** in context, not the pages — a few hundred rows, not a wiki. Only New/Update/Disputed reach the advisor model (`GEMINI_ADVISOR_MODEL`). `src/core/local-triage.ts` already establishes this two-tier pattern in the codebase.

### D6 — `promote_note_to_wiki` stops appending and starts compiling

Current behavior appends the note text verbatim under `## Promoted Notebook Notes`. Replace with: read the target page, merge the note into the section it belongs in, record the note id in `sources`, refresh `knowledge_updated_at`.

Keep the append path only as the degraded fallback when the model call fails, and mark the page `status: "needs_review"` when it fires. A visible fallback is fine; a silent one is how a wiki rots.

### D7 — Section patches, not whole-page replacement

`update_wiki_page(path, body)` takes a full body. For a cascade across twelve pages that is twelve full rewrites: twelve times the output tokens, unreadable diffs, and any concurrent write silently lost.

Add `patch_wiki_section(path, heading, body)`. Concurrency is solved one level up, without version tokens: the runtime is a single Node process, so every wiki write takes an in-process per-scope lock — the same serialization compile already needs (D4). Whole-page replace stays for page creation and for lint's structural fixes, where rewriting is the point.

### D8 — Provenance is structural, and verified mechanically

Every claim-bearing page carries `sources: [{ kind, ref }]` where `kind` is `raw | note | message`. `raw/` files are immutable and named `YYYY-MM-DD-<slug>-<hash8>.md`, so re-capturing the same URL is idempotent instead of producing `-2`, `-3` duplicates.

Port the reference's `check_evidence.py` to TypeScript inside `brain-lint.ts` — no Python in the runtime image, and it needs to run under `vitest` like everything else. It greps high-signal literals (numbers with suffixes, decimals, ISO dates, quotes over ~6 words) in the linked raw files and reports suspects. Port that literal-grep core and nothing else; the rest of the reference script's heuristics can follow if lint's reports ever show the gap.

The reference's framing is exactly right and should go into our schema file verbatim in spirit: compile *establishes* the invariant by locating values before writing them; lint *verifies* it. Because `raw/` is immutable, a verified page stays verified.

This matters more for us than for the reference. Its sources are articles; ours are often chat messages, and a model turning a family conversation into a confident "fact" is the exact failure mode that makes a household assistant untrustworthy.

### D9 — Contradictions are annotated, never silently rewritten

Status blocks, format inherited from the reference's article template:

```markdown
> **Status: Outdated** (2026-08-13)
> Superseded by the 2026-08 checkup; the earlier figure came from the 2025 report.

> **Status: Disputed**
> Source A reports X; source B reports Y.
```

Lint reports malformed blocks (Outdated without a date, either kind without an explanation) as judgment findings. Never rewrite history — that is the property that makes the wiki auditable, and a household wiki that quietly changes its mind is worse than no wiki.

### D10 — Lint is a cron with three authority classes

Straight from the reference, which got this right:

1. **Safe fixes (auto).** Index/file divergence, broken internal links with exactly one unambiguous match, dead `See Also` entries, raw-reference path drift.
2. **Mechanical reports (never auto-fixed).** Evidence-check suspects, unverifiable pages, unreferenced raw files. Facts are never auto-corrected.
3. **Judgment reports (owner digest).** Cross-page contradictions, stale claims lacking a Status block, orphans, missing cross-references, concepts mentioned everywhere but lacking a page.

Cadence rides the existing memory sprint (`memory_sprint_days`, default 7, `src/core/memory-sprint.ts`) so the lint digest lands with the sprint compaction the owner already reads, instead of adding a new notification the owner learns to ignore.

### D11 — Query earns its keep by entering the prompt, not only by answering questions

Two paths:

- **Explicit** — `wiki_search` (index + FTS, returns rows with citations) and `wiki_answer` (reads the hits, synthesizes with links).
- **Passive** — `src/core/context-composer.ts` injects a `[WIKI]` block of the top-N index rows matching the current turn, under a hard character budget, next to the existing `[PERSON MEMORY]` / `[SPACE MEMORY]` blocks.

The passive path is what makes the wiki pay for itself in a chat assistant. Without it, a family wiki becomes a filing cabinet nobody opens; with it, every turn gets slightly better context for a fixed token cost.

Archiving a good answer back into the wiki (the gist's "explorations compound too") reuses the compile path with `kind: "archive"`, no cascade, and an `[Archived]` prefix in the index — again matching the reference, including its rule that archive pages are never cascade-updated because they are point-in-time snapshots.

### D12 — The schema layer is a file the owner can edit, per space

Karpathy's third layer, which we do not have at all. Today the conventions live in tool descriptions: the owner cannot change them, and they cost tokens on every single turn whether or not the wiki is touched.

Move them to `src/brain/schema.md`, loaded like a grounding pack and overridable per space through the existing `grounding_overrides` table. Co-evolution is the entire point of the layer — the gist is explicit that you and the LLM tune the schema over time as you learn what your domain needs.

### D13 — Ingest is metered; the queue is the backpressure

Compile spends advisor-model tokens against the existing daily cap. When the budget is gone: the source still lands in `raw/`, the job stays queued, compile runs tomorrow. Never drop, never silently skip.

A raw file with no page is already a lint finding ("unreferenced raw file"), so the degraded state is visible in a channel we are building anyway. That is the correct end state, not a workaround.

### D14 — No embeddings in v1

SQLite FTS5 over title/excerpt/body plus the index is enough. The gist says index-first works to roughly a hundred sources and hundreds of pages; a household wiki will not pass that soon.

Revisit on an observable, not a hunch: when lint reports index-miss rate (queries answered from FTS that the index alone missed) above a threshold we can actually measure.

## 3. Target module layout

```
src/core/
  brain-store.ts       # scopes, paths, dir layout + migration, db handle, index schema, scope lock
  brain-model.ts       # how the Brain Layer calls a model, and what happens when the budget ends
  brain-schema.ts      # loads the schema layer, per-space override
  brain.ts             # notebook notes, note events, promotion, rebuild orchestration
  brain-wiki.ts        # pages: read/create/patch, frontmatter, links, search,
                       #   index.md projection, log.md append/read
  brain-ingest.ts      # capture, hashing, dedupe, topic routing, triage, compile, cascade
  brain-lint.ts        # the three check classes, incl. the evidence checker (D8)
  brain-query.ts       # search, answer assembly, archiving, the [WIKI] context block
src/skills/
  brain.skill.ts       # tool surface + crons
src/brain/
  schema.md            # the schema layer (D12)
  templates/
    article.md  archive.md  raw.md
```

Three modules were not in the original list, each for a stated reason.

`brain-store.ts` exists because `brain.ts` needs `reindexWikiTree` for its rebuild while
`brain-wiki.ts` needs paths and the database handle — a direct import cycle. The store owns
exactly one truth: where the brain lives on disk and how its index is opened, which is why
the schema for every derived table lives there too.

`brain-model.ts` exists because `llm.ts` reaches the skill registry through the tool
executor, and the registry loads `brain.skill.ts`. A static import of `llm.ts` from the Brain
Layer would close the cycle llm → tool-executor → skills → brain-ingest → llm, so this module
resolves `llm.ts` lazily at call time. It also owns `BrainBudgetError`, the single place that
decides what "no budget" means for every Brain job.

`brain-schema.ts` is the loader for D12, kept apart from `brain-store.ts` because the schema
is content the owner edits, not infrastructure.

There is no `index.md` template: the index is projected from the database (D2), so a template
for it would be a second definition of the same format.

`brain.ts` keeps only what it is already good at — scope resolution, path safety, note blocks, index rebuild. Everything wiki-shaped moves out. One file owns each truth: `brain-wiki.ts` both writes pages and projects the index, so the writer and the projector cannot drift; the evidence checker lives inside lint because it is lint's mechanical class, not a subsystem. The path-safety helpers (`normalizeWikiPath`, `safeRelativePath`) are load-bearing security code and move as-is, with their tests.

## 4. Data model

### Filesystem

```
data/pipi-brain/<global|spaces/<encoded-id>>/
  raw/<topic>/YYYY-MM-DD-<slug>-<hash8>.md   # immutable
  notebook/daily/YYYY-MM-DD.md               # unchanged
  wiki/<topic>/<article>.md                  # one level of topics only
  wiki/index.md                              # generated (D2)
  wiki/log.md                                # append-only (D2)
  indexes/sqlite.db                          # rebuildable (D1)
```

**Flatten the wiki to one topic level.** Today `wiki/entities/people/anna.md` is two levels deep. Go to `wiki/people/anna.md`. Reasons: it matches the reference, it keeps relative-link math trivial and uniform (`../../raw/<topic>/<file>.md` from every page), and the extra level buys nothing a topic name cannot express. Migration is a rename plus a link rewrite, done once in Phase 0 while the wiki is still small.

### Frontmatter

JSON, as today — it is dependency-free and machine-readable, and that choice is already documented in `brain.ts`. Extended:

```json
{
  "title": "Anna",
  "kind": "article",
  "status": "canonical",
  "visibility": "space",
  "sources": [{ "kind": "raw", "ref": "raw/health/2026-08-13-sleep-a1b2c3d4.md" }],
  "created_at": "2026-08-13T09:00:00.000Z",
  "updated_at": "2026-08-13T09:00:00.000Z",
  "knowledge_updated_at": "2026-08-13"
}
```

`updated_at` is when the file was touched; `knowledge_updated_at` is the reference's `Updated` — when the *knowledge* changed, not a typo fix. Splitting them is what makes lint's date-drift check meaningful instead of firing on every formatting pass.

Everything derivable stays out of frontmatter: the topic is the directory, the id is the path, and cross-references live in the body's `See Also` section, extracted into `wiki_links` at index time. A field you can compute is a field that can drift.

### SQLite (all rebuildable)

| Table | Purpose |
|---|---|
| `wiki_pages` | path, title, kind, status, visibility, excerpt, sources_json, knowledge_updated_at, updated_at |
| `wiki_links` | from_path, to_path, kind (`body`/`see_also`/`raw`), resolved |
| `wiki_fts` | FTS5 over title, excerpt, body |
| `raw_sources` | path, topic, title, url, content_hash, collected_at, published_at, state (`queued`/`triaged`/`compiled`/`no_material`/`failed`), disposition, attempts, last_error |

`wiki_links` is the one table doing real work: orphans, backlinks, and broken-link detection all fall out of a single query instead of a filesystem walk per lint pass. There is no queue table — a raw source *is* its own queue item, its lifecycle is the `state` column, and `WHERE state = 'queued'` is the queue. And there is no log table — `log.md`'s grep-able format is its query interface (D2).

Every column is recoverable from files: a raw file's header carries its title, source, and dates, and `state`/`disposition` come from `log.md`'s ingest entries — which is why the reference calls the no-material log heading a machine-readable inventory key. `collected_at` is stored at day precision because that is the precision the file records; storing a timestamp would make a rebuilt row differ from the row it replaced, and D1's equality test would then be asserting something weaker than it claims.

## 5. The three operations

### Ingest

**Capture (synchronous, in the turn).** Resolve the source (URL via the existing browsing skill, forwarded message, pasted text, uploaded file) → pick a topic, reusing an existing `raw/` subdirectory unless the topic is genuinely distinct → write `raw/<topic>/YYYY-MM-DD-<slug>-<hash8>.md` with a metadata header (source, collected, published) → insert into `raw_sources` with `state: queued` → confirm in one line. If `content_hash` already exists, skip the write and say so.

**Triage (job, executor model).** Search the wiki index with the source's key entities and their synonyms. Emit a disposition. On `No material`: log it, set the state, stop — the raw file stays.

**Compile (job, advisor model).** Same-thesis → merge into the existing page. New concept → new page in the most relevant topic, named after the concept, not the file. Spans topics → most relevant topic plus `See Also`. Conflicts → Status block on both sides, cross-linked.

Source fidelity is a hard rule at this step, not a preference: locate every number, date, and quote in the raw file before writing it, and write it exactly as found (`42K` stays `42K`). Derived values must show their components. If a value cannot be located, drop the precision rather than the honesty.

**Cascade.** Search the full wiki for the source's entities and claims — not just the index — and update every materially affected non-archive page. Each touched page gets `knowledge_updated_at` refreshed. Bounded by a page cap per job; overflow re-queues rather than truncating silently.

**Post.** Regenerate `index.md` from the index; append the log entry.

Compilation is serialized per scope. `index.md`, `log.md`, and cascade targets are shared state, and the reference learned this too: searching may parallelize, compiling may not.

### Query

Index first, then FTS with synonyms. Never report "nothing in the wiki" until both come back empty — and say that both were searched. Prefer wiki content over model priors, and cite with links. Plain queries write nothing.

Archiving happens only on an explicit ask: new page, `kind: "archive"`, sources are the wiki pages cited (not raw), `[Archived]` prefix in the index, one log line. Never merged into an existing page.

### Lint

Runs on the sprint cadence. Classes and authority per D10. Output: safe fixes applied and counted, mechanical and judgment findings in the owner digest, one log line:

```
## [2026-08-13] lint | 6 issues found, 4 auto-fixed
```

## 6. Context integration

`context-composer.ts` gains a `[WIKI]` block beside the existing memory blocks:

```
[WIKI]
- people/anna.md — evening routine, sleep debt, current focus (2026-08-13)
- projects/renovation.md — contractor timeline, budget envelope (2026-08-09)
```

Index rows only — title, one-line summary, date, path. Never page bodies. Row selection reuses the composer's existing topic tokenizer — the same mechanism its cross-space lookup already runs on — to build the `wiki_fts` query from the current turn. The agent pulls a body with `read_wiki_page` when it decides it needs one. Hard character cap, same shape as the memory budget already enforced in the composer.

## 7. Delivery plan

Each phase is one PR, ends with `pnpm verify` green, and is independently useful.

| Phase | Scope | Done when |
|---|---|---|
| 0 | ✅ Flatten wiki topics; extract `brain-wiki.ts` from `brain.ts`; generate `index.md` and `log.md`; rebuild-equality test (D1) | Existing tools behave identically; the two files exist and regenerate |
| 1 | ✅ Capture half of `brain-ingest.ts` + `brain_capture` tool + `raw_sources` | A forwarded link lands in `raw/` with `state: queued`; re-capture is idempotent |
| 2 | ✅ Triage worker on the cron; dispositions; `No material` path; log entries | Queue drains to a disposition without touching wiki pages |
| 3 | ✅ Section patches (D7); compile + cascade; `promote_note_to_wiki` rewritten (D6) | One source produces a merged page plus its cascade, with sources recorded |
| 4 | ✅ `brain-query.ts`; `wiki_search` / `wiki_answer`; archive; `[WIKI]` context block (D11) | The wiki answers a question with citations, and shows up in a normal turn |
| 5 | ✅ `brain-lint.ts`: evidence checker (D8) + the three classes; lint cron + owner digest (D10) | Lint finds a planted contradiction and a planted broken link, fixes only what it may |
| 6 | ✅ `src/brain/schema.md` + templates; per-space override; docs and README section (D12) | The owner can edit conventions without a code change |

Visibility (D3) is not a phase. It is enforced from Phase 1 onward, because retrofitting it means auditing every page ever written.

## 8. Risk register

| Risk | Why it bites here | Mitigation |
|---|---|---|
| Privacy leak across residents | One space, several people, different disclosure expectations | D3 enforced from Phase 1; a test that a `space_bound_id` memory cannot reach a `visibility: space` page |
| Prompt injection via ingested sources | Raw sources are web pages and forwarded messages — untrusted by definition | Compile treats raw content strictly as data; never let a source's text reach a tool-selection prompt unquoted; the same rule the Home Assistant addon already follows for entity names |
| Cost blowup on cascade | Advisor-model calls scale with pages touched | Page cap per job, daily cap already exists, overflow re-queues (D13) |
| Wiki rot — pages nobody reads | The reference's own failure mode; the gist's whole argument | D11 passive injection makes staleness visible in ordinary turns, not only in lint |
| Model writes confident nonsense from chat | Chat sources are thin and ambiguous | `No material` disposition (D5) plus the evidence check (D8) |
| SQLite/file divergence | Two stores, one truth | D1 rebuild-equality test in CI |
| Scope creep into a second memory system | `memory_entries` already exists and works | The wiki holds compiled, citable, durable knowledge; memory holds recent operational state. A fact that has a source goes in the wiki; a fact that has a deadline goes in memory |

## 9. Deliberately not building

Taken partly from the reference's own list of things it dropped after production use:

- **Embeddings / vector search** — D14.
- **Confidence scores, per-page review dates, source-hash tracking in pages** — the reference dropped all three; they generate maintenance without generating trust.
- **Obsidian-specific tooling** (Web Clipper hotkeys, Dataview, graph view, Marp decks) — those are the human's side of the gist. The wiki being plain markdown in a directory means the owner can use all of them without us shipping anything.
- **Image ingestion** — the gist's own note applies: if sources are text, skip it. Revisit when a real source needs it.
- **`qmd` or any external search binary** — a runtime that must run on a Raspberry Pi does not take a second search engine as a dependency for a wiki this size.
- **Automatic scheduling of ingest** — capture stays user-initiated. The owner curates; the agent maintains. That division is the point of the pattern.

## References

- Karpathy, *LLM Wiki* — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Astro-Han/karpathy-llm-wiki (MIT) — https://github.com/Astro-Han/karpathy-llm-wiki
