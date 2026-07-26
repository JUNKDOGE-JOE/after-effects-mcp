(function () {
    var request = __AEMCP_TEXT_REQUEST__;
    var mutationStarted = false;
    var undoOpen = false;

    function fail(code, message, sideEffect, action, hint, details) {
        return JSON.stringify({
            ok: false,
            error: {
                code: code,
                message: String(message).slice(0, 512),
                retryable: false,
                sideEffect: sideEffect,
                recovery: {
                    action: action,
                    hint: String(hint).slice(0, 256)
                },
                details: details || undefined
            }
        });
    }

    function required(value, field) {
        if (value === undefined) {
            throw new Error("TEXT_CONTRACT_FIELD:" + field);
        }
        return value;
    }

    function decimal(value) {
        if (!isFinite(value)) {
            throw new Error("TEXT_CONTRACT_NONFINITE");
        }
        if (value === 0) {
            return "0";
        }
        return String(value);
    }

    function color8(value, field) {
        required(value, field);
        if (!(value instanceof Array) || value.length < 3) {
            throw new Error("TEXT_CONTRACT_FIELD:" + field);
        }
        return {
            red: Math.max(0, Math.min(255, Math.round(value[0] * 255))),
            green: Math.max(0, Math.min(255, Math.round(value[1] * 255))),
            blue: Math.max(0, Math.min(255, Math.round(value[2] * 255))),
            alpha: 255
        };
    }

    function rgb(value) {
        return [value.red / 255, value.green / 255, value.blue / 255];
    }

    function resolveComp(address) {
        var comp = null;
        try {
            comp = app.project.item(Number(address.project_item_index));
        } catch (ignore) {
            comp = null;
        }
        if (!comp || !(comp instanceof CompItem) ||
                comp.name !== address.expected_name) {
            throw new Error("STALE_TARGET:composition");
        }
        return comp;
    }

    function resolveTextLayer(address) {
        var comp = resolveComp(address);
        var layer = null;
        try {
            layer = AEMCP.layerById(comp, Number(address.layer_index));
        } catch (ignore) {
            layer = null;
        }
        if (!layer || layer.name !== address.expected_layer_name) {
            throw new Error("STALE_TARGET:layer");
        }
        var textProperties = layer.property("ADBE Text Properties");
        var sourceText = textProperties &&
            textProperties.property("ADBE Text Document");
        if (!sourceText || sourceText.propertyValueType === PropertyValueType.NO_VALUE) {
            throw new Error("STALE_TARGET:not-text");
        }
        return {
            comp: comp,
            layer: layer,
            sourceText: sourceText
        };
    }

    function justificationName(value) {
        var pairs = [
            [ParagraphJustification.LEFT_JUSTIFY, "left"],
            [ParagraphJustification.RIGHT_JUSTIFY, "right"],
            [ParagraphJustification.CENTER_JUSTIFY, "center"],
            [ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT, "full-last-left"],
            [ParagraphJustification.FULL_JUSTIFY_LASTLINE_RIGHT, "full-last-right"],
            [ParagraphJustification.FULL_JUSTIFY_LASTLINE_CENTER, "full-last-center"],
            [ParagraphJustification.FULL_JUSTIFY_LASTLINE_FULL, "full-last-full"]
        ];
        var index;
        for (index = 0; index < pairs.length; index += 1) {
            if (value === pairs[index][0]) {
                return pairs[index][1];
            }
        }
        throw new Error("UNREPRESENTABLE_TEXT_STYLE:justification");
    }

    function justificationValue(value) {
        var values = {
            "left": ParagraphJustification.LEFT_JUSTIFY,
            "right": ParagraphJustification.RIGHT_JUSTIFY,
            "center": ParagraphJustification.CENTER_JUSTIFY,
            "full-last-left": ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT,
            "full-last-right": ParagraphJustification.FULL_JUSTIFY_LASTLINE_RIGHT,
            "full-last-center": ParagraphJustification.FULL_JUSTIFY_LASTLINE_CENTER,
            "full-last-full": ParagraphJustification.FULL_JUSTIFY_LASTLINE_FULL
        };
        return required(values[value], "justification");
    }

    function snapshot(address, layer, requestedFont, usedFallback) {
        var sourceText = layer.property("ADBE Text Properties")
            .property("ADBE Text Document");
        var doc = sourceText.value;
        var isPoint = required(doc.pointText, "pointText");
        var boxSize = null;
        if (!isPoint) {
            var size = required(doc.boxTextSize, "boxTextSize");
            boxSize = {
                widthPixels: decimal(required(size[0], "boxTextSize.width")),
                heightPixels: decimal(required(size[1], "boxTextSize.height"))
            };
        }
        var fontName = String(required(doc.font, "font"));
        return {
            _address: {
                projectItemIndex: Number(address.project_item_index),
                expectedName: String(address.expected_name),
                layerIndex: Number(address.layer_index),
                expectedLayerName: String(address.expected_layer_name)
            },
            text: String(required(doc.text, "text")),
            textKind: isPoint ? "point" : "box",
            boxSize: boxSize,
            characterStyle: {
                fontPostScriptName: fontName,
                fontSizePixels: decimal(required(doc.fontSize, "fontSize")),
                fillColor: color8(required(doc.fillColor, "fillColor"), "fillColor"),
                strokeColor: color8(required(doc.strokeColor, "strokeColor"), "strokeColor"),
                strokeWidthPixels: decimal(required(doc.strokeWidth, "strokeWidth")),
                strokeOverFill: Boolean(required(doc.strokeOverFill, "strokeOverFill")),
                tracking: Number(required(doc.tracking, "tracking")),
                autoLeading: Boolean(required(doc.autoLeading, "autoLeading")),
                leadingPixels: doc.autoLeading ?
                    null : decimal(required(doc.leading, "leading")),
                fauxBold: Boolean(required(doc.fauxBold, "fauxBold")),
                fauxItalic: Boolean(required(doc.fauxItalic, "fauxItalic"))
            },
            paragraphStyle: {
                justification: justificationName(required(doc.justification, "justification")),
                firstLineIndentPixels: decimal(required(doc.firstLineIndent, "firstLineIndent")),
                startIndentPixels: decimal(required(doc.startIndent, "startIndent")),
                endIndentPixels: decimal(required(doc.endIndent, "endIndent")),
                spaceBeforePixels: decimal(required(doc.spaceBefore, "spaceBefore")),
                spaceAfterPixels: decimal(required(doc.spaceAfter, "spaceAfter"))
            },
            resolvedFont: {
                requestedPostScriptName: requestedFont === undefined ?
                    null : requestedFont,
                selectedPostScriptName: fontName,
                usedFallback: Boolean(usedFallback)
            }
        };
    }

    function normalizedFonts() {
        var groups = required(app.fonts.allFonts, "app.fonts.allFonts");
        var fonts = [];
        var seen = {};
        var groupIndex;
        var fontIndex;
        for (groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
            var group = groups[groupIndex] instanceof Array ?
                groups[groupIndex] : [groups[groupIndex]];
            for (fontIndex = 0; fontIndex < group.length; fontIndex += 1) {
                var font = group[fontIndex];
                var postScriptName = String(required(font.postScriptName, "postScriptName"));
                var record = {
                    postScriptName: postScriptName,
                    family: String(required(font.familyName, "familyName")),
                    style: String(required(font.styleName, "styleName"))
                };
                var seenKey = "$" + postScriptName;
                var signature = record.family + "\u0000" + record.style;
                if (seen[seenKey] !== undefined) {
                    if (seen[seenKey] !== signature) {
                        throw new Error("TEXT_CONTRACT_DUPLICATE_FONT:" + postScriptName);
                    }
                    continue;
                }
                seen[seenKey] = signature;
                fonts.push(record);
            }
        }
        fonts.sort(function (left, right) {
            var a = left.postScriptName + "\u0000" + left.family + "\u0000" + left.style;
            var b = right.postScriptName + "\u0000" + right.family + "\u0000" + right.style;
            return a < b ? -1 : (a > b ? 1 : 0);
        });
        return fonts;
    }

    function resolveFont(selection) {
        var fonts = normalizedFonts();
        var installed = {};
        var index;
        for (index = 0; index < fonts.length; index += 1) {
            installed[fonts[index].postScriptName] = true;
        }
        if (installed[selection.preferred_postscript_name]) {
            return {
                requested: selection.preferred_postscript_name,
                selected: selection.preferred_postscript_name,
                usedFallback: false
            };
        }
        if (selection.on_missing === "error") {
            throw new Error("FONT_NOT_INSTALLED:" +
                selection.preferred_postscript_name);
        }
        for (index = 0; index < selection.fallback_postscript_names.length; index += 1) {
            if (installed[selection.fallback_postscript_names[index]]) {
                return {
                    requested: selection.preferred_postscript_name,
                    selected: selection.fallback_postscript_names[index],
                    usedFallback: true
                };
            }
        }
        throw new Error("FONT_FALLBACK_EXHAUSTED:" +
            [selection.preferred_postscript_name]
                .concat(selection.fallback_postscript_names).join(","));
    }

    function beginWrite() {
        app.beginUndoGroup(String(request.undo_group));
        undoOpen = true;
    }

    function markMutation() {
        mutationStarted = true;
    }

    try {
        __AEMCP_TEXT_BODY__
    } catch (error) {
        if (undoOpen) {
            try {
                app.endUndoGroup();
            } catch (ignoreEndUndo) {
            }
            undoOpen = false;
        }
        var text = String(error && error.message ? error.message : error);
        var code = "TEXT_CONTRACT_MISMATCH";
        var action = "inspect-contract";
        var hint = "Inspect the maintained text template contract before retrying.";
        if (text.indexOf("STALE_TARGET:") === 0) {
            code = "STALE_TARGET";
            action = "refresh-target";
            hint = "Refresh the composition and layer index through public reads.";
        } else if (text.indexOf("FONT_NOT_INSTALLED:") === 0) {
            code = "FONT_NOT_INSTALLED";
            action = "choose-font";
            hint = "Choose an installed PostScript name or permit fallback.";
        } else if (text.indexOf("FONT_FALLBACK_EXHAUSTED:") === 0) {
            code = "FONT_FALLBACK_EXHAUSTED";
            action = "choose-font";
            hint = "Choose an installed PostScript name from ae_listInstalledFonts.";
        } else if (text.indexOf("INVALID_ARGUMENT:") === 0) {
            code = "INVALID_ARGUMENT";
            action = "change-request";
            hint = "Request a value that differs from current AE state.";
        } else if (text.indexOf("UNREPRESENTABLE_TEXT_STYLE:") === 0) {
            code = "UNREPRESENTABLE_TEXT_STYLE";
            action = "normalize-style";
            hint = "Use a text document with one representable uniform style.";
        }
        return fail(
            code,
            text,
            mutationStarted ? "may-have-occurred" : "not-started",
            mutationStarted ? "inspect-state" : action,
            mutationStarted ?
                "Inspect AE text state and the audit before retrying." : hint,
            { operation: request.operation }
        );
    }
}())
