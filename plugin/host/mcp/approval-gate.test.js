'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ApprovalQueue } = require('./approvals');
const {
    READONLY_DENIED, NO_PROMPT_API, readTier, gateDecision, enforce,
} = require('./approval-gate');

const MATRIX = [
    ['readonly', 'allow', 'deny-readonly', 'deny-readonly'],
    ['manual', 'allow', 'elicit', 'elicit'],
    ['auto', 'allow', 'allow', 'elicit'],
    ['none', 'allow', 'allow', 'allow'],
];

test('approval gate decision record is copied verbatim from the Python module docstring', () => {
    const pythonSource = fs.readFileSync(
        path.resolve(__dirname, '../../../packages/core/ae_mcp/approval_gate.py'),
        'utf8',
    );
    const jsSource = fs.readFileSync(path.join(__dirname, 'approval-gate.js'), 'utf8');
    const pythonDoc = pythonSource.match(/^"""([\s\S]*?)"""/);
    const jsDoc = jsSource.match(/\/\*([\s\S]*?)\*\//);
    assert.ok(pythonDoc && jsDoc);
    assert.equal(jsDoc[1].trim(), pythonDoc[1].trim());
});

test('gateDecision covers four tiers by read, write, and destructive risk', () => {
    MATRIX.forEach(function (row) {
        assert.equal(gateDecision(row[0], 'ae_status'), row[1], row[0] + ' read');
        assert.equal(gateDecision(row[0], 'ae_checkpoint'), row[2], row[0] + ' write');
        assert.equal(gateDecision(row[0], 'ae_exec'), row[3], row[0] + ' destructive');
    });
    assert.equal(gateDecision('invalid', 'ae_exec'), 'elicit');
});

test('readTier accepts legal tiers and defaults invalid or unreadable files to manual', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-tier-'));
    try {
        const tierFile = path.join(root, 'tier.txt');
        ['readonly', 'manual', 'auto', 'none'].forEach(function (tier, index) {
            fs.writeFileSync(tierFile, tier + '\n', 'utf8');
            const stamp = new Date(1000 + index * 2000);
            fs.utimesSync(tierFile, stamp, stamp);
            assert.equal(readTier(tierFile), tier);
        });
        fs.writeFileSync(tierFile, 'bogus\n', 'utf8');
        const invalidStamp = new Date(12000);
        fs.utimesSync(tierFile, invalidStamp, invalidStamp);
        assert.equal(readTier(tierFile), 'manual');
        assert.equal(readTier(path.join(root, 'missing')), 'manual');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function context(tier, args) {
    return {
        policy: { approvalTier: tier },
        session: { id: 'session-1', conversationId: 'conversation-1' },
        arguments: args || { code: 'x'.repeat(250), undo_group_name: 'Undo', checkpoint_label: 'Before' },
    };
}

test('enforce allows null and none policies and denies readonly writes', async () => {
    assert.equal(await enforce('ae_exec', context(null), {}), null);
    assert.equal(await enforce('ae_exec', context('none'), {}), null);
    assert.deepEqual(await enforce('ae_exec', context('readonly'), {}), {
        ok: false, error: READONLY_DENIED,
    });
});

test('enforce reports missing prompt API, accepted approval, and exact decline text', async () => {
    assert.deepEqual(await enforce('ae_exec', context('manual'), {}), {
        ok: false, error: NO_PROMPT_API,
    });
    const approvals = new ApprovalQueue({ timeoutMs: 1000 });
    approvals.on('request', function (item) {
        assert.equal(item.summary.code.length, 200);
        assert.equal(item.risk, 'destructive');
        approvals.resolve(item.id, 'accept');
    });
    assert.equal(await enforce('ae_exec', context('manual'), { approvals }), null);

    const declined = new ApprovalQueue({ timeoutMs: 1000 });
    declined.on('request', function (item) { declined.resolve(item.id, 'decline'); });
    assert.deepEqual(await enforce('ae_exec', context('manual'), { approvals: declined }), {
        ok: false, error: 'User denied this action.',
    });

    const timedOut = new ApprovalQueue({ timeoutMs: 5 });
    assert.deepEqual(await enforce('ae_exec', context('manual'), { approvals: timedOut }), {
        ok: false, error: 'User denied this action.',
    });
});
