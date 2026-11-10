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

function rankedParticipants(participants) {
    return participants
        .filter(player => player && typeof player.id === 'string' && Number.isFinite(player.ges))
        .map(player => ({ ...player, ges: Math.round(player.ges) }))
        .sort((a, b) => a.ges - b.ges || a.id.localeCompare(b.id));
}

function neighborPairs(participants) {
    const pairs = [];
    // Rank in the complete participant list, before excluding the respondent.
    for (let i = 0; i < participants.length; i++) {
        for (let j = i + 1; j < Math.min(participants.length, i + 4); j++) {
            pairs.push({ a: participants[i].id, b: participants[j].id, maxRankDifference: 3 });
        }
    }
    return pairs;
}

function generateQuestionnaire(respondentId, participants, options = {}, random = Math.random) {
    const valid = rankedParticipants(participants);
    const eligible = valid.filter(player => player.id !== respondentId);
    const available = neighborPairs(valid).filter(pair => pair.a !== respondentId && pair.b !== respondentId);
    const reserved = options.reservedPairs || [];
    const selected = reserved.map(pair => available.find(candidate => pairKey(candidate.a, candidate.b) === pairKey(pair.a, pair.b)))
        .filter(Boolean);
    const used = new Set(selected.map(pair => pairKey(pair.a, pair.b)));
    const remaining = shuffled(available.filter(pair => !used.has(pairKey(pair.a, pair.b))), random);
    selected.push(...remaining.slice(0, 4 - selected.length));
    // Reserved pairs have no fixed question type or left/right position.
    const pairs = shuffled(selected, random).map(pair => random() < 0.5 ? pair : { ...pair, a: pair.b, b: pair.a });
    const performancePair = pairs.shift();
    const attributes = shuffled(ATTRIBUTES, random).slice(0, 3);
    const comparisons = [];
    if (performancePair) comparisons.push({ id: 'performance', kind: 'performance', prompt: 'Wer hat heute individuell besser gespielt?', ...performancePair });
    for (const attribute of attributes) {
        const pair = pairs.shift();
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

function previouslyUncompared(participants, days, now = Date.now()) {
    const history = Object.values(days || {}).filter(day => isSurveyClosed(day.closesAt, now))
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
    return participants.filter(player => {
        const day = history.find(day => (day.participants || []).includes(player.id));
        if (!day) return false;
        return !Object.entries(day.submissions || {}).some(([respondentId, submission]) =>
            (submission.answers?.comparisons || []).some(answer => {
                if (!Object.hasOwn(OUTCOMES, answer.value)) return false;
                const question = day.forms?.[respondentId]?.comparisons?.find(question => question.id === answer.id);
                return question && (question.a === player.id || question.b === player.id);
            })
        );
    }).map(player => player.id);
}

function generateSurveyQuestionnaires(participants, days = {}, random = Math.random, now = Date.now()) {
    const valid = rankedParticipants(participants);
    const pairs = neighborPairs(valid);
    const reserved = Object.fromEntries(valid.map(player => [player.id, []]));
    const covered = new Set();
    // Reserve at most one appearance per missed player; everything else stays random.
    for (const playerId of shuffled(previouslyUncompared(valid, days, now), random)) {
        if (covered.has(playerId)) continue;
        const choices = pairs.filter(pair => pair.a === playerId || pair.b === playerId).flatMap(pair =>
            valid.filter(respondent => respondent.id !== pair.a && respondent.id !== pair.b &&
                reserved[respondent.id].length < 4 && !reserved[respondent.id].some(item => pairKey(item.a, item.b) === pairKey(pair.a, pair.b)))
                .map(respondent => ({ respondentId: respondent.id, pair }))
        );
        if (!choices.length) continue; // Fewer than three participants cannot compare others.
        const { respondentId, pair } = choices[randomIndex(choices.length, random)];
        reserved[respondentId].push(pair);
        covered.add(pair.a);
        covered.add(pair.b);
    }
    return Object.fromEntries(valid.map(player => [player.id,
        generateQuestionnaire(player.id, valid, { reservedPairs: reserved[player.id] }, random)
    ]));
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

function normalizeSurveyAnswers(questionnaire, answers) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
    if (Array.isArray(answers.comparisons)) return validAnswer(questionnaire, answers) ? answers : null;

    const questionIds = questionnaire.comparisons.map(question => question.id);
    const expectedKeys = ['surprise', 'motm', ...questionIds].sort();
    if (Object.keys(answers).sort().join('\0') !== expectedKeys.join('\0')) return null;
    const normalized = {
        surprise: answers.surprise,
        motm: answers.motm,
        comparisons: questionnaire.comparisons.map(question => ({
            id: question.id, value: answers[question.id]
        }))
    };
    return validAnswer(questionnaire, normalized) ? normalized : null;
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

module.exports = { ATTRIBUTES, ATTRIBUTE_QUESTIONS, COMPARISON_OPTIONS, OUTCOMES, generateQuestionnaire, generateSurveyQuestionnaires, previouslyUncompared, validAnswer, normalizeSurveyAnswers, updateAttributeRatings, surveyDeadline, isSurveyClosed, countAwardVotes };
