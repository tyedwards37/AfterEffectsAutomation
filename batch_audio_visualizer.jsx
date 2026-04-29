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
     * Find first direct child property whose name contains any of the needles (case-insensitive).
     */
    function findPropertyContains(effectGroup, needles) {
        var n = effectGroup.numProperties;
        for (var i = 1; i <= n; i++) {
            var p = effectGroup.property(i);
            var nm = p.name.toLowerCase();
            for (var j = 0; j < needles.length; j++) {
                if (nm.indexOf(needles[j].toLowerCase()) >= 0) {
                    return p;
                }
            }
        }
        return null;
    }

    function findPropertyExact(effectGroup, names) {
        var n = effectGroup.numProperties;
        for (var i = 1; i <= n; i++) {
            var p = effectGroup.property(i);
            for (var j = 0; j < names.length; j++) {
                if (p.name === names[j]) {
                    return p;
                }
            }
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

    function getOrAddEffect(layer, matchName, displayNameForErrors) {
        var parade = layer.property("ADBE Effect Parade");
        if (!parade) {
            throw new Error("Could not access Effects on layer.");
        }
        var existing = parade.property(matchName);
        if (existing) {
            return existing;
        }
        if (!parade.canAddProperty(matchName)) {
            throw new Error("Cannot add effect " + matchName + " (" + displayNameForErrors + ").");
        }
        return parade.addProperty(matchName);
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
    // Configure Audio Spectrum (best-effort by property name)
    // -------------------------------------------------------------------------

    function configureAudioSpectrum(asEffect, audioLayer) {
        var ok = true;

        // Point spectrum at the new audio layer (layer index in the comp).
        var audioLayerProp =
            findPropertyExact(asEffect, ["Audio Layer"]) ||
            findPropertyContains(asEffect, ["audio layer"]);
        if (!setValueSafe(audioLayerProp, audioLayer.index, "Audio Layer")) {
            ok = false;
        }

        // Points
        if (!setValueSafe(findPropertyExact(asEffect, ["Start Point"]), [640, 360], "Start Point")) {
            if (!setValueSafe(findPropertyContains(asEffect, ["start point"]), [640, 360], "Start Point")) {
                ok = false;
            }
        }
        if (!setValueSafe(findPropertyExact(asEffect, ["End Point"]), [1280, 360], "End Point")) {
            if (!setValueSafe(findPropertyContains(asEffect, ["end point"]), [1280, 360], "End Point")) {
                ok = false;
            }
        }

        // Path = None (first menu entry is usually None; if wrong, adjust after reading log)
        var pathProp = findPropertyExact(asEffect, ["Path"]) || findPropertyContains(asEffect, ["path"]);
        if (pathProp && pathProp.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(pathProp, 1, "Path");
        }

        setValueSafe(findPropertyContains(asEffect, ["polar"]), false, "Use Polar Path");

        setValueSafe(findPropertyContains(asEffect, ["start frequency", "start freq"]), 200, "Start Frequency");
        setValueSafe(findPropertyContains(asEffect, ["end frequency", "end freq"]), 1000, "End Frequency");
        setValueSafe(findPropertyContains(asEffect, ["frequency bands", "bands"]), 40, "Frequency Bands");
        setValueSafe(findPropertyContains(asEffect, ["maximum height", "max height"]), 1000, "Maximum Height");

        // 50 ms — AE often stores time in seconds
        var audioDur =
            findPropertyExact(asEffect, ["Audio Duration"]) || findPropertyContains(asEffect, ["audio duration"]);
        if (audioDur) {
            if (!setValueSafe(audioDur, 0.05, "Audio Duration (as 0.05 sec)")) {
                setValueSafe(audioDur, 50, "Audio Duration (as raw 50 — if wrong, see README.md)");
            }
        }

        setValueSafe(findPropertyContains(asEffect, ["audio offset"]), 0, "Audio Offset");
        setValueSafe(findPropertyContains(asEffect, ["thickness"]), 10, "Thickness");

        // Softness 10% — try normalized then whole percent
        var soft = findPropertyContains(asEffect, ["softness"]);
        if (soft) {
            if (!setValueSafe(soft, 0.1, "Softness (0.1 = 10%)")) {
                setValueSafe(soft, 10, "Softness (10)");
            }
        }

        var white = [1, 1, 1];
        setValueSafe(findPropertyContains(asEffect, ["inside color"]), white, "Inside Color");
        setValueSafe(findPropertyContains(asEffect, ["outside color"]), white, "Outside Color");

        setValueSafe(findPropertyContains(asEffect, ["blend overlapping"]), false, "Blend Overlapping Colors");
        setValueSafe(findPropertyContains(asEffect, ["hue interpolation"]), 0, "Hue Interpolation");
        setValueSafe(findPropertyContains(asEffect, ["dynamic hue"]), false, "Dynamic Hue Phase");
        setValueSafe(findPropertyContains(asEffect, ["color symmetry"]), false, "Color Symmetry");

        // Display: Digital — enum index varies by version; try common English indices
        var disp = findPropertyContains(asEffect, ["display"]);
        if (disp && disp.propertyValueType === PropertyValueType.OneD) {
            if (!setValueSafe(disp, 2, "Display Options (Digital)")) {
                setValueSafe(disp, 3, "Display Options (Digital alt)");
            }
        }

        // Side A & B — common index 3 in English (depends on menu order)
        var side = findPropertyContains(asEffect, ["side"]);
        if (side && side.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(side, 3, "Side Options");
        }

        setValueSafe(findPropertyContains(asEffect, ["duration averaging"]), false, "Duration Averaging");
        setValueSafe(findPropertyContains(asEffect, ["composite on original"]), false, "Composite On Original");

        if (!ok) {
            logEffectPropertyNames(asEffect, "Audio Spectrum");
        }
        return ok;
    }

    // -------------------------------------------------------------------------
    // Configure Glow
    // -------------------------------------------------------------------------

    function configureGlow(glowEffect) {
        var ok = true;

        // "Glow Based On: Color Channels" — enum; 1 is often Color Channels vs Alpha
        var based = findPropertyContains(glowEffect, ["based on", "glow based"]);
        if (based && based.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(based, 1, "Glow Based On");
        }

        if (!setValueSafe(findPropertyContains(glowEffect, ["threshold"]), 60, "Glow Threshold (%)")) {
            ok = false;
        }
        if (!setValueSafe(findPropertyContains(glowEffect, ["radius"]), 30, "Glow Radius")) {
            ok = false;
        }
        if (!setValueSafe(findPropertyContains(glowEffect, ["intensity"]), 0.5, "Glow Intensity")) {
            ok = false;
        }

        // Composite Original: Behind
        var compOrig =
            findPropertyContains(glowEffect, ["composite original"]) ||
            findPropertyContains(glowEffect, ["composite"]);
        if (compOrig && compOrig.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(compOrig, 2, "Composite Original");
        }

        // Glow Operation: Add
        var op = findPropertyContains(glowEffect, ["operation", "glow operation"]);
        if (op && op.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(op, 1, "Glow Operation (Add)");
        }

        // Glow Colors: Original Colors
        var gc = findPropertyContains(glowEffect, ["glow colors"]);
        if (gc && gc.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(gc, 1, "Glow Colors");
        }

        // Color Looping: Triangle A>B>A
        var loopType = findPropertyContains(glowEffect, ["color looping", "looping"]);
        if (loopType && loopType.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(loopType, 3, "Color Looping");
        }

        setValueSafe(findPropertyContains(glowEffect, ["color loops"]), 1.0, "Color Loops");
        setValueSafe(findPropertyContains(glowEffect, ["color phase"]), 0, "Color Phase");
        setValueSafe(findPropertyContains(glowEffect, ["midpoint", "a & b"]), 50, "A & B Midpoint (%)");

        setValueSafe(findPropertyContains(glowEffect, ["color a"]), [1, 1, 1], "Color A");
        setValueSafe(findPropertyContains(glowEffect, ["color b"]), [0, 0, 0], "Color B");

        // Glow Dimensions: Horizontal and Vertical
        var dim = findPropertyContains(glowEffect, ["dimension"]);
        if (dim && dim.propertyValueType === PropertyValueType.OneD) {
            setValueSafe(dim, 1, "Glow Dimensions");
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
    var AUDIO_SPECTRUM_MATCH = "ADBE Aud Spectrum";
    var GLOW_MATCH = "ADBE Glow";

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
            asEffect = getOrAddEffect(vizLayer, AUDIO_SPECTRUM_MATCH, "Audio Spectrum");
            glowEffect = getOrAddEffect(vizLayer, GLOW_MATCH, "Glow");
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

                var asOk = configureAudioSpectrum(asEffect, audioLayer);
                var gOk = configureGlow(glowEffect);
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
