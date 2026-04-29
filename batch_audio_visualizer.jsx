/**
 * batch_audio_visualizer.jsx
 *
 * Batch automation: for each .wav in a chosen folder, swap the comp audio,
 * configure Audio Spectrum + Glow on "Black Solid 1", match the work area
 * to the clip, then send one render to Adobe Media Encoder.
 *
 * Run from After Effects: File > Scripts > Run Script File...
 *
 * MANUAL ADJUSTMENT (AE / AME versions):
 * - Effect property *display names* and internal enums can differ slightly
 *   between After Effects versions or languages. If something looks wrong,
 *   check the debug log (Window > ExtendScript Toolkit or run from ESTK) or
 *   use the alerts this script shows when a property cannot be set.
 * - queueInAME() requires After Effects 14.0+ and Media Encoder 11.0+.
 * - Output format follows the file extension you set below and the Output
 *   Module template already on the queue item (often "Lossless" .mov vs
 *   H.264 .mp4). Match extension to a template your install supports.
 */

#target aftereffects

(function batchAudioVisualizer() {
    "use strict";

    // -------------------------------------------------------------------------
    // Small helpers (ES3-compatible)
    // -------------------------------------------------------------------------

    function joinFsPath(folder, fileName) {
        var base = folder instanceof Folder ? folder.fsName : String(folder);
        var sep = $.os.indexOf("Windows") >= 0 ? "\\" : "/";
        if (base.length && base.charAt(base.length - 1) !== sep && base.charAt(base.length - 1) !== "/") {
            return base + sep + fileName;
        }
        return base + fileName;
    }

    function getWavFiles(folder) {
        var all = folder.getFiles();
        var wavs = [];
        for (var i = 0; i < all.length; i++) {
            var f = all[i];
            if (f instanceof File && /\.wav$/i.test(f.name)) {
                wavs.push(f);
            }
        }
        wavs.sort(function (a, b) {
            if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
            if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
            return 0;
        });
        return wavs;
    }

    /**
     * From a WAV filename base (no extension): insert "_V_" between the last
     * "scene" segment and the trailing segment (often a take / reel id).
     * Example: TheGreyound_5B -> TheGreyound_V_5B
     * Split uses the last underscore; if there is none or it is invalid, returns baseName unchanged.
     */
    function wavBaseToCompVName(baseName) {
        if (!baseName || typeof baseName !== "string") {
            return baseName;
        }
        var last = baseName.lastIndexOf("_");
        if (last < 1 || last >= baseName.length - 1) {
            return baseName;
        }
        return baseName.substring(0, last) + "_V_" + baseName.substring(last + 1);
    }

    /** Characters not allowed in After Effects comp names (and risky in output paths). */
    function sanitizeExportName(name) {
        return name.replace(/[\\\/:\*\?"<>\|]/g, "-");
    }

    function logLine(msg) {
        $.writeln(msg);
    }

    /**
     * Lists every property on an effect (name + matchName) for debugging.
     * The prompt asked for this when names differ by AE version.
     */
    function logEffectPropertyNames(effect, effectLabel) {
        logLine("---- " + effectLabel + " properties (index : name : matchName) ----");
        try {
            var n = effect.numProperties;
            for (var i = 1; i <= n; i++) {
                var p = effect.property(i);
                logLine(i + " : " + p.name + " : " + p.matchName);
            }
        } catch (e) {
            logLine("Could not enumerate properties: " + e.toString());
        }
        logLine("---- end " + effectLabel + " ----");
    }

    /**
     * English Effect Controls names, case-insensitive. Prefer this over
     * substring search so we do not bind the wrong control (e.g. "path" in "Polar Path").
     */
    function findPropertyNameCI(effectGroup, names) {
        var n = effectGroup.numProperties;
        for (var i = 1; i <= n; i++) {
            var p = effectGroup.property(i);
            var pn = p.name.toLowerCase();
            for (var j = 0; j < names.length; j++) {
                if (pn === names[j].toLowerCase()) {
                    return p;
                }
            }
        }
        return null;
    }

    /** First property whose name starts with prefix (case-insensitive), e.g. "Start Frequency" vs "Start Frequency (Hz)". */
    function findPropertyNamePrefixCI(effectGroup, prefix) {
        var pref = prefix.toLowerCase();
        var n = effectGroup.numProperties;
        for (var i = 1; i <= n; i++) {
            var p = effectGroup.property(i);
            if (p.name.toLowerCase().indexOf(pref) === 0) {
                return p;
            }
        }
        return null;
    }

    function findParamFlexible(effectGroup, exactNames, prefixFallback) {
        var r = findPropertyNameCI(effectGroup, exactNames);
        if (r) {
            return r;
        }
        if (prefixFallback) {
            return findPropertyNamePrefixCI(effectGroup, prefixFallback);
        }
        return null;
    }

    function setValueSafe(prop, value, label) {
        if (!prop) {
            return false;
        }
        try {
            prop.setValue(value);
            return true;
        } catch (e) {
            logLine('Failed to set "' + label + '" (' + (prop ? prop.name : "?") + "): " + e.toString());
            return false;
        }
    }

    /** Try 1-based dropdown indices until setValue succeeds (does not verify label text). */
    function setOneDEnumFirstWorking(prop, candidateIndices, label) {
        if (!prop || prop.propertyValueType !== PropertyValueType.OneD) {
            return false;
        }
        for (var i = 0; i < candidateIndices.length; i++) {
            if (setValueSafe(prop, candidateIndices[i], label + " idx " + candidateIndices[i])) {
                return true;
            }
        }
        return false;
    }

    function clearRenderQueue(project) {
        while (project.renderQueue.numItems > 0) {
            project.renderQueue.item(project.renderQueue.numItems).remove();
        }
    }

    function removeAudioLayerAndFootage(comp, layerName) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var lyr = comp.layer(i);
            if (lyr.name !== layerName) {
                continue;
            }
            var src = null;
            try {
                src = lyr.source;
            } catch (e1) {
                src = null;
            }
            lyr.remove();
            if (src && src instanceof FootageItem) {
                try {
                    src.remove();
                } catch (e2) {
                    logLine("Note: could not remove footage item (may still be in use): " + String(e2));
                }
            }
            break;
        }
    }

    /**
     * Finds an existing effect by matchName, or adds the first matchName that
     * canAddProperty allows. Order matters: list current Adobe IDs first, then
     * legacy fallbacks for older AE.
     * Official list: https://ae-scripting.docsforadobe.dev/matchnames/effects/firstparty/
     * (Audio Spectrum is ADBE AudSpect — not "ADBE Aud Spectrum". Glow is ADBE Glo2 in modern AE.)
     */
    function getOrAddEffectFromCandidates(layer, matchNames, displayNameForErrors) {
        var parade = layer.property("ADBE Effect Parade");
        if (!parade) {
            throw new Error("Could not access Effects on layer.");
        }
        var m;
        for (m = 0; m < matchNames.length; m++) {
            var existing = parade.property(matchNames[m]);
            if (existing) {
                return existing;
            }
        }
        for (m = 0; m < matchNames.length; m++) {
            var mn = matchNames[m];
            if (parade.canAddProperty(mn)) {
                return parade.addProperty(mn);
            }
        }
        throw new Error(
            "Cannot add effect (" +
                displayNameForErrors +
                "). Tried matchNames: " +
                matchNames.join(", ") +
                ". Use a layer that accepts effects (e.g. Layer > New > Solid), not a guide-only or unsupported type."
        );
    }

    /**
     * Returns audio duration in seconds for a footage-backed layer.
     */
    function getAudioDurationSeconds(audioLayer) {
        var src = audioLayer.source;
        if (!src || !(src instanceof FootageItem)) {
            return audioLayer.outPoint - audioLayer.inPoint;
        }
        var d = src.duration;
        if (typeof d === "number" && d > 0) {
            return d;
        }
        return audioLayer.outPoint - audioLayer.inPoint;
    }

    // -------------------------------------------------------------------------
    // Configure Audio Spectrum — matches your spec (English Effect Controls names)
    // Start/End 640,360 → 1280,360 | 200–1000 Hz | 40 bands | max height 1000 |
    // Audio Duration 50 | Offset 0 | Thickness 10 | Softness 10% |
    // Display: Digital | Side: Side A & B
    // Dropdowns use 1-based menu indices; if your AE build orders menus differently,
    // change SPECTRUM_DISPLAY_DIGITAL_INDEX / SPECTRUM_SIDE_A_AND_B_INDEX before the loop.
    // -------------------------------------------------------------------------

    function configureAudioSpectrum(asEffect, audioLayer, displayDigitalIndex, sideABIndex) {
        var ok = true;
        function pf(exactNames, prefixFallback) {
            return findParamFlexible(asEffect, exactNames, prefixFallback);
        }

        var al = findPropertyNameCI(asEffect, ["Audio Layer"]);
        if (!setValueSafe(al, audioLayer.index, "Audio Layer")) {
            ok = false;
        }

        if (!setValueSafe(pf(["Start Point"], "Start Point"), [640, 360], "Start Point")) {
            ok = false;
        }
        if (!setValueSafe(pf(["End Point"], "End Point"), [1280, 360], "End Point")) {
            ok = false;
        }

        setValueSafe(pf(["Start Frequency"], "Start Frequency"), 200, "Start Frequency");
        setValueSafe(pf(["End Frequency"], "End Frequency"), 1000, "End Frequency");
        setValueSafe(pf(["Frequency Bands"], "Frequency Bands"), 40, "Frequency Bands");
        setValueSafe(pf(["Maximum Height"], "Maximum Height"), 1000, "Maximum Height");

        var audioDur = pf(["Audio Duration"], "Audio Duration");
        if (audioDur) {
            if (!setValueSafe(audioDur, 50, "Audio Duration (50)")) {
                setValueSafe(audioDur, 0.05, "Audio Duration (fallback 0.05 s)");
            }
        }

        setValueSafe(pf(["Audio Offset"], "Audio Offset"), 0, "Audio Offset");
        setValueSafe(pf(["Thickness"], "Thickness"), 10, "Thickness");

        var soft = pf(["Softness"], "Softness");
        if (soft) {
            if (!setValueSafe(soft, 10, "Softness (10 percent)")) {
                setValueSafe(soft, 0.1, "Softness (fallback 0.1)");
            }
        }

        var disp = pf(["Display Options"], "Display Options");
        if (disp && disp.propertyValueType === PropertyValueType.OneD) {
            if (!setValueSafe(disp, displayDigitalIndex, "Display Options (Digital index)")) {
                setOneDEnumFirstWorking(disp, [3, 1, 2, 4], "Display Options");
            }
        }

        var side = pf(["Side Options"], "Side Options");
        if (side && side.propertyValueType === PropertyValueType.OneD) {
            if (!setValueSafe(side, sideABIndex, "Side Options (A & B index)")) {
                setOneDEnumFirstWorking(side, [3, 2, 1], "Side Options");
            }
        }

        if (!ok) {
            logEffectPropertyNames(asEffect, "Audio Spectrum");
        }
        return ok;
    }

    // -------------------------------------------------------------------------
    // Configure Glow — only the controls you listed (threshold, radius, intensity,
    // composite behind, operation add). Enum indices: edit before the batch loop if needed.
    // -------------------------------------------------------------------------

    function configureGlow(glowEffect, compositeBehindIndices, addOpIndices) {
        var ok = true;
        function pf(exactNames, prefixFallback) {
            return findParamFlexible(glowEffect, exactNames, prefixFallback);
        }

        if (!setValueSafe(pf(["Glow Threshold"], "Glow Threshold"), 60, "Glow Threshold")) {
            ok = false;
        }
        if (!setValueSafe(pf(["Glow Radius"], "Glow Radius"), 30, "Glow Radius")) {
            ok = false;
        }
        if (!setValueSafe(pf(["Glow Intensity"], "Glow Intensity"), 0.5, "Glow Intensity")) {
            ok = false;
        }

        var compOrig = pf(["Composite Original"], "Composite Original");
        if (compOrig && compOrig.propertyValueType === PropertyValueType.OneD) {
            setOneDEnumFirstWorking(compOrig, compositeBehindIndices, "Composite Original (Behind)");
        }

        var gop = pf(["Glow Operation"], "Glow Operation");
        if (gop && gop.propertyValueType === PropertyValueType.OneD) {
            setOneDEnumFirstWorking(gop, addOpIndices, "Glow Operation (Add)");
        }

        if (!ok) {
            logEffectPropertyNames(glowEffect, "Glow");
        }
        return ok;
    }

    // -------------------------------------------------------------------------
    // Main
    // -------------------------------------------------------------------------

    var CURRENT_AUDIO_LAYER_NAME = "CURRENT_AUDIO_LAYER";
    var VISUALIZER_LAYER_NAME = "Black Solid 1";
    var AUDIO_SPECTRUM_IDS = ["ADBE AudSpect"];
    var GLOW_IDS = ["ADBE Glo2", "ADBE Glow"];

    try {
        if (!app.project) {
            alert("Error: No After Effects project is available.");
            return;
        }

        var activeComp = app.project.activeItem;
        if (!activeComp || !(activeComp instanceof CompItem)) {
            alert(
                "Error: No active composition.\n\n" +
                    "Click the composition in the Project panel or open its timeline so it becomes the active item, then run the script again."
            );
            return;
        }

        var inputFolder = Folder.selectDialog("Select the folder that contains your .wav files");
        if (!inputFolder) {
            alert("Cancelled: no input folder selected.");
            return;
        }

        var outputFolder = Folder.selectDialog("Select the folder where rendered videos should be saved");
        if (!outputFolder) {
            alert("Cancelled: no output folder selected.");
            return;
        }

        var wavFiles = getWavFiles(inputFolder);
        if (!wavFiles.length) {
            alert("Error: No .wav files were found in:\n" + inputFolder.fsName);
            return;
        }

        var vizLayer = null;
        try {
            vizLayer = activeComp.layer(VISUALIZER_LAYER_NAME);
        } catch (eFind) {
            vizLayer = null;
        }
        if (!vizLayer) {
            alert(
                "Error: Could not find a layer named \"" +
                    VISUALIZER_LAYER_NAME +
                    "\".\n\n" +
                    "Rename your visualizer solid to match, or edit VISUALIZER_LAYER_NAME near the bottom of batch_audio_visualizer.jsx."
            );
            return;
        }

        var asEffect;
        var glowEffect;
        try {
            asEffect = getOrAddEffectFromCandidates(vizLayer, AUDIO_SPECTRUM_IDS, "Audio Spectrum");
            glowEffect = getOrAddEffectFromCandidates(vizLayer, GLOW_IDS, "Glow");
        } catch (eEff) {
            alert("Error adding or locating effects:\n" + eEff.toString());
            return;
        }

        if (typeof app.project.renderQueue.queueInAME !== "function") {
            alert(
                "Error: queueInAME is not available in this After Effects version.\n\n" +
                    "You need After Effects 14.0 or newer and a compatible Adobe Media Encoder install. See README.md."
            );
            return;
        }

        // Tuning: 1-based menu indices for Display / Side / Glow (English UI). If a menu
        // lands on the wrong option, count items top-to-bottom in Effect Controls and edit.
        var SPECTRUM_DISPLAY_DIGITAL_INDEX = 3;
        var SPECTRUM_SIDE_A_AND_B_INDEX = 3;
        var GLOW_COMPOSITE_BEHIND_INDICES = [2, 3, 1];
        var GLOW_OPERATION_ADD_INDICES = [2, 1, 3, 4, 5];

        var processed = 0;
        var failed = 0;

        for (var w = 0; w < wavFiles.length; w++) {
            var wavFile = wavFiles[w];
            app.beginUndoGroup("Batch audio: " + wavFile.name);

            try {
                removeAudioLayerAndFootage(activeComp, CURRENT_AUDIO_LAYER_NAME);

                var io = new ImportOptions(wavFile);
                io.importAs = ImportAsType.FOOTAGE;
                var footage = app.project.importFile(io);
                if (!footage) {
                    throw new Error("importFile returned null for " + wavFile.fsName);
                }

                var audioLayer = activeComp.layers.add(footage);
                audioLayer.name = CURRENT_AUDIO_LAYER_NAME;
                audioLayer.startTime = 0;
                audioLayer.inPoint = 0;

                var durSec = getAudioDurationSeconds(audioLayer);
                if (durSec <= 0) {
                    durSec = 1;
                }
                audioLayer.outPoint = audioLayer.inPoint + durSec;

                activeComp.workAreaStart = 0;
                activeComp.workAreaDuration = durSec;

                // Many exports key off comp duration; stretch comp to match audio when possible.
                try {
                    activeComp.duration = durSec;
                } catch (eDur) {
                    logLine("Note: could not set comp.duration (" + eDur.toString() + "); work area still set.");
                }

                var asOk = configureAudioSpectrum(
                    asEffect,
                    audioLayer,
                    SPECTRUM_DISPLAY_DIGITAL_INDEX,
                    SPECTRUM_SIDE_A_AND_B_INDEX
                );
                var gOk = configureGlow(glowEffect, GLOW_COMPOSITE_BEHIND_INDICES, GLOW_OPERATION_ADD_INDICES);
                if (!asOk) {
                    alert(
                        "Warning: Some Audio Spectrum properties may not have applied.\n" +
                            "Check the log for property names. File: " +
                            wavFile.name
                    );
                }
                if (!gOk) {
                    alert("Warning: Some Glow properties may not have applied.\nCheck the log. File: " + wavFile.name);
                }

                var baseName = wavFile.name.replace(/\.wav$/i, "");
                var compExportName = sanitizeExportName(wavBaseToCompVName(baseName));
                try {
                    activeComp.name = compExportName;
                } catch (eName) {
                    throw new Error("Could not rename composition to \"" + compExportName + "\": " + eName.toString());
                }
                logLine("Composition renamed for export: " + compExportName + " (from wav base: " + baseName + ")");

                clearRenderQueue(app.project);

                var rqItem = app.project.renderQueue.items.add(activeComp);
                rqItem.workAreaOnly = true;

                var outPath = joinFsPath(outputFolder, compExportName + ".mp4");
                var outFile = new File(outPath);

                var om = rqItem.outputModule(1);
                om.file = outFile;

                // Mark as queued where supported so canQueueInAME is true
                try {
                    rqItem.status = RQItemStatus.QUEUED;
                } catch (eStat) {
                    // Older builds: status may be read-only; queueInAME may still work after output path set
                }

                if (app.project.renderQueue.canQueueInAME !== true) {
                    throw new Error(
                        "Adobe Media Encoder queueing failed: renderQueue.canQueueInAME is false.\n" +
                            "Usually the output module still needs a valid path or template. Pick a preset in the Render Queue, or see README.md."
                    );
                }

                try {
                    app.project.renderQueue.queueInAME(true);
                } catch (eAme) {
                    throw new Error("queueInAME threw an error: " + eAme.toString());
                }

                processed++;
                logLine("Queued in AME: " + wavFile.name + " -> " + outPath);
            } catch (eLoop) {
                failed++;
                alert("Failed on file: " + wavFile.name + "\n\n" + eLoop.toString());
                logLine("ERROR: " + wavFile.name + " : " + eLoop.toString());
            } finally {
                app.endUndoGroup();
            }
        }

        alert(
            "Batch finished.\n\n" +
                "WAV files found: " +
                wavFiles.length +
                "\n" +
                "Successfully queued: " +
                processed +
                "\n" +
                "Failed: " +
                failed +
                "\n\n" +
                "If a property did not stick, run once with ExtendScript Toolkit / console open to read property name dumps."
        );
    } catch (eTop) {
        alert("Fatal error:\n" + eTop.toString());
    }
})();
