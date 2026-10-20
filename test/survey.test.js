'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ATTRIBUTES, generateQuestionnaire, validAnswer, updateAttributeRatings, surveyDeadline, isSurveyClosed, countAwardVotes } = require('../src/logic/survey');

const players = [
    { id: 'p1', ges: 50 }, { id: 'p2', ges: 51 }, { id: 'p3', ges: 52 },
    { id: 'p4', ges: 53 }, { id: 'p5', ges: 54 }, { id: 'p6', ges: 55 }
];

test('questionnaire excludes respondent and keeps pairs unique within the GES threshold', () => {
    const questionnaire = generateQuestionnaire('p1', players, {}, () => 0.3);
    const pairs = questionnaire.comparisons.map(question => [question.a, question.b].sort().join(':'));
    assert.equal(questionnaire.comparisons.length, 4);
    assert.equal(new Set(pairs).size, pairs.length);
    for (const question of questionnaire.comparisons) {
        assert.notEqual(question.a, 'p1');
        assert.notEqual(question.b, 'p1');
        assert.ok(Math.abs(players.find(p => p.id === question.a).ges - players.find(p => p.id === question.b).ges) <= 5);
    }
    assert.equal(new Set(questionnaire.comparisons.filter(q => q.kind === 'attribute').map(q => q.attribute)).size, 3);
});

test('pairing falls back to five points but never exceeds that limit', () => {
    const questionnaire = generateQuestionnaire('p1', [{ id: 'p1', ges: 40 }, { id: 'p2', ges: 45 }, { id: 'p3', ges: 50 }], {}, () => 0);
    assert.equal(questionnaire.comparisons.length, 1);
    assert.equal(questionnaire.comparisons[0].maxGesDifference, 5);
    const tooFar = generateQuestionnaire('p1', [{ id: 'p1', ges: 40 }, { id: 'p2', ges: 46 }, { id: 'p3', ges: 55 }], {}, () => 0);
    assert.equal(tooFar.comparisons.length, 0);
});

test('pair selection handles differences of zero, three, four, five and more than five', () => {
    for (const [difference, expectedCount, threshold] of [[0, 1, 3], [3, 1, 3], [4, 1, 5], [5, 1, 5], [6, 0, null]]) {
        const questionnaire = generateQuestionnaire('r', [
            { id: 'r', ges: 40 }, { id: 'a', ges: 50 }, { id: 'b', ges: 50 + difference }
        ], {}, () => 0.2);
        assert.equal(questionnaire.comparisons.length, expectedCount, `difference ${difference}`);
        if (threshold !== null) assert.equal(questionnaire.comparisons[0].maxGesDifference, threshold);
    }
});

test('answer validation requires the saved questionnaire choices', () => {
    const questionnaire = generateQuestionnaire('p1', players, {}, () => 0.2);
    const answers = {
        surprise: 'none', motm: 'unsure',
        comparisons: questionnaire.comparisons.map(question => ({ id: question.id, value: 'equal' }))
    };
    assert.equal(validAnswer(questionnaire, answers), true);
    assert.equal(validAnswer(questionnaire, { ...answers, surprise: 'p1' }), false);
    assert.equal(validAnswer(questionnaire, { ...answers, comparisons: [] }), false);
});

test('deadline is exactly 48 hours after finish and closes at the exact instant', () => {
    const finishedAt = '2026-10-20T14:30:00.000Z';
    const closesAt = surveyDeadline(finishedAt);
    assert.equal(closesAt, '2026-10-22T14:30:00.000Z');
    assert.equal(isSurveyClosed(closesAt, Date.parse(closesAt) - 1), false);
    assert.equal(isSurveyClosed(closesAt, Date.parse(closesAt)), true);
    assert.throws(() => surveyDeadline('invalid'));
});

test('award counting ignores abstentions and records tied winners', () => {
    const results = countAwardVotes({
        p1: { answers: { surprise: 'pA', motm: 'pB' } },
        p2: { answers: { surprise: 'pB', motm: 'pB' } },
        p3: { answers: { surprise: 'none', motm: 'unsure' } }
    });
    assert.deepEqual(results.surprise.winners.map(item => item.playerId), ['pA', 'pB']);
    assert.equal(results.surprise.ranking[0].votes, 1);
    assert.deepEqual(results.motm.winners.map(item => item.playerId), ['pB']);
    assert.equal(results.motm.ranking[0].votes, 2);
});

test('attribute ratings respond deterministically to comparisons and stay bounded', () => {
    const priors = Object.fromEntries(players.map(player => [player.id, Object.fromEntries(ATTRIBUTES.map(attribute => [attribute, 50]))]));
    const comparisons = [
        { attribute: 'TEM', a: 'p2', b: 'p3', value: 'a_slight' },
        { attribute: 'TEM', a: 'p2', b: 'p3', value: 'a_slight' }
    ];
    const first = updateAttributeRatings(priors, comparisons);
    const second = updateAttributeRatings(priors, comparisons);
    assert.deepEqual(first, second);
    assert.ok(first.TEM.p2 > first.TEM.p3);
    assert.ok(Object.values(first.TEM).every(value => value >= 1 && value <= 99));
});
