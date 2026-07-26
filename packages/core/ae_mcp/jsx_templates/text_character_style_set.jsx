var resolved = resolveTextLayer(request._resolved);
var before = snapshot(request._resolved, resolved.layer);
var sourceText = resolved.sourceText;
var doc = sourceText.value;
var style = request.style;
var fontResolution = null;
var changed = false;
if (style.font !== null && style.font !== undefined) {
    fontResolution = resolveFont(style.font);
    changed = changed ||
        before.characterStyle.fontPostScriptName !== fontResolution.selected;
}
if (style.font_size_pixels !== null && style.font_size_pixels !== undefined) {
    changed = changed ||
        Number(before.characterStyle.fontSizePixels) !== Number(style.font_size_pixels);
}
if (style.fill_color !== null && style.fill_color !== undefined) {
    changed = changed ||
        JSON.stringify(before.characterStyle.fillColor) !== JSON.stringify(style.fill_color);
}
if (style.stroke_color !== null && style.stroke_color !== undefined) {
    changed = changed ||
        JSON.stringify(before.characterStyle.strokeColor) !== JSON.stringify(style.stroke_color);
}
if (style.stroke_width_pixels !== null && style.stroke_width_pixels !== undefined) {
    changed = changed ||
        Number(before.characterStyle.strokeWidthPixels) !==
            Number(style.stroke_width_pixels);
}
if (style.stroke_over_fill !== null && style.stroke_over_fill !== undefined) {
    changed = changed ||
        before.characterStyle.strokeOverFill !== style.stroke_over_fill;
}
if (style.tracking !== null && style.tracking !== undefined) {
    changed = changed || before.characterStyle.tracking !== style.tracking;
}
if (style.auto_leading !== null && style.auto_leading !== undefined) {
    changed = changed || before.characterStyle.autoLeading !== style.auto_leading;
}
if (style.leading_pixels !== null && style.leading_pixels !== undefined) {
    changed = changed ||
        Number(before.characterStyle.leadingPixels) !== Number(style.leading_pixels);
}
if (style.faux_bold !== null && style.faux_bold !== undefined) {
    changed = changed || before.characterStyle.fauxBold !== style.faux_bold;
}
if (style.faux_italic !== null && style.faux_italic !== undefined) {
    changed = changed || before.characterStyle.fauxItalic !== style.faux_italic;
}
if (!changed) {
    throw new Error("INVALID_ARGUMENT:character style is unchanged");
}
beginWrite();
if (fontResolution) {
    doc.font = fontResolution.selected;
}
if (style.font_size_pixels !== null && style.font_size_pixels !== undefined) {
    doc.fontSize = Number(style.font_size_pixels);
}
if (style.fill_color !== null && style.fill_color !== undefined) {
    doc.fillColor = rgb(style.fill_color);
}
if (style.stroke_color !== null && style.stroke_color !== undefined) {
    doc.strokeColor = rgb(style.stroke_color);
}
if (style.stroke_width_pixels !== null && style.stroke_width_pixels !== undefined) {
    doc.strokeWidth = Number(style.stroke_width_pixels);
}
if (style.stroke_over_fill !== null && style.stroke_over_fill !== undefined) {
    doc.strokeOverFill = style.stroke_over_fill;
}
if (style.tracking !== null && style.tracking !== undefined) {
    doc.tracking = style.tracking;
}
if (style.auto_leading !== null && style.auto_leading !== undefined) {
    doc.autoLeading = style.auto_leading;
}
if (style.leading_pixels !== null && style.leading_pixels !== undefined) {
    doc.leading = Number(style.leading_pixels);
}
if (style.faux_bold !== null && style.faux_bold !== undefined) {
    doc.fauxBold = style.faux_bold;
}
if (style.faux_italic !== null && style.faux_italic !== undefined) {
    doc.fauxItalic = style.faux_italic;
}
markMutation();
sourceText.setValue(doc);
var after = snapshot(
    request._resolved,
    resolved.layer,
    fontResolution ? fontResolution.requested : undefined,
    fontResolution ? fontResolution.usedFallback : false
);
app.endUndoGroup();
undoOpen = false;
return JSON.stringify({
    ok: true,
    value: {
        changed: true,
        _address: after._address,
        before: before,
        after: after
    }
});
