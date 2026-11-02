'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
test('cancellation mails only accepted players and reports delivery gaps', async () => {
    const sent = [];
    const ctx = vm.createContext({ loadUsers: () => ['yes', 'no', 'open', 'fail'].map(spielerId => ({ spielerId, email: spielerId + '@example.org' })), EMAIL_RE: /@/, fmtDay: s => s.datum,
        sendMail: async m => { if (m.to === 'fail@example.org') throw Error('SMTP'); sent.push(m); }, console: { error() {} } });
    vm.runInContext(source.slice(source.indexOf('async function mailSpieltagAbsage('), source.indexOf('const RSVP_STYLE')), ctx);
    const result = await ctx.mailSpieltagAbsage({ datum: '2026-11-02', ort: 'Halle', antworten: { yes: { status: 'zu' }, no: { status: 'ab' }, missing: { status: 'zu' }, fail: { status: 'zu' } } });
    assert.deepEqual(sent.map(m => m.to), ['yes@example.org']);
    assert.match(sent[0].text, /Halle/);
    assert.equal(result.sent, 1); assert.equal(result.skipped, 1); assert.equal(result.failed.length, 1);
});
test('cancellation requires admin, saves before mail and repeated requests do not resend', async () => {
    const route = source.slice(source.indexOf("        if (action === 'absagen'"), source.indexOf("        if (!action && method === 'PATCH')"));
    const day = { datum: '2026-11-02', betragCent: null };
    const events = [];
    const ctx = vm.createContext({ action: 'absagen', method: 'POST', s: day, id: 'd', z: {}, res: {}, requireAdmin: () => false, berlinToday: () => '2026-11-02', surveyData: () => ({ days: {} }), MAIL_ENABLED: true,
        writeJson: async () => events.push('save'), mailSpieltagAbsage: async () => { events.push('mail'); return { sent: 3 }; }, sendJson: (r, status, data) => ({ status, data }) });
    const run = () => vm.runInContext(`(async () => { ${route} })()`, ctx);
    assert.equal(await run(), undefined);
    ctx.requireAdmin = () => true; ctx.MAIL_ENABLED = false;
    assert.equal((await run()).status, 400); assert.equal(day.cancelledAt, undefined);
    ctx.MAIL_ENABLED = true; day.finishedAt = 'done'; assert.equal((await run()).status, 409); delete day.finishedAt;
    day.betragCent = 500; assert.equal((await run()).status, 409); day.betragCent = null;
    assert.equal((await run()).data.mail.sent, 3); assert.ok(day.cancelledAt);
    assert.deepEqual(events, ['save', 'mail']);
    assert.equal((await run()).data.unchanged, true); assert.equal(events.length, 2);
    ctx.action = 'antwort'; assert.equal((await run()).status, 409);
});
