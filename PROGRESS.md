# Project progress — After Effects automation drafts

This file tracks **drafts** of the batch audio visualizer project: what changed, when, and why. Add a new row or section whenever you ship a meaningful revision.

---

## Draft log

| Draft | Date | Summary |
|-------|------|---------|
| **D1** | 2026-04-28 | Initial delivery: `batch_audio_visualizer.jsx` per `prompt.txt` — WAV batching, `Black Solid 1` + Audio Spectrum + Glow setup, AME via `renderQueue` / `queueInAME`, `README.txt` with setup and troubleshooting. |
| **D2** | 2026-04-28 | Documentation: `README.txt` replaced by **`README.md`** (same content, Markdown structure). Added **`PROGRESS.md`** (this file) for draft tracking. Alert strings in `batch_audio_visualizer.jsx` now point to `README.md`. |
| **D3** | 2026-04-28 | Per WAV: rename active comp to `{scene}_V_{tail}` (split on last `_` from the WAV stem), then queue export; output `.mp4` uses the same base name. Helpers `wavBaseToCompVName`, `sanitizeExportName`. README updated for naming rules. |
| **D4** | 2026-04-28 | Fix effect **matchNames**: Audio Spectrum is `ADBE AudSpect` (not `ADBE Aud Spectrum`); Glow uses `ADBE Glo2` with fallback to `ADBE Glow`. Prevents “Cannot add effect” right after folder dialogs. |
| **D5** | 2026-04-28 | Spectrum/Glow: strict **English** property names + prefix fallback (no fuzzy substring). User’s numeric/menu spec; tunable `SPECTRUM_*` / `GLOW_*` indices before batch loop. Glow reduced to listed controls only. |
| **D6** | 2026-04-28 | Fixed work-area crash for long audio (`workAreaDuration out of range`). Script now sets comp duration first, then clamps render/work area to valid comp duration if needed. |

---

## Draft notes (detail)

### D1 — Initial implementation

- ExtendScript entry: `#target aftereffects`, run via **File → Scripts → Run Script File…**
- Folders: user picks input (`.wav`) and output paths.
- Comp: uses `app.project.activeItem`; requires layer `Black Solid 1`; adds/configures Audio Spectrum + Glow (`ADBE AudSpect`, `ADBE Glo2` / legacy `ADBE Glow`) with name-based property matching and console logging on critical failures.
- Per-file: replace `CURRENT_AUDIO_LAYER`, import audio, match work area / comp duration, queue single RQ item, `queueInAME(true)`.

### D2 — Docs and tracking

- README converted to Markdown for easier reading in Git hosts and editors.
- Progress file established so future drafts (D3, D4, …) can append rows and short bullet notes without rewriting the full README.

### D3 — Comp rename + export name

- Before each `renderQueue.items.add`, the script sets `activeComp.name` from the WAV stem with `_V_` inserted at the last underscore; output file basename matches the comp.
- After the batch, the comp keeps the **last** processed file’s name unless you undo or rename manually.

### D4 — Correct Adobe effect IDs

- Script previously used incorrect strings from an informal guess; Adobe documents **Audio Spectrum** as `ADBE AudSpect` and **Glow** as `ADBE Glo2` (see first-party matchName list).

---

## How to update this file

When you change the project in a notable way:

1. Bump the draft ID (e.g. **D3**) and add a row to the **Draft log** table with date and one-line summary.
2. Under **Draft notes**, add a short subsection for that draft (what files changed, any breaking changes or manual steps).
