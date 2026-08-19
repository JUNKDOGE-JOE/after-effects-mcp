'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { call, compExpr } = require('./validate-expressions');
function context() {
    return { session: { clientName: 'test' }, policy: { approvalTier: null } };
}
function reply(value) {
    return { payload: { ok: true, result: JSON.stringify(value) } };
}
test('ae_validateExpressions validates arguments and renders JSON-safe template literals', async function () {
    for (const args of [
        { comp_id: 'oops' },
        { layer_ids: [1, '2'] },
        { prop: 2 },
        { sample_times: [-1] },
        { max_results: 2001 },
    ]) {
        const out = await call(args, context(), {
            executeJsx: async function () {
                throw new Error('must not execute');
            },
        });
        assert.equal(out.result.isError, true);
    }
    let code = '';
    const out = await call(
        { comp_id: '42', layer_ids: [2], prop: 'a"\\b', sample_times: [0, 1.5], max_results: 7 },
        context(),
        {
            executeJsx: async function (input) {
                code = input.code;
                return reply({ ok: true, checked: 1, errors: [], truncated: false });
            },
        },
    );
    assert.match(code, /AEMCP\.compById\(42\)/);
    assert.match(code, /a\\"\\\\b/);
    assert.match(code, /\[0,1\.5\]/);
    assert.match(code, /var maxResults = 7/);
    assert.deepEqual(out.result.structuredContent, { ok: true, checked: 1, errors: [], truncated: false });
    assert.equal(compExpr(undefined), 'AEMCP.activeComp()');
});
