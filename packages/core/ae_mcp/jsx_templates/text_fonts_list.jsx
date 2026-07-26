var fonts = normalizedFonts();
var end = Math.min(fonts.length, request.offset + request.limit);
var page = fonts.slice(request.offset, end);
return JSON.stringify({
    ok: true,
    value: {
        total: fonts.length,
        offset: request.offset,
        limit: request.limit,
        returned: page.length,
        hasMore: end < fonts.length,
        nextOffset: end < fonts.length ? end : null,
        fonts: page
    }
});
