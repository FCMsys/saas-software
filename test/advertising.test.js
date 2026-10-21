'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('    function adSettings(');
const end = source.indexOf("    if (url === '/api/werbung'", start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
test('advertising settings preserve layout and timing and supply legacy defaults', () => {
    const settings = context.adSettings({ fontFamily: 'Georgia', fontSize: 12, textX: 24, imageY: 75, flightSeconds: 2.5, idleSeconds: 0 }, true);
    assert.equal(settings.fontFamily, 'Georgia');
    assert.equal(settings.fontSize, 12);
    assert.equal(settings.textX, 24);
    assert.equal(settings.imageY, 75);
    assert.equal(settings.flightSeconds, 2.5);
    assert.equal(settings.idleSeconds, 0);
    assert.equal(context.adSettings({}).flightSeconds, 8);
    assert.equal(context.adSettings({}).idleSeconds, 5);
});
test('advertising settings reject invalid timing, coordinates and fonts', () => {
    for (const input of [{ idleSeconds: -1 }, { flightSeconds: 0 }, { textX: 101 }, { imageSize: '50' }, { fontSize: Infinity }, { fontFamily: 'unknown' }])
        assert.throws(() => context.adSettings(input, true));
    assert.equal(context.adSettings({ idleSeconds: -1 }).idleSeconds, 5);
});
