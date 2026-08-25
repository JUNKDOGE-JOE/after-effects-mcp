'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { appendHint, matchHint } = require('./error-hints');

const CASES = [
    ['由于参数 2，无法调用"setTemporalEaseAtKey"。值数组没有 3 元素。', 'AEMCP.easeKeys(prop)'],
    ['TypeError: null 不是对象 (line 4)', 'AEMCP.mustFind(value, name)'],
    ['ReferenceError: 函数 app.project.items.byName 未定义', 'verify with a read tool'],
    ['由于参数 1，无法设置值。该属性未与图层关联。', 'AEMCP.propByMatchPath'],
    ['After Effects 错误: font 包含无效字符', 'PostScript name'],
    ['value out of range 1296', 'fontSize hard-caps at 1296'],
    ['值 987654336 在 -1000000 至 1000000 的范围外', 'AE Slider Controls hard-clamp'],
    ['value 987654336 is outside the range -1000000 to 1000000', 'AE Slider Controls hard-clamp'],
    ['颜色数组没有 3 个值', 'colors are [r,g,b]'],
    ['color array does not have 3 values', 'colors are [r,g,b]'],
    ['对象无效', 'referenced AE object was deleted'],
    ['object is invalid', 'referenced AE object was deleted'],
    ['PropertyValueType.NO_VALUE', 'GROUP, not a leaf property'],
];

test('appendHint covers every migrated error pattern', () => {
    CASES.forEach(function (row) {
        const result = appendHint(row[0]);
        assert.match(result, /\[hint\]/, row[0]);
        assert.ok(result.indexOf(row[1]) !== -1, row[0]);
    });
});

test('appendHint leaves unknown and already hinted errors unchanged', () => {
    assert.equal(appendHint('plain unrelated error'), 'plain unrelated error');
    const hinted = 'TypeError: null is not an object\n[hint] already appended';
    assert.equal(appendHint(hinted), hinted);
});

test('null lookup hint includes effect index fallback', () => {
    const result = appendHint('TypeError: undefined is not an object');
    assert.ok(result.indexOf('effect.property(1)') !== -1);
});

test('matchHint returns the stable index and hint text', () => {
    const match = matchHint('对象无效');
    assert.equal(typeof match.index, 'number');
    assert.match(match.hint, /re-acquire comps/);
    assert.equal(matchHint('unrelated'), null);
});
