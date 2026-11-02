'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function fixture({ action = 'zu', method = 'POST', past = false, cancelled = false, valid = true, failSave = false } = {}) {
    const day = { id: 'day', datum: past ? '2026-11-01' : '2026-11-03', antworten: {}, ...(cancelled ? { cancelledAt: 'now' } : {}) };
    const events = [];
    const res = {
        writeHead(status, headers) { this.status = status; this.headers = headers; events.push('response'); },
        end(body) { this.body = body; }
    };
    const context = vm.createContext({
        URLSearchParams, Date,
        readBody: async () => new URLSearchParams({ t: 'token', a: action }).toString(),
        readToken: () => valid ? { sid: 'day', pid: 'player' } : null,
        loadZahlungen: () => ({ spieltage: [day] }),
        playerNames: () => new Map([['player', 'Test']]), berlinToday: () => '2026-11-02',
        writeJson: async () => { if (failSave) throw Error('save failed'); events.push('saved'); },
        rsvpPage: (response, status, body) => { response.writeHead(status, {}); response.end(body); },
        escHtml: value => value, fmtDay: value => value.datum
    });
    vm.runInContext(source.slice(source.indexOf('async function handleRsvp('), source.indexOf('function spielerIdOf(')), context);
    return { day, res, events, run: () => context.handleRsvp({ method }, res, new URL('https://example.org/rsvp?t=token&a=zu')) };
}

for (const action of ['zu', 'ab']) {
    test(`RSVP ${action} redirects home only after saving`, async () => {
        const f = fixture({ action });
        await f.run();
        assert.equal(f.day.antworten.player.status, action);
        assert.equal(f.day.antworten.player.by, 'mail');
        assert.deepEqual(f.events, ['saved', 'response']);
        assert.equal(f.res.status, 303);
        assert.equal(f.res.headers.Location, '/');
        assert.equal(f.res.headers['Cache-Control'], 'no-store');
        assert.equal(f.res.headers['Referrer-Policy'], 'no-referrer');
    });
}

test('GET, invalid actions, expired links, past and cancelled days do not save or redirect', async () => {
    for (const options of [{ method: 'GET' }, { action: 'invalid' }, { valid: false }, { past: true }, { cancelled: true }]) {
        const f = fixture(options);
        await f.run();
        assert.equal(f.events.includes('saved'), false);
        assert.equal(f.res.headers.Location, undefined);
        assert.deepEqual(f.day.antworten, {});
        assert.ok(f.res.body);
    }
});

test('failed persistence never sends a success redirect', async () => {
    const f = fixture({ failSave: true });
    await assert.rejects(f.run(), /save failed/);
    assert.equal(f.res.status, undefined);
});
