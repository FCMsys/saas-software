'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8');
const source = html.slice(html.indexOf('        function playerCardAward('), html.indexOf('        function cardHtml('));

test('special cards start at publication, honor ties and end after a week or the next finished day', () => {
    const published = Date.parse('2026-10-20T18:00:00Z');
    const day = { id: 'one', finishedAt: '2026-10-18T18:00:00Z', closesAt: new Date(published).toISOString(), status: 'closed', results: {
        motm: { winners: [{ playerId: 'a' }, { playerId: 'b' }] },
        surprise: { winners: [{ playerId: 'a' }, { playerId: 'c' }] }
    } };
    const context = vm.createContext({ surveyDays: [day] });
    vm.runInContext(source, context);
    const award = (id, now = published) => context.playerCardAward(id, now);
    assert.equal(award('a').kind, 'motm');
    assert.match(award('a').label, /Man of the Match.*Überraschungsspieler/);
    assert.equal(award('b').kind, 'motm');
    assert.equal(award('c').kind, 'surprise');
    assert.equal(award('other'), null);
    assert.equal(award('a', published - 1), null);
    assert.ok(award('a', published + 7 * 86400000 - 1));
    assert.equal(award('a', published + 7 * 86400000), null);
    context.surveyDays.push({ id: 'two', finishedAt: '2026-10-22T18:00:00Z', status: 'open', results: null });
    assert.equal(award('a', Date.parse('2026-10-22T18:00:00Z')), null);
});
