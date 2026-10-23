'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8').replace(/\r\n/g, '\n');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

test('current teams survive day entry, attendance refresh and reload until replaced or submitted', () => {
    const storage = new Map();
    const context = vm.createContext({
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        players: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, elo: 1500, history: [] })),
        selectedPlayerIds: new Set(['a', 'b']), currentTeams: null, matchDayId: 'original',
        spieltage: [{ id: 'original' }, { id: 'other' }], confirmedIds: () => ['c', 'd'],
        renderMatchTab() {}, showTab() {}, readScore: () => ({ gA: 1, gB: 0 }),
        computeChange: () => ({ result: 'A', changeA: 16 }), currentSeq: () => 0,
        applyEloToStats() {}, matchHistory: [], serverMode: false,
        $: () => ({}), saveApplicationData() {}, renderAll() {}, showToast() {}
    });
    vm.runInContext("const CURRENT_GAME_STORAGE_KEY = 'game';\n" +
        section('        function saveCurrentGame()', '        function defaultState()') +
        section('        function playingTeams()', '        function readScore()') +
        section('        function generateBalancedTeams(', '        // =====================================================================\n        // 6. Rendering') +
        section('        function applyMatchDay()', "        $('matchDaySel').onchange") +
        section('        function processMatchResult()', '        // =====================================================================\n        // 5. Teams'), context);
    vm.runInContext('generateBalancedTeams(false);', context);
    const original = storage.get('game');
    const entry = section("                } else if (act === 'match') {", "                } else if (act === 'bill') {");
    vm.runInContext("(() => { const st = 'other'; " + entry.slice(entry.indexOf('const d =')) + ' })();', context);
    assert.equal(context.matchDayId, 'original');
    assert.equal(storage.get('game'), original);
    vm.runInContext('applyMatchDay(); currentTeams = null; restoreCurrentGame();', context);
    assert.deepEqual(Array.from(context.currentTeams.teamA, p => p.id), ['a']);
    assert.deepEqual(Array.from(context.currentTeams.teamB, p => p.id), ['b']);
    vm.runInContext('generateBalancedTeams(false);', context);
    assert.deepEqual(Array.from(context.currentTeams.teamA, p => p.id), ['c']);
    assert.deepEqual(Array.from(context.currentTeams.teamB, p => p.id), ['d']);
    vm.runInContext('processMatchResult(); restoreCurrentGame();', context);
    assert.equal(context.currentTeams, null);
    assert.equal(storage.has('game'), false);
    assert.equal(context.matchHistory.length, 1);
});

function threeTeamContext(count = 15) {
    const storage = new Map();
    const elements = new Map();
    const roster = Array.from({ length: count }, (_, i) => ({ id: String(i), name: String(i), elo: 1800 - i * 40, history: [] }));
    const context = vm.createContext({
        players: roster, selectedPlayerIds: new Set(roster.map(p => p.id)), currentTeams: null,
        matchDayId: '', matchHistory: [], serverMode: false,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        $: id => {
            if (!elements.has(id)) elements.set(id, { value: id === 'teamCountSelect' ? '3' : '' });
            return elements.get(id);
        },
        renderMatchTab() {}, renderAll() {}, saveApplicationData() {}, showToast() {},
        readScore: () => ({ gA: 2, gB: 0 }), currentSeq: () => 0,
        computeChange: () => ({ result: 'A', changeA: 16 }), applyEloToStats() {}
    });
    vm.runInContext("const CURRENT_GAME_STORAGE_KEY = 'game';\n" +
        section('        function saveCurrentGame()', '        function defaultState()') +
        section('        function playingTeams()', '        function readScore()') +
        section('        function generateBalancedTeams(', '        // =====================================================================\n        // 6. Rendering') +
        section('        function processMatchResult()', '        // =====================================================================\n        // 5. Teams'), context);
    return { context, elements, storage };
}

test('two and three teams have balanced sizes and every selected player exactly once', () => {
    for (const teamCount of [2, 3]) {
        for (const count of [3, 15, 16, 17]) {
            const { context, elements } = threeTeamContext(count);
            elements.set('teamCountSelect', { value: String(teamCount) });
            vm.runInContext('generateBalancedTeams(false);', context);
            const teams = Object.values(context.currentTeams);
            assert.equal(teams.length, teamCount);
            assert.equal(new Set(teams.flat().map(p => p.id)).size, count);
            assert.equal(teams.flat().length, count);
            assert.ok(Math.max(...teams.map(t => t.length)) - Math.min(...teams.map(t => t.length)) <= 1);
            if (count === 15 && teamCount === 3) {
                const totals = teams.map(t => t.reduce((sum, p) => sum + p.elo, 0));
                assert.ok(Math.max(...totals) - Math.min(...totals) <= 80);
            }
        }
    }
});

test('three teams survive reload, players cycle through teams and only the chosen pair receives Elo', () => {
    const { context, elements, storage } = threeTeamContext();
    vm.runInContext('generateBalancedTeams(false);', context);
    const original = storage.get('game');
    vm.runInContext('currentTeams = null; restoreCurrentGame();', context);
    assert.equal(JSON.stringify(context.currentTeams.teamC.map(p => p.id)), JSON.stringify(JSON.parse(original).teamC));
    const player = context.currentTeams.teamA[0];
    vm.runInContext(`movePlayer('${player.id}');`, context);
    assert.ok(context.currentTeams.teamB.some(p => p.id === player.id));
    vm.runInContext(`movePlayer('${player.id}');`, context);
    assert.ok(context.currentTeams.teamC.some(p => p.id === player.id));
    vm.runInContext(`movePlayer('${player.id}');`, context);
    assert.ok(context.currentTeams.teamA.some(p => p.id === player.id));
    const idleElos = context.currentTeams.teamA.map(p => p.elo);
    elements.get('matchPairSelect').value = 'BC';
    vm.runInContext('processMatchResult();', context);
    assert.deepEqual(context.currentTeams.teamA.map(p => p.elo), idleElos);
    const match = context.matchHistory[0];
    assert.deepEqual(Array.from(match.teamA, p => p.id), Array.from(context.currentTeams.teamB, p => p.id));
    assert.deepEqual(Array.from(match.teamB, p => p.id), Array.from(context.currentTeams.teamC, p => p.id));
    assert.ok(match.teamA.every(p => p.delta === 16));
    assert.ok(match.teamB.every(p => p.delta === -16));
    assert.ok(storage.has('game'));
});

test('odd two-team lineups favor tempo and physique in the smaller team without omitting players', () => {
    for (const emphasized of [['tem'], ['phy'], ['tem', 'phy']]) {
        for (const count of [3, 9, 11, 15]) {
            const { context, elements } = threeTeamContext(count);
            elements.set('teamCountSelect', { value: '2' });
            context.players.forEach((p, i) => {
                p.elo = 1500;
                p.stats = { tem: 50, phy: 50 };
                for (const key of emphasized) p.stats[key] = 20 + i * 5;
            });
            vm.runInContext('generateBalancedTeams(false);', context);
            const teams = Object.values(context.currentTeams).sort((a, b) => a.length - b.length);
            const [small, large] = teams;
            assert.equal(small.length, Math.floor(count / 2));
            assert.equal(large.length, Math.ceil(count / 2));
            assert.equal(new Set(teams.flat().map(p => p.id)).size, count);
            for (const key of emphasized) {
                const avg = list => list.reduce((sum, p) => sum + p.stats[key], 0) / list.length;
                assert.ok(avg(small) > avg(large), `${count} players: smaller team should favor ${key}`);
            }
        }
    }
});

test('physical compensation respects the Elo bound and handles missing attributes', () => {
    const { context, elements } = threeTeamContext(11);
    elements.set('teamCountSelect', { value: '2' });
    context.players.forEach((p, i) => {
        p.elo = 1500 + i * 10;
        p.stats = i === 0 ? undefined : { tem: 99 - i * 8, phy: 99 - i * 8 };
    });
    vm.runInContext('generateBalancedTeams(false);', context);
    const avg = team => team.reduce((sum, p) => sum + p.elo, 0) / team.length;
    assert.ok(Math.abs(avg(context.currentTeams.teamA) - avg(context.currentTeams.teamB)) <= 58);
    assert.equal(Object.values(context.currentTeams).flat().length, 11);
});
