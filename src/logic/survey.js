'use strict';

const ATTRIBUTES = ['TEM', 'SCH', 'PAS', 'DRL', 'VER', 'PHY'];
const ATTRIBUTE_QUESTIONS = {
    TEM: 'Wer ist schneller und antrittsstärker?',
    SCH: 'Wer hat den besseren Torabschluss?',
    PAS: 'Wer ist der bessere Passspieler?',
    DRL: 'Wer ist im Dribbling und in der Ballkontrolle stärker?',
    VER: 'Wer verteidigt besser?',
    PHY: 'Wer ist körperlich robuster und zweikampfstärker?'
};
const COMPARISON_OPTIONS = ['a_much', 'a_slight', 'equal', 'b_slight', 'b_much', 'unsure'];
const OUTCOMES = { a_much: 0.9, a_slight: 0.65, equal: 0.5, b_slight: 0.35, b_much: 0.1 };
const RATING_SCALE = 12;
const PRIOR_SCALE = 12;

function randomIndex(length, random) {
    return Math.min(length - 1, Math.floor(random() * length));
}

function shuffled(items, random) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1, random);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function pairKey(a, b) {
    return [a, b].sort().join(':');
}

function surveyDeadline(finishedAt) {
    const time = Date.parse(finishedAt);
    if (!Number.isFinite(time)) throw new Error('Ungültiger Spielschluss-Zeitpunkt');
    return new Date(time + 48 * 60 * 60 * 1000).toISOString();
}

function isSurveyClosed(closesAt, now = Date.now()) {
    return now >= Date.parse(closesAt);
}

function countAwardVotes(submissions) {
    const votes = { surprise: {}, motm: {} };
    for (const submission of Object.values(submissions || {})) {
        for (const award of Object.keys(votes)) {
            const playerId = submission.answers && submission.answers[award];
            if (playerId && !['none', 'unsure'].includes(playerId)) votes[award][playerId] = (votes[award][playerId] || 0) + 1;
        }
    }
    return Object.fromEntries(Object.entries(votes).map(([award, counts]) => {
        const ranking = Object.entries(counts).map(([playerId, count]) => ({ playerId, votes: count }))
            .sort((a, b) => b.votes - a.votes || a.playerId.localeCompare(b.playerId));
        return [award, {
            ranking,
            winners: ranking.length ? ranking.filter(item => item.votes === ranking[0].votes) : []
        }];
    }));
}

function comparisonPair(respondentId, participants, usedPairs, comparisonCounts, random) {
    const candidates = participants.filter(player => player.id !== respondentId);
    const tiers = [3, 5];
    for (const maxDiff of tiers) {
        const available = [];
        for (let i = 0; i < candidates.length; i++) {
            for (let j = i + 1; j < candidates.length; j++) {
                const first = candidates[i], second = candidates[j];
                const key = pairKey(first.id, second.id);
                if (usedPairs.has(key) || Math.abs(first.ges - second.ges) > maxDiff) continue;
                available.push({ first, second, key });
            }
        }
        if (!available.length) continue;
        const minCount = Math.min(...available.map(pair => comparisonCounts[pair.key] || 0));
        const balanced = available.filter(pair => (comparisonCounts[pair.key] || 0) === minCount);
        const selected = balanced[randomIndex(balanced.length, random)];
        usedPairs.add(selected.key);
        comparisonCounts[selected.key] = (comparisonCounts[selected.key] || 0) + 1;
        const [a, b] = random() < 0.5 ? [selected.first, selected.second] : [selected.second, selected.first];
        return { a: a.id, b: b.id, maxGesDifference: maxDiff };
    }
    return null;
}

function generateQuestionnaire(respondentId, participants, comparisonCounts = {}, random = Math.random) {
    const valid = participants
        .filter(player => player && typeof player.id === 'string' && Number.isFinite(player.ges))
        .map(player => ({ ...player, ges: Math.round(player.ges) }));
    const eligible = valid.filter(player => player.id !== respondentId);
    const usedPairs = new Set();
    const performancePair = comparisonPair(respondentId, valid, usedPairs, comparisonCounts, random);
    const attributes = shuffled(ATTRIBUTES, random).slice(0, 3);
    const comparisons = [];
    if (performancePair) comparisons.push({ id: 'performance', kind: 'performance', prompt: 'Wer hat heute individuell besser gespielt?', ...performancePair });
    for (const attribute of attributes) {
        const pair = comparisonPair(respondentId, valid, usedPairs, comparisonCounts, random);
        if (pair) comparisons.push({ id: attribute, kind: 'attribute', attribute, prompt: ATTRIBUTE_QUESTIONS[attribute], ...pair });
    }
    return {
        nominations: {
            surprise: { eligible: eligible.map(player => player.id), options: ['none'] },
            motm: { eligible: eligible.map(player => player.id), options: ['unsure'] }
        },
        comparisons
    };
}

function validAnswer(questionnaire, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
    const { surprise, motm, comparisons } = answers;
    if (!(surprise === 'none' || questionnaire.nominations.surprise.eligible.includes(surprise))) return false;
    if (!(motm === 'unsure' || questionnaire.nominations.motm.eligible.includes(motm))) return false;
    if (!Array.isArray(comparisons) || comparisons.length !== questionnaire.comparisons.length) return false;
    const received = new Map(comparisons.map(answer => [answer.id, answer.value]));
    if (received.size !== questionnaire.comparisons.length) return false;
    return questionnaire.comparisons.every(question =>
        received.has(question.id) && COMPARISON_OPTIONS.includes(received.get(question.id))
    );
}

function updateAttributeRatings(priors, comparisons) {
    const ratings = {};
    for (const attribute of ATTRIBUTES) {
        const prior = Object.fromEntries(Object.entries(priors).map(([id, stats]) => [
            id, Math.max(1, Math.min(99, Number(stats[attribute]) || 50))
        ]));
        const relevant = comparisons.filter(item => item.attribute === attribute && OUTCOMES[item.value] !== undefined);
        const values = { ...prior };
        for (const item of relevant) {
            if (!(item.a in values)) values[item.a] = Math.max(1, Math.min(99, Number(item.priorA) || 50));
            if (!(item.b in values)) values[item.b] = Math.max(1, Math.min(99, Number(item.priorB) || 50));
        }
        const ids = Object.keys(values);
        for (let iteration = 0; iteration < 500; iteration++) {
            const gradients = Object.fromEntries(ids.map(id => [id, (values[id] - (prior[id] ?? values[id])) / (PRIOR_SCALE * PRIOR_SCALE)]));
            for (const item of relevant) {
                const probability = 1 / (1 + Math.exp(-(values[item.a] - values[item.b]) / RATING_SCALE));
                const gradient = (probability - OUTCOMES[item.value]) / RATING_SCALE;
                gradients[item.a] += gradient;
                gradients[item.b] -= gradient;
            }
            let largestChange = 0;
            for (const id of ids) {
                const change = Math.max(-1, Math.min(1, gradients[id] * 0.8));
                values[id] = Math.max(1, Math.min(99, values[id] - change));
                largestChange = Math.max(largestChange, Math.abs(change));
            }
            if (largestChange < 1e-5) break;
        }
        ratings[attribute] = Object.fromEntries(ids.map(id => [id, Math.max(1, Math.min(99, Math.round(values[id])))]));
    }
    return ratings;
}

module.exports = { ATTRIBUTES, ATTRIBUTE_QUESTIONS, COMPARISON_OPTIONS, OUTCOMES, generateQuestionnaire, validAnswer, updateAttributeRatings, surveyDeadline, isSurveyClosed, countAwardVotes };
