'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRepair } = require('../scripts/repair-elo');
const keys = ['TEM', 'SCH', 'PAS', 'DRL', 'VER', 'PHY'];
function fixture() {
    const headers = ['spieler_id', 'zeit', 'typ', 'elo_vorher', 'elo_nachher', 'delta'];
    const gameRows = [
        ['p1', '2026-01-01', 'start', 1700, 1700, 0],
        ['p1', '2026-01-02', 'match', 1700, 1673, -27],
        ['p1', '2026-01-03', 'match', 1673, 1648, -25],
        ['p1', '2026-01-06', 'match', 1659.1666666667, 1682.1666666667, 23],
        ['p1', '2026-01-07', 'match', 1682.1666666667, 1653.1666666667, -29],
        ['p1', '2026-01-08', 'match', 1653.1666666667, 1683.1666666667, 30],
        ['p2', '2026-01-01', 'start', 1500, 1500, 0],
        ['p2', '2026-01-02', 'manuell', 1500, 1400, -100],
        ['p2', '2026-01-03', 'manuell', 1500, 1400, -100]
    ];
    const day = (id, finishedAt, closesAt, before, delta) => ({
        id, finishedAt, closesAt, results: {}, participants: ['p1'], submissions: {},
        eloDeltas: { p1: delta },
        eloHistory: { id: 'survey:' + id, dayId: id, t: closesAt, changes: [{ playerId: 'p1', before, after: before + delta, delta }] }
    });
    return {
        'spieler.csv': 'id;name;elo;tem;sch;pas;drl;ver;phy\np1;Test;1692.8333333333;50;50;50;50;50;50\np2;Manual;1400;50;50;50;50;50;50\n',
        'spiele.csv': [headers, ...gameRows].map(row => row.join(';')).join('\n') + '\n',
        'umfragen.json': JSON.stringify({
            ratings: { priors: Object.fromEntries(['p1', 'p2'].map(id => [id, Object.fromEntries(keys.map(key => [key, 50]))])),
                current: Object.fromEntries(keys.map(key => [key, { p1: 50, p2: 50 }])) },
            days: { d1: day('d1', '2026-01-04', '2026-01-05', 1635, 5 * 29 / 6), d2: day('d2', '2026-01-10', '2026-01-11', 1683.1666666667, 2 * 29 / 6) }
        })
    };
}
test('repair restores the complete Elo chain while preserving game deltas and survey results', () => {
    const original = fixture(), before = JSON.stringify(original), repaired = buildRepair(original);
    assert.equal(JSON.stringify(original), before, 'preview must not mutate its input');
    assert.ok(Math.abs(repaired.report[0].after - 1705.8333333333) < 1e-8);
    const saved = JSON.parse(repaired.files['umfragen.json']);
    assert.equal(saved.days.d1.eloHistory.changes[0].before, 1648);
    assert.ok(Math.abs(saved.days.d2.eloHistory.changes[0].after - repaired.report[0].after) < 1e-8);
    const matches = csv => csv.split(/\r?\n/).filter(row => row.includes(';match;')).map(row => row.split(';').at(-1));
    assert.deepEqual(matches(repaired.files['spiele.csv']), matches(original['spiele.csv']));
    assert.deepEqual(buildRepair(repaired.files).files, repaired.files);
});
test('duplicate manual adjustments retain the absolute target instead of subtracting twice', () => {
    const repaired = buildRepair(fixture());
    assert.equal(repaired.report[1].after, 1400);
    const entries = repaired.files['spiele.csv'].split(/\r?\n/).filter(row => row.includes(';manuell;'));
    assert.equal(entries[1].split(';').at(-1), '0');
});
test('repair refuses inconsistent stored survey deltas', () => {
    const snapshot = fixture(), saved = JSON.parse(snapshot['umfragen.json']);
    saved.days.d1.eloDeltas.p1++;
    snapshot['umfragen.json'] = JSON.stringify(saved);
    assert.throws(() => buildRepair(snapshot), /Survey delta mismatch/);
});
test('repair refuses unpublished surveys and interleaved games requiring individual review', () => {
    const snapshot = fixture(), saved = JSON.parse(snapshot['umfragen.json']);
    saved.days.d1.results = null;
    snapshot['umfragen.json'] = JSON.stringify(saved);
    assert.throws(() => buildRepair(snapshot), /closed and published/);
    snapshot['umfragen.json'] = fixture()['umfragen.json'];
    snapshot['spiele.csv'] = snapshot['spiele.csv'].replace('2026-01-06', '2026-01-04');
    assert.throws(() => buildRepair(snapshot), /individual review/);
});
