'use strict';

// Append actionable hints to known ExtendScript error patterns. Patterns cover
// localized Chinese and English AE builds; hints remain English for the model.

const HINTS = [
    [
        /setTemporalEaseAtKey.*(元素|element)/i,
        'ease arrays need one KeyframeEase per property dimension '
            + '(1D like Opacity=1, Scale=value dimensions, spatial Position=1); '
            + 'use AEMCP.easeKeys(prop) to size them automatically',
    ],
    [
        /null 不是对象|null is not an object|undefined 不是对象|undefined is not an object/i,
        'a lookup returned null/undefined - check comp/layer/property lookups '
            + '(byName/index) before use, or wrap with AEMCP.mustFind(value, name). '
            + 'If you fetched an effect sub-property by name and got null, address it by '
            + 'index instead (effect.property(1)/property(2)/...).',
    ],
    [
        /函数.*未定义|is not a function/i,
        'that API does not exist on this object - verify with a read tool '
            + 'first instead of guessing method names',
    ],
    [
        /未与图层关联|not associated with (a |the )?layer/i,
        'the property reference detached - addProperty() invalidates earlier refs. '
            + 'Re-acquire via AEMCP.propByMatchPath after all addProperty calls, then '
            + 'setValue. For text, read the ADBE Text Document value back, edit it, then '
            + 'setValue it.',
    ],
    [
        /font[^\n]{0,40}(无效字符|invalid character)|包含无效字符/i,
        'use the font PostScript name with no spaces (e.g. MicrosoftYaHei-Bold).',
    ],
    [
        /0\.1\s*至\s*1296|out of range[^\n]{0,12}1296/i,
        'fontSize hard-caps at 1296; clamp the value before setValue.',
    ],
];

const HINT_MARK = '[hint]';

function appendHint(error) {
    const text = String(error || '');
    if (text.indexOf(HINT_MARK) !== -1) return text;
    for (let i = 0; i < HINTS.length; i += 1) {
        if (HINTS[i][0].test(text)) return text + '\n' + HINT_MARK + ' ' + HINTS[i][1];
    }
    return text;
}

module.exports = { HINTS, HINT_MARK, appendHint };
