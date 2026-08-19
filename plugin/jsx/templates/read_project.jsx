(function() {
    var o = $options;
    var project = app.project;
    if (!project) return JSON.stringify({ok: false, error: "No open project"});

    function itemType(item) {
        if (item instanceof CompItem) return "composition";
        if (item instanceof FolderItem) return "folder";
        if (item instanceof FootageItem) {
            try {
                if (item.mainSource && item.mainSource instanceof SolidSource) return "solid";
            } catch (eSolid) {}
            return "footage";
        }
        return "unknown";
    }
    function parentLocator(item) {
        var folder = null;
        try { folder = item.parentFolder; } catch (eParent) {}
        return folder ? {locatorKind: "jsx", itemId: String(folder.id)} : null;
    }
    function contains(item, filter) {
        if (filter.nameContains && String(item.name).indexOf(filter.nameContains) === -1) return false;
        if (filter.type && item.type !== filter.type) return false;
        return true;
    }
    function compare(a, b, by) {
        var av = by === "id" ? String(a.itemId) : String(a[by]);
        var bv = by === "id" ? String(b.itemId) : String(b[by]);
        if (av < bv) return -1;
        if (av > bv) return 1;
        return 0;
    }

    var filter = o.filter || {};
    var all = [];
    for (var i = 1; i <= project.numItems; i++) {
        var item = project.item(i);
        var entry = {
            locatorKind: "jsx",
            locator: {locatorKind: "jsx", itemId: String(item.id)},
            itemId: String(item.id),
            name: String(item.name),
            type: itemType(item),
            parentLocator: parentLocator(item)
        };
        if (contains(entry, filter)) all.push(entry);
    }
    if (o.sort && o.sort.by) {
        all.sort(function(a, b) {
            var result = compare(a, b, o.sort.by);
            return o.sort.order === "desc" ? -result : result;
        });
    }
    var offset = o.page.offset;
    var limit = o.page.limit;
    var total = all.length;
    var end = Math.min(total, offset + limit);
    var items = [];
    for (var j = offset; j < end; j++) items.push(all[j]);
    return JSON.stringify({
        ok: true,
        projectLocator: {locatorKind: "jsx", projectId: null},
        total: total,
        offset: offset,
        limit: limit,
        returned: items.length,
        hasMore: end < total,
        nextOffset: end < total ? end : null,
        items: items
    });
})()
