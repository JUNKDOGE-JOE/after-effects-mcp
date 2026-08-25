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
    [
        /值\s+\S+\s+在\s+-?1000000\s+至\s+1000000\s+的范围外|value\s+\S+\s+is outside the range\s+-?1000000\s+to\s+1000000/i,
        'AE Slider Controls hard-clamp to ±1,000,000; for larger numbers drive a text layer sourceText expression or split digits into separate layers or sliders.',
    ],
    [
        /颜色数组没有\s*3\s*个值|color array does not have 3 values/i,
        'colors are [r,g,b] (0-1 floats), with alpha passed separately; a text fillColor takes exactly 3 values.',
    ],
    [
        /对象无效|object is invalid/i,
        'the referenced AE object was deleted or its collection index shifted; re-acquire comps, layers, and properties by name right before use instead of holding references across edits.',
    ],
    [
        /PropertyValueType\.NO_VALUE/i,
        'that match name is a GROUP, not a leaf property; set values on its child leaf properties by walking with AEMCP.propByMatchPath or numeric indices.',
    ],
];

const HINT_MARK = '[hint]';

function appendHint(error) {
    const text = String(error || '');
    if (text.indexOf(HINT_MARK) !== -1) return text;
    const match = matchHint(text);
    return match ? text + '\n' + HINT_MARK + ' ' + match.hint : text;
}

function matchHint(error) {
    const text = String(error || '');
    for (let i = 0; i < HINTS.length; i += 1) {
        if (HINTS[i][0].test(text)) return { index: i, hint: HINTS[i][1] };
    }
    return null;
}

module.exports = { HINTS, HINT_MARK, appendHint, matchHint };
