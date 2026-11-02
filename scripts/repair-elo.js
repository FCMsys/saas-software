'use strict';

// Offline repair: this module does not connect to production or write files.
// Recorded match deltas are retained; manual edits set absolute Elo anchors.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const logic = require('../src/logic/survey');

function buildRepair(snapshot) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const extract = (start, end) => {
        const from = source.indexOf(start), to = source.indexOf(end, from);
        if (from < 0 || to < 0) throw new Error('Repair helper not found: ' + start);
        return source.slice(from, to);
    };
    const c = vm.createContext({ ...logic });
    vm.runInContext(
        extract('function csvRows(', 'function playerNames(') +
        extract('function playersCsvWithSurveyRatings(', '\nfunction surveyComparisons'), c
    );
    const parse = text => {
        const [header, ...data] = c.csvRows(text);
        if (!header) throw new Error('Empty CSV');
        return { header, rows: data.filter(row => row.some(Boolean)).map(row => Object.fromEntries(header.map((key, i) => [key, row[i] ?? '']))) };
    };
    const encode = ({ header, rows }) => {
        const quote = value => /[;"\r\n]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
        return '\uFEFF' + [header, ...rows.map(row => header.map(key => row[key] ?? ''))].map(row => row.map(quote).join(';')).join('\r\n') + '\r\n';
    };
    const number = value => {
        if (value === '' || value == null || !Number.isFinite(Number(value))) throw new Error('Invalid numeric value: ' + value);
        return Number(value);
    };
    const time = value => {
        const result = Date.parse(value);
        if (!Number.isFinite(result)) throw new Error('Invalid timestamp: ' + value);
        return result;
    };
    const saved = JSON.parse(snapshot['umfragen.json']);
    if (Object.values(saved.days).some(day => !day.results || !day.eloHistory)) throw new Error('All surveys must be closed and published before repair');
    const players = parse(c.playersCsvWithSurveyRatings(snapshot['spieler.csv'], saved.ratings.current, saved.ratings.priors));
    const games = parse(snapshot['spiele.csv']);
    const days = Object.values(saved.days);
    const dayDeltas = new Map();
    for (const day of days) {
        const recorded = day.eloDeltas || Object.fromEntries(day.eloHistory.changes.map(change => [change.playerId, change.delta]));
        dayDeltas.set(day.id, recorded);
        for (const change of day.eloHistory.changes) {
            if (Math.abs(number(change.delta) - (recorded[change.playerId] || 0)) > 1e-6) throw new Error('Survey delta mismatch: ' + day.id + '/' + change.playerId);
        }
        // Applying the aggregate at publication is equivalent only when there
        // are no games/manual anchors between the answers and publication.
        if (games.rows.some(row => row.typ !== 'start' && Math.abs(recorded[row.spieler_id] || 0) > 1e-9 && time(row.zeit) >= time(day.finishedAt) && time(row.zeit) <= time(day.closesAt))) {
            throw new Error('History events during survey require individual review: ' + day.id);
        }
    }
    const balances = new Map(), atClose = new Map();
    const events = [
        ...games.rows.map((row, index) => ({ t: time(row.zeit), order: row.typ === 'start' ? 0 : 1, index, row })),
        ...days.map((day, index) => ({ t: time(day.closesAt), order: 3, index, day }))
    ].sort((a, b) => a.t - b.t || a.order - b.order || a.index - b.index);
    for (const event of events) {
        if (event.row) {
            const row = event.row, id = row.spieler_id;
            if (!['start', 'match', 'manuell'].includes(row.typ)) throw new Error('Unknown history event: ' + row.typ);
            const before = balances.has(id) ? balances.get(id) : number(row.elo_vorher);
            const after = row.typ === 'match' ? before + number(row.delta) : number(row.elo_nachher);
            row.elo_vorher = String(before);
            row.elo_nachher = String(after);
            if (row.typ !== 'match') row.delta = String(after - before);
            balances.set(id, after);
        } else {
            for (const [id, delta] of Object.entries(dayDeltas.get(event.day.id))) {
                number(delta);
                if (Math.abs(delta) < 1e-9) continue;
                if (!balances.has(id)) throw new Error('Missing Elo anchor before survey: ' + id);
                balances.set(id, balances.get(id) + delta);
            }
            atClose.set(event.day.id, new Map(balances));
        }
    }
    for (const day of days) {
        const deltas = dayDeltas.get(day.id);
        const ids = new Set([...day.eloHistory.changes.map(change => change.playerId), ...Object.keys(deltas).filter(id => Math.abs(deltas[id]) > 1e-9)]);
        day.eloDeltas = { ...deltas };
        day.eloHistory.changes = [...ids].map(playerId => {
            const after = atClose.get(day.id).get(playerId);
            if (!Number.isFinite(after)) throw new Error('Missing historical Elo: ' + playerId);
            const delta = deltas[playerId] || 0;
            return { playerId, before: after - delta, after, delta };
        });
    }
    const report = players.rows.map(row => {
        const before = number(row.elo), after = balances.get(row.id);
        if (!Number.isFinite(after)) throw new Error('Missing player history: ' + row.id);
        row.elo = String(after);
        return { id: row.id, name: row.name, before, after, correction: after - before };
    });
    return { files: {
        'spieler.csv': encode(players),
        'spiele.csv': encode(games),
        'umfragen.json': JSON.stringify(saved, null, 2)
    }, report };
}

module.exports = { buildRepair };

if (require.main === module) {
    const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const result = buildRepair(snapshot);
    if (JSON.stringify(buildRepair(result.files).files) !== JSON.stringify(result.files)) throw new Error('Repair is not idempotent');
    if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.report, null, 2));
}
