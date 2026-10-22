'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('bulk survey reminder sends only to outstanding participants', async () => {
    const sent = [];
    const day = { participants: ['answered', 'open', 'failed', 'sending'], submissions: { answered: {} },
        invites: { answered: { status: 'sent' }, open: { status: 'sent' }, failed: { status: 'failed' }, sending: { status: 'sending' } } };
    const context = vm.createContext({
        url: '/api/spieltage/day/umfrage/erinnerung', method: 'POST', res: {},
        requireAdmin: () => true, MAIL_ENABLED: true, surveyData: () => ({ days: { day } }),
        isSurveyClosed: () => false,
        sendSurveyInvitation: async (dayId, playerId) => { sent.push(playerId); day.invites[playerId].status = 'sent'; },
        sendJson: (res, status, data) => ({ status, data })
    });
    const start = source.indexOf('    const remindSurveyApi =');
    const route = source.slice(start, source.indexOf('    const retrySurveyInviteApi =', start));
    const result = await vm.runInContext(`(async () => { ${route} })()`, context);
    assert.deepEqual(sent, ['open', 'failed']);
    assert.equal(result.data.mail.sent, 2);
    assert.equal(result.data.mail.skipped, 1);
    context.isSurveyClosed = () => true;
    assert.equal((await vm.runInContext(`(async () => { ${route} })()`, context)).status, 410);
    assert.equal(sent.length, 2);
});

test('invitations exclude both accepted and declined responses', async () => {
    const sent = [];
    const context = vm.createContext({
        loadUsers: () => ['yes', 'no', 'open'].map(spielerId => ({ spielerId, email: `${spielerId}@example.org` })),
        playerNames: () => new Map(['yes', 'no', 'open'].map(id => [id, id])),
        EMAIL_RE: /@/, fmtDay: () => 'today', rsvpLink: () => 'link',
        sendMail: async mail => sent.push(mail), console
    });
    const start = source.indexOf('async function mailEinladung(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    const result = await context.mailEinladung({ antworten: { yes: { status: 'zu' }, no: { status: 'ab' } } });
    assert.deepEqual(sent.map(mail => mail.to), ['open@example.org']);
    assert.equal(result.sent, 1);
});

test('survey delivery skips answered and expired surveys and permits outstanding reminders', async () => {
    for (const status of ['pending', 'sent', 'failed', 'sending']) {
        for (const answered of [false, true]) {
            for (const closed of [false, true]) {
                let writes = 0;
                const day = { invites: { p1: { status } }, submissions: answered ? { p1: {} } : {}, closesAt: 'deadline' };
                const context = vm.createContext({
                    mutateSurveys: action => action(), surveyData: () => ({ days: { day } }),
                    isSurveyClosed: () => closed, writeJson: async () => { writes++; },
                    loadUsers: () => ({}), EMAIL_RE: /@/, Date
                });
                vm.runInContext(source.slice(source.indexOf('async function sendSurveyInvitation('), source.indexOf('\nfunction publicSurveyDay(')), context);
                await context.sendSurveyInvitation('day', 'p1', status !== 'pending');
                const expected = !answered && !closed && status !== 'sending';
                assert.equal(writes > 0, expected, JSON.stringify({ status, answered, closed }));
                assert.equal(day.invites.p1.status, expected ? 'no_email' : status);
            }
        }
    }
});
