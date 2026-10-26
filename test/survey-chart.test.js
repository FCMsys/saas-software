'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8');
const source = html.slice(html.indexOf('        function chartPlayerHistories()'), html.indexOf('        // 7. Tabs'));
function fixture() {
    const player = { id: 'p1', name: 'Alice', elo: 1529.833333, history: [
        { seq: 0, t: '2026-10-01T00:00:00Z', elo: 1500, delta: 0 },
        { seq: 0, t: '2026-10-01T12:00:00Z', elo: 1510, delta: 10, matchId: null },
        { seq: 1, t: '2026-10-02T00:00:00Z', elo: 1525, delta: 25, matchId: 'm1' },
        { seq: 1, t: '2026-10-04T00:00:00Z', elo: 1535, delta: 5.166667, matchId: null },
        { seq: 2, t: '2026-10-05T00:00:00Z', elo: 1554.833333, delta: 25, matchId: 'm2' }
    ] };
    const elements = Object.fromEntries(['chartLegend','eloChart','chartWrap','chartTooltip','chartCursor'].map(id => [id, {
        innerHTML: '', style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 700, offsetWidth: 100
    }]));
    const survey = {id:'survey:d1',dayNumber:1,t:'2026-10-03T00:00:00Z',changes:[{playerId:'p1',before:1525,after:1529.833333,delta:4.833333}]};
    const context = vm.createContext({
        players: [player], surveyEloHistory: [survey], matchHistory: [{id:'m1'},{id:'m2'}], hiddenInChart:new Set(),
        $: id => elements[id], document: {createElement:()=>({})}, playerColor:()=>'blue',
        formatElo: value => String(Math.round(value)), formatDelta: value => '+' + Math.round(value), deltaClass:()=>'', escapeHtml:String
    });
    vm.runInContext(source, context);
    return { context, player, elements };
}
test('survey points appear chronologically between matches without changing stored match sequences', () => {
    const {context,player}=fixture();
    const before=JSON.stringify(player.history);
    const chart=context.chartPlayerHistories();
    const points=chart.histories.get('p1');
    assert.deepEqual(Array.from(points,point=>point.chartKey),['start','m1','survey:d1','m2']);
    assert.equal(points[2].surveyDayNumber,1);
    assert.equal(points[2].elo,1529.833333);
    assert.equal(points[2].delta,4.833333);
    assert.equal(JSON.stringify(player.history),before);
    assert.equal(context.chartPlayerHistories().histories.get('p1').length,4);
});
test('chart removes X labels and identifies a survey in its hover tooltip', () => {
    const {context,elements}=fixture();
    context.renderChart();
    const svg=elements.eloChart.innerHTML;
    assert.doesNotMatch(svg, />Start<|>#\d+</);
    const dots=[...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)];
    assert.equal(dots.length,4);
    elements.eloChart.onmousemove({clientX:Number(dots[2][1]),clientY:Number(dots[2][2])});
    assert.match(elements.chartTooltip.innerHTML,/Umfrage 1\. Spieltag/);
    assert.doesNotMatch(elements.chartTooltip.innerHTML,/manuell/);
    assert.match(elements.chartTooltip.innerHTML,/1530/);
});

test('chart renders players added after matches and tolerates an empty filtered history', () => {
    const {context, elements} = fixture();
    context.players.push({id:'new', name:'New player', elo:1500, history:[
        {seq:2, t:'2026-10-06T00:00:00Z', elo:1500, delta:0, matchId:null}
    ]});
    context.players.push({id:'manual', name:'Manual only', elo:1510, history:[
        {seq:2, t:'2026-10-06T00:00:00Z', elo:1510, delta:10, matchId:null}
    ]});
    assert.equal(context.chartPlayerHistories().histories.get('new').length, 1);
    assert.doesNotThrow(() => context.renderChart());
    assert.match(elements.eloChart.innerHTML, /New player/);
    assert.doesNotMatch(elements.eloChart.innerHTML, /NaN|Infinity/);
});
