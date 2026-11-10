'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ATTRIBUTES, generateQuestionnaire, generateSurveyQuestionnaires, previouslyUncompared, validAnswer, normalizeSurveyAnswers, updateAttributeRatings, surveyDeadline, isSurveyClosed, countAwardVotes } = require('../src/logic/survey');

const players = [
    { id: 'p1', ges: 50 }, { id: 'p2', ges: 51 }, { id: 'p3', ges: 52 },
    { id: 'p4', ges: 53 }, { id: 'p5', ges: 54 }, { id: 'p6', ges: 55 }
];

test('questionnaire excludes respondent and keeps pairs unique within three rank positions', () => {
    const questionnaire = generateQuestionnaire('p1', players, {}, () => 0.3);
    const pairs = questionnaire.comparisons.map(question => [question.a, question.b].sort().join(':'));
    assert.equal(questionnaire.comparisons.length, 4);
    assert.equal(new Set(pairs).size, pairs.length);
    for (const question of questionnaire.comparisons) {
        assert.notEqual(question.a, 'p1');
        assert.notEqual(question.b, 'p1');
        assert.ok(Math.abs(players.findIndex(p => p.id === question.a) - players.findIndex(p => p.id === question.b)) <= 3);
    }
    assert.equal(new Set(questionnaire.comparisons.filter(q => q.kind === 'attribute').map(q => q.attribute)).size, 3);
});

test('large GES gaps do not exclude rank neighbors; fewer than three players have no pairs', () => {
    const spread = [{ id: 'p1', ges: 10 }, { id: 'p2', ges: 50 }, { id: 'p3', ges: 99 }];
    assert.equal(generateQuestionnaire('p1', spread, {}, () => 0).comparisons.length, 1);
    assert.equal(generateQuestionnaire('p1', spread.slice(0, 2), {}, () => 0).comparisons.length, 0);
});

test('rank positions include respondent and ties use stable IDs regardless of input order', () => {
    const tied = players.map(p => ({ ...p, ges: 50 }));
    assert.deepEqual(generateQuestionnaire('p3', tied, {}, () => 0.7), generateQuestionnaire('p3', [...tied].reverse(), {}, () => 0.7));
    for (let seed = 1; seed <= 100; seed++) {
        let state = seed;
        const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
        for (const q of generateQuestionnaire('p3', tied, {}, random).comparisons) {
            assert.ok(Math.abs(tied.findIndex(p => p.id === q.a) - tied.findIndex(p => p.id === q.b)) <= 3);
        }
    }
});

function historicalDay(participants, comparisons = [], answers = [], finishedAt = '2026-10-01T10:00:00Z') {
    return { participants, finishedAt, closesAt: surveyDeadline(finishedAt),
        forms: { r: { comparisons } }, submissions: { r: { answers: { comparisons: answers } } } };
}

test('without missed players the batch keeps the same pure random selection as individual forms', () => {
    const makeRandom = () => {
        let state = 29;
        return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    };
    const random = makeRandom();
    const expected = Object.fromEntries(players.map(player => [player.id, generateQuestionnaire(player.id, players, {}, random)]));
    assert.deepEqual(generateSurveyQuestionnaires(players, {}, makeRandom()), expected);
});

test('protection uses latest completed own day and only usable saved comparison answers', () => {
    const older = historicalDay(['p1', 'p2', 'p3'], [{ id: 'TEM', a: 'p1', b: 'p2' }], [{ id: 'TEM', value: 'equal' }]);
    const latest = historicalDay(['p1', 'p3', 'p4'], [{ id: 'performance', a: 'p1', b: 'p3' }], [{ id: 'performance', value: 'unsure' }], '2026-10-05T10:00:00Z');
    const unrelated = historicalDay(['other'], [], [], '2026-10-10T10:00:00Z');
    const open = historicalDay(['p2'], [], [], '2026-10-20T10:00:00Z');
    const history = { unrelated, older, open, latest };
    const now = Date.parse('2026-10-21T10:00:00Z');
    assert.deepEqual(previouslyUncompared(players, history, now), ['p1', 'p3', 'p4']);
    latest.submissions.r.answers.comparisons[0].value = 'a_slight';
    assert.deepEqual(previouslyUncompared(players, history, now), ['p4']);
    assert.deepEqual(previouslyUncompared(players, {}, now), []);
});

test('all previously missed participants get a valid reserved appearance across random seeds', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    for (const count of [0, 1, 2, 3, 4, 6, 10, 20]) {
        const roster = Array.from({ length: count }, (_, i) => ({ id: `p${i.toString().padStart(2, '0')}`, ges: i * 7 }));
        const history = { last: historicalDay(roster.map(p => p.id)) };
        for (let seed = 1; seed <= 50; seed++) {
            let state = seed;
            const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
            const forms = generateSurveyQuestionnaires(roster, history, random, now);
            const appearances = new Set();
            for (const [respondent, form] of Object.entries(forms)) {
                const pairs = new Set();
                assert.ok(form.comparisons.length <= 4);
                for (const q of form.comparisons) {
                    assert.notEqual(q.a, respondent);
                    assert.notEqual(q.b, respondent);
                    const key = [q.a, q.b].sort().join(':');
                    assert.ok(!pairs.has(key));
                    pairs.add(key);
                    assert.ok(Math.abs(roster.findIndex(p => p.id === q.a) - roster.findIndex(p => p.id === q.b)) <= 3);
                    appearances.add(q.a); appearances.add(q.b);
                }
            }
            assert.equal(appearances.size, count >= 3 ? count : 0);
        }
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

test('answer normalization accepts the keyed answers saved by the survey UI', () => {
    const questionnaire = generateQuestionnaire('p1', players, {}, () => 0.2);
    const keyed = { surprise: 'none', motm: 'unsure' };
    for (const question of questionnaire.comparisons) keyed[question.id] = 'equal';
    assert.deepEqual(normalizeSurveyAnswers(questionnaire, keyed), {
        surprise: 'none',
        motm: 'unsure',
        comparisons: questionnaire.comparisons.map(question => ({ id: question.id, value: 'equal' }))
    });
    assert.equal(normalizeSurveyAnswers(questionnaire, { ...keyed, unexpected: 'equal' }), null);
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
