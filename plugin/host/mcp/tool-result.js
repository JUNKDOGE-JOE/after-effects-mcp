'use strict';

// Shared result helpers for /mcp tools. Kept in its own module so tool files
// under ./tools/ can require it without a cycle through the registry.

function textResult(value, isError) {
    const result = {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
    };
    if (isError) result.isError = true;
    return result;
}

function noTopLevelCombinator(schema) {
    return !['oneOf', 'allOf', 'anyOf'].some(function (key) {
        return Object.prototype.hasOwnProperty.call(schema, key);
    });
}

module.exports = { textResult, noTopLevelCombinator };
