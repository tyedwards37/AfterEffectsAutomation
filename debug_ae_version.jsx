/**
 * debug_ae_version.jsx
 * Run: File > Scripts > Run Script File...
 * Shows After Effects version info useful when reporting bugs or checking docs.
 */
#target aftereffects

(function () {
    var lines = [];
    lines.push("After Effects");
    lines.push("version: " + app.version);
    if (typeof app.buildNumber !== "undefined" && app.buildNumber) {
        lines.push("buildNumber: " + app.buildNumber);
    }
    try {
        lines.push("language: " + app.isoLanguage);
    } catch (eLang) {
        lines.push("language: (not available)");
    }
    lines.push("OS: " + $.os);

    var item = app.project.activeItem;
    if (item && item instanceof CompItem) {
        lines.push("");
        lines.push("Active comp: " + item.name);
        lines.push("Size: " + item.width + " x " + item.height);
        lines.push("Duration (sec): " + item.duration.toFixed(3));
        lines.push("Layers: " + item.numLayers);
    } else {
        lines.push("");
        lines.push("No active composition (open a comp timeline first).");
    }

    alert(lines.join("\n"));
    $.writeln(lines.join("\n"));
})();
