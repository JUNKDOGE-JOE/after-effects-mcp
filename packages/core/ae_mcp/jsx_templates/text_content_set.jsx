var resolved = resolveTextLayer(request._resolved);
var before = snapshot(request._resolved, resolved.layer);
if (before.text === request.text) {
    throw new Error("INVALID_ARGUMENT:text is unchanged");
}
var sourceText = resolved.sourceText;
var doc = sourceText.value;
beginWrite();
doc.text = request.text;
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
