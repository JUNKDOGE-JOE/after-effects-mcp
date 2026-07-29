(function () {
    var request = __AEMCP_LAYER_SOURCE_REQUEST__;

    function failure(code, message, sideEffect) {
        return {
            ok: false,
            error: {
                code: code,
                message: message,
                retryable: false,
                sideEffect: sideEffect,
                recovery: {
                    action: sideEffect === "possible" ? "reconcile-state" : "refresh-locators",
                    hint: sideEffect === "possible"
                        ? "Read fresh layer source state and inspect the audit outcome before any retry."
                        : "Refresh native project and layer locators, then submit a new intent."
                }
            }
        };
    }

    function itemType(item) {
        if (item instanceof CompItem) {
            return "composition";
        }
        if (item instanceof FootageItem) {
            return "footage";
        }
        if (item instanceof FolderItem) {
            return "folder";
        }
        return "unknown";
    }

    function layerType(layer) {
        if (layer instanceof TextLayer) {
            return "text";
        }
        if (layer instanceof ShapeLayer) {
            return "shape";
        }
        if (layer instanceof CameraLayer) {
            return "camera";
        }
        if (layer instanceof LightLayer) {
            return "light";
        }
        if (layer instanceof AVLayer) {
            if (layer.nullLayer === true) {
                return "null";
            }
            if (layer.adjustmentLayer === true) {
                return "adjustment";
            }
            return "av";
        }
        return "unknown";
    }

    function projectItemIndex(item) {
        var index;
        for (index = 1; index <= app.project.numItems; index += 1) {
            if (app.project.item(index) === item) {
                return index;
            }
        }
        return null;
    }

    function invariantSnapshot(layer) {
        var parentIndex = null;
        var matteIndex = null;
        if (layer.parent !== null) {
            parentIndex = layer.parent.index;
        }
        if (layer.trackMatteLayer !== null && layer.trackMatteLayer !== undefined) {
            matteIndex = layer.trackMatteLayer.index;
        }
        return {
            name: layer.name,
            inPoint: layer.inPoint,
            outPoint: layer.outPoint,
            startTime: layer.startTime,
            stretch: layer.stretch,
            parentIndex: parentIndex,
            enabled: layer.enabled,
            audioEnabled: layer.audioEnabled,
            solo: layer.solo,
            shy: layer.shy,
            locked: layer.locked,
            guideLayer: layer.guideLayer,
            threeDLayer: layer.threeDLayer,
            adjustmentLayer: layer.adjustmentLayer,
            motionBlur: layer.motionBlur,
            collapseTransformation: layer.collapseTransformation,
            effectsActive: layer.effectsActive,
            frameBlending: layer.frameBlending,
            timeRemapEnabled: layer.timeRemapEnabled,
            preserveTransparency: layer.preserveTransparency,
            quality: String(layer.quality),
            blendingMode: String(layer.blendingMode),
            trackMatteType: String(layer.trackMatteType),
            trackMatteLayerIndex: matteIndex
        };
    }

    function sourceSnapshot(source) {
        return {
            projectItemIndex: projectItemIndex(source),
            name: source.name,
            type: itemType(source)
        };
    }

    function run() {
        var address = request._resolved;
        var composition;
        var layer;
        var currentSource;
        var newSource;
        var beforeSource;
        var beforeInvariant;
        var afterSource;
        var afterInvariant;
        var undoOpen = false;

        if (app.project === null) {
            return failure("STALE_LOCATOR", "No After Effects project is open.", "not-started");
        }
        if (
            address.composition_project_item_index < 1
            || address.composition_project_item_index > app.project.numItems
        ) {
            return failure("STALE_LOCATOR", "Composition project-item position changed.", "not-started");
        }
        composition = app.project.item(address.composition_project_item_index);
        if (
            itemType(composition) !== address.expected_composition_type
            || composition.name !== address.expected_composition_name
        ) {
            return failure("STALE_LOCATOR", "Composition guard changed.", "not-started");
        }
        if (address.layer_index < 1 || address.layer_index > composition.numLayers) {
            return failure("STALE_LOCATOR", "Layer stack position changed.", "not-started");
        }
        layer = composition.layer(address.layer_index);
        if (
            layer.name !== address.expected_layer_name
            || layerType(layer) !== address.expected_layer_type
        ) {
            return failure("STALE_LOCATOR", "Layer name or type changed.", "not-started");
        }
        if (
            !(layer instanceof AVLayer)
            || layer instanceof TextLayer
            || layer instanceof ShapeLayer
            || layer instanceof CameraLayer
            || layer instanceof LightLayer
            || layer.nullLayer === true
            || layer.adjustmentLayer === true
        ) {
            return failure("LAYER_SOURCE_NOT_REPLACEABLE", "Target is not an ordinary AV layer.", "not-started");
        }
        if (layer.source === null || layer.source === undefined) {
            return failure("LAYER_SOURCE_NOT_REPLACEABLE", "Target layer has no replaceable source.", "not-started");
        }
        currentSource = layer.source;
        if (
            projectItemIndex(currentSource) !== address.current_source_project_item_index
            || currentSource.name !== address.expected_current_source_name
            || itemType(currentSource) !== address.expected_current_source_type
        ) {
            return failure("STALE_LOCATOR", "Current source guard changed.", "not-started");
        }
        if (
            address.new_source_project_item_index < 1
            || address.new_source_project_item_index > app.project.numItems
        ) {
            return failure("STALE_LOCATOR", "New source project-item position changed.", "not-started");
        }
        newSource = app.project.item(address.new_source_project_item_index);
        if (
            newSource.name !== address.expected_new_source_name
            || itemType(newSource) !== address.expected_new_source_type
            || !(newSource instanceof FootageItem || newSource instanceof CompItem)
        ) {
            return failure("SOURCE_ITEM_NOT_AV", "New source is not the resolved AV project item.", "not-started");
        }
        if (layer.source === newSource) {
            return failure("VALUE_UNCHANGED", "The requested source is already active.", "not-started");
        }

        beforeSource = sourceSnapshot(currentSource);
        beforeInvariant = invariantSnapshot(layer);
        try {
            app.beginUndoGroup(request.undo_group);
            undoOpen = true;
            layer.replaceSource(newSource, false);
            afterSource = sourceSnapshot(layer.source);
            afterInvariant = invariantSnapshot(layer);
            app.endUndoGroup();
            undoOpen = false;
        } catch (error) {
            if (undoOpen) {
                try {
                    app.endUndoGroup();
                } catch (ignored) {
                }
            }
            return failure(
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "Source replacement did not return a trustworthy terminal result.",
                "possible"
            );
        }
        return {
            ok: true,
            value: {
                _resolved: address,
                beforeSource: beforeSource,
                afterSource: afterSource,
                beforeInvariant: beforeInvariant,
                afterInvariant: afterInvariant
            }
        };
    }

    try {
        return JSON.stringify(run());
    } catch (error) {
        return JSON.stringify(failure(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Maintained source template could not serialize its terminal result.",
            "possible"
        ));
    }
}())
