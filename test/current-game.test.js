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
