# After Effects batch audio visualizer

This folder contains a script that drives an existing After Effects template so each `.wav` file in a folder is imported, wired to the Audio Spectrum effect on **Black Solid 1**, and sent to Adobe Media Encoder one file at a time.

| File | Purpose |
|------|---------|
| `batch_audio_visualizer.jsx` | Main automation (ExtendScript / JSX) |
| `debug_ae_version.jsx` | Optional: shows AE version, language, OS, and active comp size (run like any other script) |
| `README.md` | This guide |
| `PROGRESS.md` | Draft / version notes for the project |

---

## 1. Open your After Effects template

1. Launch After Effects.
2. Open your template project (**File → Open**).
3. Open the main composition you want to render (double-click it so its timeline is visible). The script uses whatever composition is currently **active** in After Effects (`activeItem`).
4. Save the project if you like (recommended before long batches).

---

## 2. Prepare the composition

The script expects:

- A solid (or layer) named exactly: **`Black Solid 1`**

That layer should carry your visualizer look. The script will:

- Ensure the built-in effects **Audio Spectrum** and **Glow** exist on that layer (Adobe matchNames: `ADBE AudSpect`, `ADBE Glo2`; older AE may still use `ADBE Glow`). The script adds them if they are missing.
- Apply settings that match the design brief in `prompt.txt` (with best-effort property matching across AE versions).

If your layer has a different name, either rename the layer in the timeline to `Black Solid 1` or edit the variable `VISUALIZER_LAYER_NAME` inside `batch_audio_visualizer.jsx` to match your layer name.

---

## 3. Run the script

1. With the correct composition active (timeline open), choose **File → Scripts → Run Script File…**
2. Select **`batch_audio_visualizer.jsx`**
3. When prompted, choose:
   - **Input folder** — contains your `.wav` files  
   - **Output folder** — where finished videos should be written  

The script processes every `.wav` in the input folder (non-recursive: only files directly inside that folder).

**Composition and export naming:** For each file, the **active composition is renamed** before queueing so exports stay in sync with the comp. The new name is derived from the WAV base name by inserting **`_V_`** before the last segment (split on the **last** underscore). Example: `TheGreyound_5B.wav` → comp and output base name `TheGreyound_V_5B` → `TheGreyound_V_5B.mp4`. If the base name has no underscore, the name is left unchanged (aside from sanitizing illegal characters).

Output filenames use that same base name with a `.mp4` extension (see the next section about codecs).

---

## 4. Adobe Media Encoder (AME) export settings

The script uses:

- `app.project.renderQueue.items.add(activeComp)`
- Sets the first output module’s file path to: `[output folder]/[renamed comp base].mp4` (same pattern as the comp name above)
- Sets the render queue item to use the composition work area
- Calls `app.project.renderQueue.queueInAME(true)`

**Important**

- `queueInAME(true)` tells Media Encoder to start working on its queue right away. With `true`, you may not get a pause to tweak the preset for each job; AME often applies the last-used encoding preset for that workflow.
- The file extension (`.mp4` here) helps After Effects pick a format, but the **output module template** still matters. If your default template cannot write MP4, either change the extension in the script to something your template supports (for example `.mov`) or set a suitable default output module template in the Render Queue before running the script.

**Requirements**

- After Effects **14.0** or newer for `queueInAME`
- Adobe Media Encoder **11.0** or newer, installed and compatible with your AE

After the first run, open Adobe Media Encoder and confirm:

- Preset (codec, bitrate, resolution, frame rate)
- Audio export options (if you need audio in the final deliverable)
- Output file names and locations match what you expect

---

## 5. What the script does (short overview)

For each `.wav`:

1. Deletes the previous layer named **`CURRENT_AUDIO_LAYER`** (if any) and tries to remove its footage item from the project.
2. Imports the new `.wav` and adds it to the active composition.
3. Renames that layer to **`CURRENT_AUDIO_LAYER`**.
4. Sets `workAreaStart = 0` and `workAreaDuration` to the audio clip length; also attempts to set the composition duration to the same length.
5. Points Audio Spectrum’s “Audio Layer” style control at the new layer.
6. Clears the After Effects render queue, adds a single item for the comp, assigns the output file path, then sends that item to AME.

---

## 6. Troubleshooting

| Issue | What to try |
|--------|-------------|
| **No active composition** | Click the composition in the Project panel or open its tab so AE treats it as the active item, then run the script again. |
| **No .wav files were found** | Put `.wav` files directly in the folder you selected (not only in subfolders). Check the extension spelling. |
| **Could not find Black Solid 1** | Rename the visualizer layer to match, or edit `VISUALIZER_LAYER_NAME` in the `.jsx` file. |
| **Cannot add effect (Audio Spectrum / Glow)** | Use a normal **Solid** (or other layer that accepts effects). If the error lists wrong matchNames, your script may be outdated — current IDs are `ADBE AudSpect` and `ADBE Glo2` per [Adobe’s effect matchName list](https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/). |
| **`canQueueInAME` is false** / queue errors | Pick a valid output module template in the Render Queue once manually, then rerun. Ensure the output path is writable. Install/update Media Encoder so its major version matches your AE generation. |
| **Effect settings look wrong** | The script sets Audio Spectrum / Glow using **English** Effect Controls names (case-insensitive) so the right sliders move. **Display Options**, **Side Options**, **Composite Original**, and **Glow Operation** are menus stored as **1-based indices**; if your build orders items differently, edit `SPECTRUM_DISPLAY_DIGITAL_INDEX`, `SPECTRUM_SIDE_A_AND_B_INDEX`, `GLOW_COMPOSITE_BEHIND_INDICES`, and `GLOW_OPERATION_ADD_INDICES` in `batch_audio_visualizer.jsx` (search for “Tuning:”). For property names, run `debug_ae_version.jsx` and check the console, or log effect property names when the script warns. |
| **Only the first file looks correct** | Watch the AME queue: each job should reference a different output filename. If AME reuses a locked file, change the output folder or close prior exports. |
| **Undo** | Each file is wrapped in an undo group named `Batch audio: [filename]`. You can step backward in AE if something went wrong mid-batch. |
| **Export is all black / no spectrum** | See [Black render / missing visualizer](#black-render--missing-visualizer) below. |

### Find your After Effects version

- **macOS:** menu **After Effects → About After Effects** (version and build are shown in the dialog).
- **Windows:** menu **Help → About After Effects**.

You can also run **`debug_ae_version.jsx`** (**File → Scripts → Run Script File…**). It alerts `app.version` (and build when available), UI language, OS, plus the **active comp** width × height and duration — useful because the batch script hard-codes Audio Spectrum **Start Point** / **End Point** for a 1280×720-style frame; a different comp size can push the spectrum off-screen or into a corner.

### Black render / missing visualizer

Work through these in order with the **same comp** the script uses (after a batch run, or by importing one WAV manually):

1. **Audio Layer on Audio Spectrum** — Select **Black Solid 1**, open **Effect Controls**, and confirm **Audio Layer** is set to **`CURRENT_AUDIO_LAYER`** (not *None* or an old layer). If it is wrong, the spectrum often draws nothing useful.
2. **Solo / mute / shy** — Make sure **Black Solid 1** is not muted, not hidden (eyeball), and that no **solo** state is hiding it. Check nothing **above** it is a full-frame opaque layer blocking the view.
3. **Comp size vs Start / End Point** — The script sets Start **(640, 360)** and End **(1280, 360)** (horizontal line across the middle of a **1280×720** comp). If your comp is **1920×1080**, 4K, or **vertical**, that line may sit off-center or partly outside the frame; adjust those two properties to span your comp (e.g. left–right through the middle at half the comp height).
4. **RAM preview** — Press **0** (numpad) or use the **Preview** panel with audio on. If preview is black too, the issue is in the comp/effects, not only AME.
5. **AME / codec** — In Media Encoder, open the completed job’s **Export settings** and confirm you are not exporting only an alpha channel or an empty audio-only preset by mistake.

---

## 7. Safety notes

- Back up your project before automating long batches.
- The script sets composition duration when possible; if your template has expressions or locked structure, verify timing after the first file.
