'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');

test('change mail reaches accepted and billed participants once, reports missing addresses and failures', async () => {
    const sent = [];
    const context = vm.createContext({
        loadUsers: () => ['yes', 'no', 'open', 'billed', 'failed'].map(spielerId => ({ spielerId, email: spielerId + '@example.org' })),
        playerNames: () => new Map(), EMAIL_RE: /@/, fmtDay: s => s.datum, rsvpLink: () => 'cancel-link',
        sendMail: async mail => { if (mail.to.startsWith('failed@')) throw Error('SMTP error'); sent.push(mail); },
        console: { error() {} }
    });
    vm.runInContext(source.slice(source.indexOf('async function mailSpieltagAenderung('), source.indexOf('const RSVP_STYLE')), context);
    const result = await context.mailSpieltagAenderung({ datum: '2026-11-01', ort: 'Halle',
        antworten: { yes: { status: 'zu' }, no: { status: 'ab' }, missing: { status: 'zu' }, failed: { status: 'zu' } },
        teilnehmer: ['yes', 'billed'] }, { datum: '2026-10-31', ort: 'Platz' });
    assert.deepEqual(sent.map(m => m.to), ['yes@example.org', 'billed@example.org']);
    assert.match(sent[0].text, /Platz/);
    assert.match(sent[0].text, /Halle/);
    assert.match(sent[0].text, /cancel-link/);
    assert.equal(result.sent, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed.length, 1);
});

test('day editing requires admin, validates changes, preserves responses and saves before mailing', async () => {
    const route = source.slice(source.indexOf("        if (!action && method === 'PATCH')"), source.indexOf("        if (action === 'bezahlt'"));
    const day = { datum: '2026-10-24', uhrzeit: '18:00', ort: 'Platz', antworten: { p: { status: 'zu' } }, teilnehmer: ['p'], bezahlt: { p: true } };
    const events = [];
    const context = vm.createContext({ action: undefined, method: 'PATCH', s: day, id: 'day', z: { spieltage: [day] }, req: {}, res: {},
        requireAdmin: () => true, berlinToday: () => '2026-10-23', surveyData: () => ({ days: {} }), MAIL_ENABLED: true,
        readJsonBody: async () => ({ datum: '2026-10-25', uhrzeit: '19:00', ort: 'Halle' }),
        writeJson: async () => events.push('save'), mailSpieltagAenderung: async (s, old) => { events.push('mail'); assert.equal(old.ort, 'Platz'); return { sent: 1 }; },
        sendJson: (res, status, data) => ({ status, data }) });
    const run = () => vm.runInContext(`(async () => { ${route} })()`, context);
    context.requireAdmin = () => false;
    assert.equal(await run(), undefined);
    assert.deepEqual(events, []);
    context.requireAdmin = () => true;
    context.MAIL_ENABLED = false;
    assert.equal((await run()).status, 400);
    assert.equal(day.ort, 'Platz');
    context.MAIL_ENABLED = true;
    const validBody = context.readJsonBody;
    for (const body of [{ datum: '2026-02-30' }, { datum: '2026-10-22' }, { datum: '2026-10-25', uhrzeit: '25:00' }]) {
        context.readJsonBody = async () => body;
        assert.equal((await run()).status, 400);
    }
    context.readJsonBody = validBody;
    assert.equal((await run()).status, 200);
    assert.deepEqual(events, ['save', 'mail']);
    assert.equal(day.ort, 'Halle');
    assert.equal(day.antworten.p.status, 'zu');
    assert.equal(day.bezahlt.p, true);
    assert.equal((await run()).data.unchanged, true);
    assert.equal(events.length, 2);
    day.finishedAt = 'finished';
    assert.equal((await run()).status, 409);
});
