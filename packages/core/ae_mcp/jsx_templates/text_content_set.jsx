var resolved = resolveTextLayer(request.target);
var before = snapshot(request.target, resolved.layer);
if (before.text === request.text) {
    throw new Error("INVALID_ARGUMENT:text is unchanged");
}
var sourceText = resolved.sourceText;
var doc = sourceText.value;
beginWrite();
doc.text = request.text;
markMutation();
sourceText.setValue(doc);
var after = snapshot(request.target, resolved.layer);
app.endUndoGroup();
undoOpen = false;
return JSON.stringify({
    ok: true,
    value: {
        changed: true,
        target: after.target,
        before: before,
        after: after
    }
});
