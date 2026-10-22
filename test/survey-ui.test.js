'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8');
const awardsSource = html.slice(html.indexOf('        function surveyAwardsHtml'), html.indexOf('        function surveySectionHtml'));

test('survey reminder is visible outside collapsed details only for outstanding open surveys', () => {
    const survey = { id: 'day', status: 'open', participantCount: 3, submittedCount: 1, closesAt: new Date(Date.now() + 3600000).toISOString() };
    const context = vm.createContext({ surveyDays: [survey], me: { mailEnabled: true }, escapeHtml: String, surveyAwardsHtml: () => '' });
    vm.runInContext(html.slice(html.indexOf('        function surveySectionHtml'), html.indexOf('        const surveyDetailState =')), context);
    const rendered = context.surveySectionHtml({ id: 'day' }, true);
    assert.match(rendered, /data-act="remindSurvey"/);
    assert.match(rendered, /An Umfrage erinnern/);
    survey.status = 'closed';
    assert.doesNotMatch(context.surveySectionHtml({ id: 'day' }, true), /data-act="remindSurvey"/);
    survey.status = 'open'; survey.submittedCount = 3;
    assert.doesNotMatch(context.surveySectionHtml({ id: 'day' }, true), /data-act="remindSurvey"/);
});
test('awards have separate sections before and after publication', () => {
    const context = vm.createContext({ escapeHtml: value => String(value), me: { role: 'player' } });
    vm.runInContext(awardsSource, context);
    const pending = context.surveyAwardsHtml({ id: 'day', results: null });
    assert.match(pending, /Man of the Match/);
    assert.match(pending, /Überraschung des Spieltags/);
    const published = context.surveyAwardsHtml({ id: 'day', results: {
        motm: { winners: [{ player: 'Alice', votes: 3 }], ranking: [{ player: 'Alice', votes: 3 }] },
        surprise: { winners: [{ player: 'Bob', votes: 2 }], ranking: [{ player: 'Bob', votes: 2 }] }
    } });
    assert.match(published, /award:motm[\s\S]*Alice[\s\S]*award:surprise[\s\S]*Bob/);
});

test('only admins see further nominations, users see all tied winners', () => {
    const context = vm.createContext({ escapeHtml: String, me: { role: 'player' } });
    vm.runInContext(awardsSource, context);
    const winners = [{ player: 'Alice', votes: 3 }, { player: 'Bob', votes: 3 }];
    const survey = { id: 'day', results: { motm: { winners, ranking: [...winners, { player: 'Other nominee', votes: 1 }] } } };
    const userView = context.surveyAwardsHtml(survey);
    assert.match(userView, /Alice/);
    assert.match(userView, /Bob/);
    assert.doesNotMatch(userView, /Weitere Nominierungen|Other nominee/);
    context.me.role = 'admin';
    assert.match(context.surveyAwardsHtml(survey), /Weitere Nominierungen[\s\S]*Other nominee/);
    context.me.role = 'player';
    delete survey.results.motm.ranking;
    assert.doesNotThrow(() => context.surveyAwardsHtml(survey));
});
test('refresh, temporary removal and reload preserve open and manually closed categories', () => {
    let details = [{ dataset: { surveyDetail: 'day:award:motm' }, open: true }, { dataset: { surveyDetail: 'day:award:surprise' }, open: false }];
    const storage = new Map();
    const list = { querySelectorAll: () => details, addEventListener() {}, set innerHTML(value) { details.forEach(detail => { detail.open = false; }); } };
    const context = vm.createContext({ $: () => list, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, me: { role: 'player' }, todayIso: () => '2026-10-21', sortedDays: () => [] });
    const source = html.slice(html.indexOf('        const surveyDetailState ='), html.indexOf("        $('daysList').onclick"));
    vm.runInContext(source, context);
    context.renderDays();
    assert.deepEqual(details.map(detail => detail.open), [true, false]);
    const saved = details;
    details = [];
    context.renderDays();
    details = saved;
    details.forEach(detail => { detail.open = false; });
    vm.runInContext("$('daysList').querySelectorAll('details[data-survey-detail]').forEach(detail => { detail.open = surveyDetailState.get(detail.dataset.surveyDetail) === true; });", context);
    assert.deepEqual(details.map(detail => detail.open), [true, false]);
    details[0].open = false;
    context.renderDays();
    assert.deepEqual(details.map(detail => detail.open), [false, false]);
    assert.equal(JSON.parse(storage.get('surveyDetailState'))[0][1], false);
});
