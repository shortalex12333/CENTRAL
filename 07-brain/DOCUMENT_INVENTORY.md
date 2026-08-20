# Document Inventory — Real, Read-Only Scan

**Date:** 2026-08-20
**Purpose:** Ground the "knowledge substrate" architecture decision in the actual non-code document corpus per business segment, rather than an assumed one. Read-only — no file content was opened beyond filenames/extensions, except that HTML titles/paths were visible from `find` output (no content read).

**Source of truth for segment→directory mapping:** `controlplane.project_ownership` in the live `central-mvp-pg` Postgres container (port 5433), queried directly:

```
docker exec central-mvp-pg psql -U postgres -c "SELECT * FROM controlplane.project_ownership;"
```

```
    project_id    |  project_name   |              local_directory              | confidence_threshold |          created_at
------------------+-----------------+-------------------------------------------+-----------------------+-------------------------------
 celeste-os       | CelesteOS-Cloud | /Users/celeste7/Documents/CelesteOS-Cloud |                  0.9  | 2026-08-19 23:36:50.568829+00
 myi2             | MYI2            | /Users/celeste7/Documents/MYI2            |                  0.9  | 2026-08-19 23:36:50.568829+00
 influence        | INFLUENCE       | /Users/celeste7/Documents/INFLUENCE       |                  0.9  | 2026-08-19 23:36:50.568829+00
 myi2-app-service | MYI2            | /Users/celeste7/Documents/MYI2            |                  0.9  | 2026-08-20 01:16:49.748562+00
(4 rows)
```

The table currently has **4 rows / 3 distinct directories** (`myi2-app-service` duplicates `myi2`'s directory). `alex-short` and `CelesteOS-Marketing` are **not yet in the ownership table** — inventoried anyway per task instructions, since they're known-real segments (personal/founder repo, and the not-yet-git Marketing folder respectively).

Methodology note: a naive `find ... -iname '*.md'` without excluding vendored directories massively over-counts. Two concrete traps hit during this scan and corrected:
- `MYI2` has a `.venv-scraper/` Python virtualenv — raw scan showed 139 `.md` / 59 `.txt`; after excluding `*venv*`, `site-packages`, `.pytest_cache`, `__pycache__`, `node_modules`, `.git`, it dropped to **103 `.md` / 8 `.txt`**.
- `INFLUENCE` has a `06-z-axis-corpus/venv/` Python virtualenv containing **753 `.md` files** on its own (site-packages doc pages) — a naive scan would have made INFLUENCE look like the largest doc corpus by far. None of those belong to the segment's real content.

All counts below are **post-exclusion** (excluding `node_modules`, `.git`, `*venv*`, `site-packages`, `.pytest_cache`, `__pycache__`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `.vercel`, and — for MYI2 only — a confirmed-empty `legacy/quarantine` dir).

---

## Summary table

| Segment | Directory | Doc count | Types (count) | Total doc size | Already a git repo? |
|---|---|---|---|---|---|
| CelesteOS-Cloud | `/Users/celeste7/Documents/CelesteOS-Cloud` | 21 | md (20), txt (1) | 320 KB | **Yes** — `origin` → `github.com/shortalex12333/Cloud_DMG.git` |
| MYI2 | `/Users/celeste7/Documents/MYI2` | 113 | md (103), txt (8), csv (2) | 1,204 KB | **Yes** — `origin` → `github.com/shortalex12333/MYI2.git` |
| INFLUENCE | `/Users/celeste7/Documents/INFLUENCE` | 41 | md (32), xlsx (6), csv (2), pptx (1) | 6,360 KB | **Yes** — `origin` → `github.com/shortalex12333/influence720.git` |
| alex-short | `/Users/celeste7/Documents/alex-short` | 18 | md (15), txt (3) | 176 KB | **Yes** — `origin` → `github.com/shortalex12333/alex-short.git` |
| CelesteOS-Marketing | `/Users/celeste7/Documents/CelesteOS-Marketing` | 5 (classic doc exts) / **127 incl. HTML** | md (5), **html (122)**, plus non-doc assets (webp/png/jpg/woff2/css/js) | 156 KB (md only) / **9,392 KB incl. HTML** | **No** — no `.git` of its own; `git rev-parse` resolves up to an accidental `/Users/celeste7`-level repo, not a real Marketing repo |
| **TOTAL (classic doc exts only)** | | **198** | md 175, txt 12, csv 4, xlsx 6, pptx 1 | **~8.0 MB** | 4 of 5 segments are real repos |
| **TOTAL (incl. Marketing's HTML)** | | **~320** | +122 html | **~17.1 MB** | — |

Zero `.pdf`, `.docx`, `.doc`, `.xls`, `.ppt`, `.eml`, `.rtf`, `.key`, `.pages`, `.numbers` files exist anywhere across all five directories (verified with an unfiltered case-insensitive `find` for each extension in each directory — see evidence below). The only binary "office" file that turned up at all was a vendored `python-docx` library template (`INFLUENCE/06-z-axis-corpus/venv/.../docx/templates/default.docx`) — not a real document, excluded from all counts.

---

## Per-segment detail

### CelesteOS-Cloud (`celeste-os` in ownership table)
- 21 docs, 320 KB total. All `.md`/`.txt`.
- Representative filenames: `2_DAY_COMPLETION_PLAN.md`, `ENGINEERING_HANDOVER.md`, `SYSTEM_ARCHITECTURE.md`, `GAP_ANALYSIS.md`, `PIPELINE_TEST_REPORT.md`, `installer/build/docs/ARCHITECTURE_ANALYSIS.md`, `installer/n8n_workflow_guide.md`.
- All engineering/status/handover docs — no marketing, legal, or financial content visible in filenames.
- Whole-repo size on disk (code + docs + `.git`): 118 MB — docs are 0.27% of that.

### MYI2 (`myi2` / `myi2-app-service` in ownership table — same directory, duplicate row)
- 113 docs, 1,204 KB total.
- 103 `.md`, 8 `.txt`, 2 `.csv`.
- Representative filenames: `HANDOVER_FABLE5.md`, `docs/SEO_RECOVERY_PLAN_2026-07-09.md`, `client/AUDIT_REPORT.md`, `client/.planning/research/PITFALLS.md`, `docs/templates/AGENT-ARCHITECTURE.md`, `docs/outreach/prospect_list_template.csv`, `public/llms.txt`, `public/robots.txt`.
- Largest single doc is 36 KB (`HANDOVER_FABLE5.md`) — no file over ~40 KB.
- Whole-repo size on disk: 1.2 GB (dominated by `node_modules`/`.venv-scraper`/`.next` build output) — docs are ~0.1% of that.

### INFLUENCE (`influence` in ownership table)
- 41 docs, 6,360 KB total — the largest doc corpus by size of the three ownership-table segments, driven by 6 real `.xlsx` dashboards + 1 `.pptx`.
- 32 `.md`, 6 `.xlsx`, 2 `.csv`, 1 `.pptx`.
- Representative filenames: `01-plan/D0_ONTOLOGY_FOUNDATION_SPEC.md` through `D6_...SPEC.md` (spec docs), `02-dashboards/Influence720_MasterOntology.xlsx` (2.07 MB, largest single doc found anywhere in this scan), `02-dashboards/Dashboard1_ProducerTacticalMap.xlsx` … `Dashboard5_ExecutiveCommandCenter.xlsx`, `00-source/Influence 360 - Executive Briefing.pptx` (388 KB), `06-z-axis-corpus/corpus/legal_statutory/equasis_worklist_FULL_CORPUS.csv` (1.67 MB).
- One duplicate noted: `CELESTEOS_BRAND_TOKENS_REFERENCE.md` exists both at `05-build/engine/` and `public/05-build/engine/` (a published mirror) — same content, two paths.
- Whole-repo size on disk: 968 MB — docs are 0.66% of that.

### alex-short (not yet in ownership table)
- 18 docs, 176 KB total.
- 15 `.md`, 3 `.txt`.
- Representative filenames: `ATTRIBUTIONS.md`, `docs/alex-short context.md`, `docs/templates/AGENT-ARCHITECTURE.md`, `docs/templates/FRAMEWORK.md`, `docs/templates/ORCHESTRATION-MODEL.md`, `public/llms.txt`, `public/llms-full.txt`, `public/robots.txt`, `.vercel/README.txt`.
- Smallest, least document-heavy segment. Looks like a founder personal/portfolio site repo with template scaffolding docs, not a content-heavy segment.
- Whole-repo size on disk: 358 MB (mostly `node_modules`/`.next`) — docs are 0.05% of that.

### CelesteOS-Marketing (not yet in ownership table, not yet a git repo) — fuller breakdown per request

This segment is structurally different from the other four: it is **not a code repo with a few docs inside it** — it's almost entirely a folder of standalone **rendered HTML documents** (prototypes, decks, briefing pages, worksheets), with very few files in classic office/text formats.

Full non-`.DS_Store` file-type breakdown (147 files total, 14 MB on disk):

| Extension | Count | Notes |
|---|---|---|
| `.html` | 122 | The dominant format — rendered pitch decks, briefing docs, worksheets, welcome packs, UI prototypes/renders |
| `.md` | 5 | Includes `PITCH_DECK_V3_ROUGH_DRAFT.md`, two files under `Emails/Considering/` (`### Examples of warm reach out from clients.md`, `reply_temaplte.md`), one under `EXTERNAL-USE/security-companion/_HANDOVER.md`, one under `INTERNAL-USE/client call/archive/PROTOTYPE_V2_INVENTORY.md` |
| `.webp` | 5 | Prospect vessel photos (`prospects/AMORE/*.webp`) |
| `.css` / `.js` | 4 / 2 | Shared prototype/render styling scripts, not documents |
| `.woff2` | 2 | Brand fonts (Eloquia Display) embedded for the Security Companion HTML doc |
| `.png` / `.jpg` / `.jpeg` | 2 / 1 / 1 | Render screenshots, prospect vessel photos |
| `.py` | 1 | `build_standalone.py` — a build script, not a document |
| `.bak-pre-swap` | 1 | Stale backup of an HTML file |

Folder structure and where the bulk of it lives:
- `INTERNAL-USE/` (3.4 MB) — `Business Focus/` (12 strategy/positioning HTML docs e.g. `celesteos-100m-offer-playbook.html`, `celesteos-regulatory-roadmap.html`, `corporate-structure-strategy.html`), `client call/` (call-companion + host-notes HTML tools), `MULTI-THREADING/` (worksheets), `Prospects/` (target-list HTML pages).
- `renders/` (2.7 MB) — ~50 standalone HTML component renders/prototypes for the product UI (`render-work-orders-list.html`, `render-certificates.html`, etc.) plus a `_prototypes/` and `_legacy-12april-backup/` subtree. This looks like product-UI design output that landed in the Marketing folder, not marketing collateral per se.
- `prospects/` (4.9 MB) — vessel prospect photo folders (`AMORE/`, `DreAMBoat/`) plus `index.html`/`system-overview.html`/`vessel-list.html`.
- `EXTERNAL-USE/` (1.9 MB) — client-facing `Security-Companion.html`, `Welcome Pack/` (welcome-pack, faq-sheet, sla-support-commitment), `demo-handover-export.html`.
- `Emails/` (60 KB) — `qualification-cheatsheet.html` plus the two `.md` files under `Considering/`.
- `Archive/` (984 KB) — one large legacy doc, `celesteos-SYSTEM-DOC-25pages (2).html` (984 KB, the biggest single HTML file besides the Pilot Call Companion).
- `converted/` (104 KB) — appears to be an already-converted-from-HTML set (`crew-quick-reference.html`, `faq-sheet.html`, etc.) — possibly output of a prior ad-hoc conversion pass.

Largest individual files: `Pilot-Call-Companion.html` (1.42 MB), `prospects/system-overview.html` (1.0 MB), `Archive/celesteos-SYSTEM-DOC-25pages (2).html` (984 KB), `Security-Companion.html` (948 KB), `Welcome Pack/welcome-pack.html` (768 KB). None of these are binary — they're self-contained HTML (often with embedded CSS/fonts), which is directly text-extractable (strip tags), unlike a PDF or a `.pptx` which needs a real parsing library.

**Confirmed still true: CelesteOS-Marketing is NOT a git repo.** `git -C CelesteOS-Marketing rev-parse --is-inside-work-tree` returns `true`, but `--show-toplevel` resolves to `/Users/celeste7` (the home directory itself is an accidental git repo — unrelated, has no bearing on Marketing's own version control), and there is no `.git` directory inside `CelesteOS-Marketing/` itself. `git remote -v` inside it returns nothing. This matches the earlier gate exactly.

---

## Size-distribution read (small text docs vs. large binary corpus?)

**Overwhelmingly small text, not a large binary corpus.** Concretely:
- 191 of 198 classic-doc-extension files (96.5%) are `.md`/`.txt`/`.csv` — plain text, directly embeddable with no extraction step, virtually all under 40 KB each.
- Only **7 files across all 5 segments** are binary office formats needing real parsing: 6 `.xlsx` + 1 `.pptx`, all in INFLUENCE, totaling ~4.1 MB. The largest single one is `Influence720_MasterOntology.xlsx` at 2.07 MB.
- **Zero PDFs anywhere.** Zero `.docx`. This means the two most common "need real text extraction" formats in a typical knowledge-substrate design (PDF, Word) are **not present at all** in the current corpus — they're a design consideration for the future, not a current blocker.
- CelesteOS-Marketing's 122 HTML files are the one real outlier in bulk (9.2 MB) — but HTML is not a "binary/needs-OCR" problem; it needs a straightforward HTML→text step (strip tags/scripts/styles), which is a much lighter lift than PDF/PPTX parsing.
- Across all 5 segments, whole-repo-on-disk sizes (118 MB–1.2 GB, dominated by `node_modules`/`.venv`/`.next` build artifacts) dwarf the actual document content (176 KB–6.36 MB per segment) by 2–3 orders of magnitude — these are code repos with a thin layer of documentation, not document repositories.

## Scale estimate for the knowledge-substrate decision

- **Strict (classic doc extensions only):** ~198 documents, ~8.0 MB total.
- **Broad (including Marketing's HTML-as-document corpus, which is real content the founder specifically wants covered):** ~320 documents, ~17.1 MB total.
- Either framing is **dozens-to-low-hundreds of documents, single-digit-to-high-teens megabytes** — not thousands of documents, not a multi-gigabyte binary corpus. This is small enough that a simple embed-everything-directly pipeline (chunk + embed the raw text/markdown/HTML) is viable without a heavyweight extraction stage for the current corpus; a real PDF/DOCX text-extraction step becomes necessary only if/when those formats actually start appearing (they don't exist yet), and an HTML→text normalization step is needed specifically for CelesteOS-Marketing before anything else.

---

## Evidence (representative real command output)

```
$ docker exec central-mvp-pg psql -U postgres -c "SELECT * FROM controlplane.project_ownership;"
(4 rows — see table above)

$ docker ps --filter "name=central-mvp-pg"
central-mvp-pg   Up 15 hours   0.0.0.0:5433->5432/tcp

$ git -C /Users/celeste7/Documents/CelesteOS-Cloud remote -v
origin  https://github.com/shortalex12333/Cloud_DMG.git (fetch/push)

$ git -C /Users/celeste7/Documents/MYI2 remote -v
origin  https://github.com/shortalex12333/MYI2.git (fetch/push)

$ git -C /Users/celeste7/Documents/INFLUENCE remote -v
origin  https://github.com/shortalex12333/influence720.git (fetch/push)

$ git -C /Users/celeste7/Documents/alex-short remote -v
origin  https://github.com/shortalex12333/alex-short.git (fetch/push)

$ git -C /Users/celeste7/Documents/CelesteOS-Marketing remote -v
(empty)
$ git -C /Users/celeste7/Documents/CelesteOS-Marketing rev-parse --show-toplevel
/Users/celeste7
$ ls /Users/celeste7/Documents/CelesteOS-Marketing/.git
No such file or directory

$ find <dir> -type f \( -iname '*.pdf' -o -iname '*.docx' -o ... \) | wc -l
CelesteOS-Cloud: 0   MYI2: 0   INFLUENCE: 8 (7 real xlsx/pptx + 1 vendored docx template)   alex-short: 0   CelesteOS-Marketing: 0
```

Full per-extension counts and sizes are in the "Per-segment detail" section above, each independently reproducible with the `find` commands described in the methodology note.
