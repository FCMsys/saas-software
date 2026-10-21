'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8');
const source = html.slice(html.indexOf('        const STAT_KEYS ='), html.indexOf('        const POSITIONS ='));
const context = vm.createContext({});
vm.runInContext(source + '\nthis.api = { gesFromElo, eloFromStats, adjustAttrs };', context);
const { gesFromElo, eloFromStats, adjustAttrs } = context.api;
const stats = value => Object.fromEntries(['tem','sch','pas','drl','ver','phy'].map(key => [key,value]));
test('display rounds while Elo retains the unrounded mean and each attribute point', () => {
    assert.equal(gesFromElo(eloFromStats(stats(77.3))), 77);
    assert.equal(gesFromElo(eloFromStats(stats(77.6))), 78);
    const before = stats(77);
    const after = { ...before, tem: 78 };
    assert.ok(Math.abs(eloFromStats(after) - eloFromStats(before) - 29 / 6) < 1e-9);
});
test('fractional Elo changes survive inverse conversion and attribute caps', () => {
    for (const mode of ['zufall', 'deterministisch']) {
        for (const elo of [100, 1500.125, 1900.3, 2534]) {
            const result = adjustAttrs({ ...stats(77), tem: 99, ver: 1 }, elo, 'ST', null, mode);
            assert.ok(Math.abs(eloFromStats(result) - elo) < 1e-8);
            assert.ok(Object.values(result).every(value => value >= 1 && value <= 99));
        }
    }
});
