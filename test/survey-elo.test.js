'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const logic = require('../src/logic/survey');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const extract = (start, end) => server.slice(server.indexOf(start), server.indexOf(end));

function fixture() {
    const files = {};
    const context = vm.createContext({
        ...logic, readFile: name => files[name] || '',
        surveyPlayers: () => [], calculateSurveyAwards: () => ({}),
        writeJson: async (name, value) => { files[name] = JSON.stringify(value); }
    });
    vm.runInContext(
        extract('function csvRows(', 'function playerNames(') +
        extract('function playersCsvWithSurveyRatings(', '\nfunction surveyComparisons') +
        extract('function replaySurveyEloDeltas(', '\nasync function closeDueSurveys') +
        extract('async function finalizeSurveyDays(', '\nfunction scheduleNextSurveyClose'), context
    );
    return { context, files };
}
const keys = logic.ATTRIBUTES;
const priors = { p2: { TEM: 69, SCH: 61, PAS: 85, DRL: 70, VER: 62, PHY: 61 } };
const ratings = values => Object.fromEntries(keys.map((key, i) => [key, { p2: values[i] }]));
const csv = (elo = 1648, values = Object.values(priors.p2)) =>
    'id;elo;tem;sch;pas;drl;ver;phy\np2;' + elo + ';' + values.join(';') + '\n';
function row(context, text) {
    const [header, values] = context.csvRows(text);
    return Object.fromEntries(header.map((key, i) => [key, values[i]]));
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('loading without survey changes preserves Elo independently of attribute average', () => {
    const { context: c } = fixture();
    assert.equal(row(c, c.playersCsvWithSurveyRatings(csv(), {})).elo, '1648');
    assert.equal(row(c, c.playersCsvWithSurveyRatings(csv(), ratings(Object.values(priors.p2)), priors)).elo, '1648');
    // Also covers players who have never taken part in a survey.
    assert.equal(row(c, c.playersCsvWithSurveyRatings(csv(1700), {}, {})).elo, '1700');
});

test('first survey adds only its delta, retaining fractional attributes and the 13-point Elo offset', () => {
    const { context: c } = fixture();
    const initial = Object.values(priors.p2).map(value => value + 0.125);
    const current = ratings([69, 61, 84, 76, 62, 61]);
    const applied = c.playersCsvWithSurveyRatings(csv(1648, initial), current, priors);
    const result = row(c, applied);
    near(Number(result.elo), 1648 + 5 * 29 / 6);
    near(Number(result.drl), 76.125);
    near(Number(result.pas), 84.125);
    assert.equal(c.playersCsvWithSurveyRatings(applied, current, priors), applied);
});

test('saved survey markers prevent reapplication across games and the second survey', () => {
    const { context: c } = fixture();
    const first = ratings([69, 61, 84, 76, 62, 61]);
    const applied = c.playersCsvWithSurveyRatings(csv(), first, priors);
    const result = row(c, applied);
    const afterGames = Number(result.elo) + 23 - 29 + 30;
    const stored = applied.replace(result.elo, String(afterGames));
    const second = ratings([69, 61, 84, 76, 62, 63]);
    const final = c.playersCsvWithSurveyRatings(stored, second, priors);
    near(Number(row(c, final).elo), 1705.8333333333333);
    assert.equal(c.playersCsvWithSurveyRatings(final, second, priors), final);
});

test('attribute caps count only the change actually applied', () => {
    const { context: c } = fixture();
    const initial = Object.values(priors.p2);
    initial[0] = 98.5;
    const result = row(c, c.playersCsvWithSurveyRatings(csv(2000, initial), ratings([72, 61, 85, 70, 62, 61]), priors));
    assert.equal(Number(result.tem), 99);
    near(Number(result.elo), 2000 + 0.5 * 29 / 6);
});

test('historical surveys use recorded Elo anchors and submission deltas, including capped changes', () => {
    const { context: c, files } = fixture();
    files['spiele.csv'] = 'spieler_id;zeit;elo_vorher;elo_nachher\np2;2026-10-20T10:00:00Z;1700;1648\np2;2026-10-26T10:00:00Z;1672.1666666667;1695.1666666667\n';
    const saved = { ratings: { priors }, days: {
        d1: { id: 'd1', submissions: { r: { submittedAt: '2026-10-21T10:00:00Z', eloChanges: { p2: 5 * 29 / 6 }, answers: { comparisons: [] } } } }
    } };
    const replay = c.replaySurveyEloDeltas(saved);
    near(replay.deltas.d1.p2, 5 * 29 / 6);
    const historical = c.historicalSurveyElos(saved, '2026-10-22T10:00:00Z', replay);
    near(historical.p2, 1648 + 5 * 29 / 6);
});

test('overdue survey closure excludes matches played after its deadline', async () => {
    const { context: c, files } = fixture();
    files['spiele.csv'] = 'spieler_id;zeit;elo_vorher;elo_nachher\np2;2026-10-20T10:00:00Z;1700;1648\np2;2026-10-26T10:00:00Z;1672.1666666667;1695.1666666667\n';
    const delta = 5 * 29 / 6;
    const saved = { ratings: { priors }, days: {
        d1: { id: 'd1', participants: ['p2'], closesAt: '2026-10-22T10:00:00Z', results: {}, eloDeltas: { p2: delta },
            submissions: { r: { submittedAt: '2026-10-21T10:00:00Z', eloChanges: { p2: delta }, answers: { comparisons: [] } } } }
    } };
    await c.finalizeSurveyDays(saved, Date.parse('2026-10-28T10:00:00Z'));
    const change = saved.days.d1.eloHistory.changes[0];
    near(change.before, 1648);
    near(change.after, 1648 + delta);
});
