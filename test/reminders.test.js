'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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
