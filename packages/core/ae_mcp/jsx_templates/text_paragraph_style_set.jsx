var resolved = resolveTextLayer(request._resolved);
var before = snapshot(request._resolved, resolved.layer);
var sourceText = resolved.sourceText;
var doc = sourceText.value;
var style = request.style;
var changed = false;
if (style.justification !== null && style.justification !== undefined) {
    changed = changed ||
        before.paragraphStyle.justification !== style.justification;
}
if (style.first_line_indent_pixels !== null &&
        style.first_line_indent_pixels !== undefined) {
    changed = changed ||
        Number(before.paragraphStyle.firstLineIndentPixels) !==
            Number(style.first_line_indent_pixels);
}
if (style.start_indent_pixels !== null && style.start_indent_pixels !== undefined) {
    changed = changed ||
        Number(before.paragraphStyle.startIndentPixels) !==
            Number(style.start_indent_pixels);
}
if (style.end_indent_pixels !== null && style.end_indent_pixels !== undefined) {
    changed = changed ||
        Number(before.paragraphStyle.endIndentPixels) !==
            Number(style.end_indent_pixels);
}
if (style.space_before_pixels !== null &&
        style.space_before_pixels !== undefined) {
    changed = changed ||
        Number(before.paragraphStyle.spaceBeforePixels) !==
            Number(style.space_before_pixels);
}
if (style.space_after_pixels !== null && style.space_after_pixels !== undefined) {
    changed = changed ||
        Number(before.paragraphStyle.spaceAfterPixels) !==
            Number(style.space_after_pixels);
}
if (!changed) {
    throw new Error("INVALID_ARGUMENT:paragraph style is unchanged");
}
beginWrite();
if (style.justification !== null && style.justification !== undefined) {
    doc.justification = justificationValue(style.justification);
}
if (style.first_line_indent_pixels !== null &&
        style.first_line_indent_pixels !== undefined) {
    doc.firstLineIndent = Number(style.first_line_indent_pixels);
}
if (style.start_indent_pixels !== null && style.start_indent_pixels !== undefined) {
    doc.startIndent = Number(style.start_indent_pixels);
}
if (style.end_indent_pixels !== null && style.end_indent_pixels !== undefined) {
    doc.endIndent = Number(style.end_indent_pixels);
}
if (style.space_before_pixels !== null &&
        style.space_before_pixels !== undefined) {
    doc.spaceBefore = Number(style.space_before_pixels);
}
if (style.space_after_pixels !== null && style.space_after_pixels !== undefined) {
    doc.spaceAfter = Number(style.space_after_pixels);
}
markMutation();
sourceText.setValue(doc);
var after = snapshot(request._resolved, resolved.layer);
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
