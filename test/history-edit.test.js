const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('random.html', 'utf8');
function fixture() {
    const context = vm.createContext({ players: ['a','b','oak'].map(id => ({ id, name: id, elo: 1500, history: [{seq:0,t:'2026-01-01',elo:1500,delta:0,matchId:null}] })), matchHistory: [], surveyEloHistory: [], applyEloToStats() {}, K_FACTOR:32 });
    vm.runInContext(html.slice(html.indexOf('        function computeChange('), html.indexOf('        function playingTeams(')) + html.slice(html.indexOf('        function correctHistoricalMatches('), html.indexOf('        function openHistoricalEditor(')), context);
    const add = (id, a, b, goalsA=1, goalsB=0) => {
        const seq=context.matchHistory.length+1, iso=`2026-01-0${seq+1}`;
        const change=context.computeChange({teamA:a.map(id=>context.players.find(p=>p.id===id)),teamB:b.map(id=>context.players.find(p=>p.id===id))},goalsA,goalsB);
        const team=(ids,delta)=>ids.map(id=>{ const p=context.players.find(p=>p.id===id),before=p.elo; p.elo=Math.max(100,before+delta); const entry={id,name:id,before,after:p.elo,delta:p.elo-before};p.history.push({seq,t:iso,elo:p.elo,delta:entry.delta,matchId:id+'_match'});return entry; });
        const m={id,seq,iso,goalsA,goalsB,result:change.result,teamA:team(a,change.changeA),teamB:team(b,-change.changeA)};
        for(const p of context.players) {const h=p.history.at(-1); if(h.seq===seq) h.matchId=id;}
        context.matchHistory.push(m);
    };
    return {context,add};
}
test('removing injured player replays subsequent games like a corrected original recording',()=>{
    const actual=fixture(), expected=fixture();
    actual.add('m1',['a','oak'],['b']);actual.add('m2',['a','oak'],['b']);actual.add('m3',['a'],['b']);
    expected.add('m1',['a','oak'],['b']);expected.add('m2',['a'],['b']);expected.add('m3',['a'],['b']);
    actual.context.correctHistoricalMatches([{id:'m2',teamA:['a'],teamB:['b'],goalsA:1,goalsB:0}]);
    assert.deepEqual(JSON.parse(JSON.stringify(actual.context.players)),JSON.parse(JSON.stringify(expected.context.players)));
    assert.deepEqual(JSON.parse(JSON.stringify(actual.context.matchHistory)),JSON.parse(JSON.stringify(expected.context.matchHistory)));
});
test('changed result and adding player use historical ratings; invalid edit does not mutate',()=>{
    const actual=fixture(),expected=fixture();
    actual.add('m1',['a'],['b']);actual.add('m2',['a'],['b']);
    expected.add('m1',['a','oak'],['b'],0,3);expected.add('m2',['a'],['b']);
    actual.context.correctHistoricalMatches([{id:'m1',teamA:['a','oak'],teamB:['b'],goalsA:0,goalsB:3}]);
    assert.deepEqual(JSON.parse(JSON.stringify(actual.context.players)),JSON.parse(JSON.stringify(expected.context.players)));
    const before=JSON.stringify(actual.context.players);
    assert.throws(()=>actual.context.correctHistoricalMatches([{id:'m1',teamA:[],teamB:['b'],goalsA:0,goalsB:3}]));
    assert.equal(JSON.stringify(actual.context.players),before);
});
test('manual Elo anchors survive corrections and govern subsequent matches',()=>{
    const {context,add}=fixture();add('m1',['a'],['b']);
    const a=context.players[0];a.elo=1700;a.history.push({seq:1,t:'2026-01-02T12:00:00Z',elo:1700,delta:184,matchId:null});
    add('m2',['a'],['b']);
    context.correctHistoricalMatches([{id:'m1',teamA:['a'],teamB:['b'],goalsA:0,goalsB:1}]);
    assert.equal(context.matchHistory[1].teamA[0].before,1700);
    assert.equal(context.players[0].history.find(h=>!h.matchId&&h.seq===1).elo,1700);
});
test('inline scripts remain syntactically valid',()=>{
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) if(match[1].trim()) new vm.Script(match[1]);
});
