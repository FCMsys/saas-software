'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const SECRET = 'survey-integration-test-secret';

function sessionCookie(sub, role) {
    const data = Buffer.from(JSON.stringify({ sub, role, exp: Date.now() + 60 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
    return `mm_session=${data}.${signature}`;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function csv(header, rows) {
    return '\uFEFF' + [header, ...rows].map(row => row.join(';')).join('\r\n') + '\r\n';
}

test('survey API creates stable private forms, accepts each response once, and publishes only after close', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcmsys-survey-api-'));
    const appDir = path.join(temp, 'app');
    const dataDir = path.join(temp, 'daten');
    fs.mkdirSync(path.join(appDir, 'src', 'logic'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'src', 'video'), { recursive: true });
    fs.mkdirSync(dataDir);
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(appDir, 'server.js'));
    fs.copyFileSync(path.join(ROOT, 'random.html'), path.join(appDir, 'random.html'));
    fs.copyFileSync(path.join(ROOT, 'src', 'logic', 'survey.js'), path.join(appDir, 'src', 'logic', 'survey.js'));
    fs.writeFileSync(path.join(appDir, 'src', 'video', 'landing.mp4'), Buffer.from('test-video-content'));
    const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
    fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(Object.fromEntries(
        playerIds.map(id => [`user-${id}`, { spielerId: id, email: '', role: 'player' }])
    )));

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
        ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NO_OPEN: '1',
        KINDE_DOMAIN: 'https://identity.example.test', KINDE_CLIENT_ID: 'test-client',
        SESSION_SECRET: SECRET, PUBLIC_URL: baseUrl, SMTP_USER: '', SMTP_PASS: '',
        SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_SECRET_KEY: ''
    };
    let child;
    let output = '';
    const startServer = async () => {
        child = spawn(process.execPath, ['server.js'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        for (let i = 0; i < 80; i++) {
            if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
            try {
                const response = await fetch(`${baseUrl}/healthz`);
                if (response.ok) return;
            } catch { }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Server did not start: ${output}`);
    };
    const stopServer = async () => {
        if (!child || child.exitCode !== null) return;
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
    };
    const call = async (url, { role = 'admin', playerId = 'admin', method = 'GET', body } = {}) => {
        const response = await fetch(baseUrl + url, {
            method,
            headers: { Cookie: sessionCookie(role === 'admin' ? 'admin' : `user-${playerId}`, role), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { response, data: await response.json() };
    };

    try {
        await startServer();
        const guestLanding = await fetch(`${baseUrl}/?umfrage=st_test`);
        const guestLandingHtml = await guestLanding.text();
        assert.equal(guestLanding.status, 200);
        assert.match(guestLandingHtml, /autoplay muted playsinline controls/);
        assert.match(guestLandingHtml, /\/login\?returnTo=%2F%3Fumfrage%3Dst_test%26intro%3Ddone/);
        const landingScripts = [...guestLandingHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        assert.equal(landingScripts.length, 1);
        new Function(landingScripts[0][1]);
        const loggedInLanding = await fetch(`${baseUrl}/`, { headers: { Cookie: sessionCookie('admin', 'admin') } });
        assert.match(await loggedInLanding.text(), /href="\/\?intro=done">Weiter zur App/);
        const landingMedia = await fetch(`${baseUrl}/video/landing.mp4`, { headers: { Range: 'bytes=0-3' } });
        assert.equal(landingMedia.status, 206);
        assert.equal(landingMedia.headers.get('content-range'), 'bytes 0-3/18');
        assert.equal(await landingMedia.text(), 'test');
        const appPage = await fetch(`${baseUrl}/?intro=done`, { headers: { Cookie: sessionCookie('admin', 'admin') } });
        assert.match(await appPage.text(), /id="surveyModal"/);

        const day = await call('/api/spieltage', { method: 'POST', body: { datum: '2026-10-20', uhrzeit: '19:00', dauerMinuten: '90' } });
        assert.equal(day.response.status, 200);
        const dayId = day.data.id;
        const savedDay = await call('/api/zahlungen');
        assert.equal(savedDay.data.spieltage.find(item => item.id === dayId).dauerMinuten, 90);
        const playerRows = playerIds.map((id, index) => [id, `Player ${index + 1}`, '1500', 'ZM', '50', '50', '50', '50', '50', '50', ''].join(';'));
        const gameRows = playerIds.map((id, index) => [
            '1', '2026-10-20T18:00:00.000Z', 'match', 'match-1', id, `Player ${index + 1}`,
            index < 3 ? 'A' : 'B', '1', '0', '1500', '1500', '0', dayId
        ]);
        const state = {
            spieler: csv(['id', 'name', 'elo', 'position', 'tem', 'sch', 'pas', 'drl', 'ver', 'phy', 'foto'], playerRows.map(row => row.split(';'))),
            spiele: csv(['seq', 'zeit', 'typ', 'match_id', 'spieler_id', 'spieler', 'team', 'tore_eigene', 'tore_gegner', 'elo_vorher', 'elo_nachher', 'delta', 'match_day_id'], gameRows),
            presets: csv(['name', 'spieler_ids'], [])
        };
        const saved = await call('/api/state', { method: 'PUT', body: state });
        assert.equal(saved.response.status, 200);

        const started = await call(`/api/spieltage/${dayId}/umfrage/abschliessen`, { method: 'POST' });
        assert.equal(started.response.status, 201);
        assert.equal(Date.parse(started.data.closesAt) - Date.parse(started.data.finishedAt), 48 * 60 * 60 * 1000);
        const repeated = await call(`/api/spieltage/${dayId}/umfrage/abschliessen`, { method: 'POST' });
        assert.equal(repeated.response.status, 409);
        await new Promise(resolve => setTimeout(resolve, 100));
        const startedStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8'));
        assert.ok(Object.values(startedStore.days[dayId].invites).every(invite => invite.attempts === 1 && invite.status === 'no_email'));

        const first = await call(`/api/umfragen/${dayId}`, { role: 'player', playerId: 'p1' });
        assert.equal(first.response.status, 200);
        assert.equal(first.data.form.comparisons.length, 4);
        assert.ok(first.data.form.comparisons.every(question => question.a.id !== 'p1' && question.b.id !== 'p1'));
        const firstFormAgain = await call(`/api/umfragen/${dayId}`, { role: 'player', playerId: 'p1' });
        assert.deepEqual(firstFormAgain.data.form, first.data.form);
        assert.doesNotMatch(JSON.stringify(first.data.form), /"elo"|"ges"|"stats"/);

        const adminLive = await call('/api/umfragen');
        const liveDay = adminLive.data.surveys.find(item => item.id === dayId);
        assert.equal(liveDay.status, 'open');
        assert.equal(liveDay.submittedCount, 0);
        assert.equal(liveDay.results, null);
        assert.equal(Object.hasOwn(liveDay, 'awardVotes'), false);

        const makeAnswers = (form, strong = false) => ({
            surprise: 'none', motm: 'unsure',
            comparisons: form.comparisons.map((question, index) => ({
                id: question.id,
                value: strong && question.kind === 'attribute' && index === form.comparisons.findIndex(item => item.kind === 'attribute') ? 'a_much' : 'equal'
            }))
        });
        const p1Answer = makeAnswers(first.data.form, true);
        const p2Form = (await call(`/api/umfragen/${dayId}`, { role: 'player', playerId: 'p2' })).data.form;
        const [p1Submit, p2Submit] = await Promise.all([
            call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p1', method: 'POST', body: { answers: p1Answer } }),
            call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p2', method: 'POST', body: { answers: makeAnswers(p2Form) } })
        ]);
        assert.equal(p1Submit.response.status, 200);
        assert.equal(p2Submit.response.status, 200);
        const updatedState = await call('/api/state');
        const updatedRows = updatedState.data.spieler.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(row => row.split(';'));
        assert.ok(updatedRows.slice(1).some(row => row.slice(4, 10).some(value => Number(value) !== 50)));
        assert.ok(updatedRows.slice(1).every(row => row[2] === '1500'));
        const duplicate = await call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p1', method: 'POST', body: { answers: p1Answer } });
        assert.equal(duplicate.response.status, 409);
        const forbiddenFinish = await call(`/api/spieltage/${dayId}/umfrage/abschliessen`, { role: 'player', playerId: 'p1', method: 'POST' });
        assert.equal(forbiddenFinish.response.status, 403);
        const playerLive = await call('/api/umfragen', { role: 'player', playerId: 'p1' });
        assert.equal(playerLive.data.surveys.find(item => item.id === dayId).results, null);

        const unlinkedDay = await call('/api/spieltage', { method: 'POST', body: { datum: '2026-10-21' } });
        const oldGames = gameRows.map(row => [...row.slice(0, -1), '']);
        const unlinkedState = { ...state, spiele: csv(['seq', 'zeit', 'typ', 'match_id', 'spieler_id', 'spieler', 'team', 'tore_eigene', 'tore_gegner', 'elo_vorher', 'elo_nachher', 'delta', 'match_day_id'], oldGames) };
        await call('/api/state', { method: 'PUT', body: unlinkedState });
        const unlinkedFinish = await call(`/api/spieltage/${unlinkedDay.data.id}/umfrage/abschliessen`, { method: 'POST' });
        assert.equal(unlinkedFinish.response.status, 409);
        assert.equal(unlinkedFinish.data.code, 'participants_required');
        const legacyCandidates = await call(`/api/spieltage/${unlinkedDay.data.id}/umfrage/teilnehmer`);
        assert.equal(legacyCandidates.data.legacyMatches.length, 1);
        assert.equal(legacyCandidates.data.legacyMatches[0].sameDay, false);
        assert.deepEqual(legacyCandidates.data.legacyMatches[0].players.map(item => item.id).sort(), playerIds);
        const invalidLegacySelection = await call(`/api/spieltage/${unlinkedDay.data.id}/umfrage/abschliessen`, {
            method: 'POST', body: { matchIds: ['not-a-match'] }
        });
        assert.equal(invalidLegacySelection.response.status, 400);
        const confirmedLegacySurvey = await call(`/api/spieltage/${unlinkedDay.data.id}/umfrage/abschliessen`, {
            method: 'POST', body: { matchIds: ['match-1'] }
        });
        assert.equal(confirmedLegacySurvey.response.status, 201);
        assert.equal(confirmedLegacySurvey.data.participantSource, 'admin_confirmed_legacy_matches');
        const legacySurvey = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8')).days[unlinkedDay.data.id];
        assert.deepEqual(legacySurvey.participants.sort(), playerIds);
        const linkedStateAfterConfirmation = await call('/api/state');
        const linkedMatches = linkedStateAfterConfirmation.data.spiele.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
        assert.ok(linkedMatches.every(row => row.endsWith(`;${unlinkedDay.data.id}`)));
        await new Promise(resolve => setTimeout(resolve, 100));

        const unrelatedDay = await call('/api/spieltage', { method: 'POST', body: { datum: '2026-10-22' } });
        const unrelatedCandidates = await call(`/api/spieltage/${unrelatedDay.data.id}/umfrage/teilnehmer`);
        assert.deepEqual(unrelatedCandidates.data.legacyMatches, []);
        const unrelatedFinish = await call(`/api/spieltage/${unrelatedDay.data.id}/umfrage/abschliessen`, { method: 'POST' });
        assert.equal(unrelatedFinish.response.status, 409);
        assert.equal(unrelatedFinish.data.code, undefined);
        assert.match(unrelatedFinish.data.error, /nicht auf dem Server gespeichert|bereits einem anderen Spieltag zugeordnet/);

        const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8'));
        stored.days[dayId].closesAt = new Date(Date.now() - 1).toISOString();
        stored.days[dayId].invites.p5.status = 'sending';
        fs.writeFileSync(path.join(dataDir, 'umfragen.json'), JSON.stringify(stored));
        const closed = await call('/api/umfragen');
        const closedDay = closed.data.surveys.find(item => item.id === dayId);
        assert.equal(closedDay.status, 'closed');
        assert.ok(closedDay.results);
        const late = await call(`/api/umfragen/${dayId}/antwort`, {
            role: 'player', playerId: 'p3', method: 'POST',
            body: { answers: makeAnswers((await call(`/api/umfragen/${dayId}`, { role: 'player', playerId: 'p3' })).data.form || { comparisons: [] }) }
        });
        assert.ok([403, 410].includes(late.response.status));

        await stopServer();
        await startServer();
        const afterRestart = await call('/api/umfragen');
        const afterRestartDay = afterRestart.data.surveys.find(item => item.id === dayId);
        assert.equal(afterRestartDay.status, 'closed');
        assert.equal(afterRestartDay.inviteDetails.find(item => item.playerId === 'p5').status, 'uncertain');
    } finally {
        await stopServer();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
