'use strict';

function renderTemplate(text, variables) {
    const values = variables || {};
    return String(text).replace(
        /\$\$|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        function (match, plain, braced) {
            if (match === '$$') return '$';
            const name = plain || braced;
            if (!Object.prototype.hasOwnProperty.call(values, name)) {
                throw new Error('missing template variable: ' + name);
            }
            return String(values[name]);
        },
    );
}

module.exports = { renderTemplate };
