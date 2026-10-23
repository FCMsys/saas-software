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
    fs.mkdirSync(path.join(appDir, 'src', 'img'), { recursive: true });
    fs.mkdirSync(dataDir);
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(appDir, 'server.js'));
    fs.copyFileSync(path.join(ROOT, 'random.html'), path.join(appDir, 'random.html'));
    fs.copyFileSync(path.join(ROOT, 'src', 'logic', 'survey.js'), path.join(appDir, 'src', 'logic', 'survey.js'));
    fs.writeFileSync(path.join(appDir, 'src', 'img', 'landing.gif'), Buffer.from('GIF89a-test-image'));
    fs.writeFileSync(path.join(appDir, 'src', 'img', 'landing.mp4'), Buffer.from('test-landing-video'));
    const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5'];
    fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({
        ...Object.fromEntries(playerIds.map(id => [`user-${id}`, { spielerId: id, email: '', role: 'player' }])),
        admin: { spielerId: 'p1', email: '', role: 'admin' }
    }));

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
        const photoHeaders = { Cookie: sessionCookie('admin', 'admin') };
        // Exercise the authenticated photo endpoint directly; uploads change the validator.
        const putPhoto = data => fetch(`${baseUrl}/api/foto/p1`, {
            method: 'PUT', headers: { ...photoHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'data:image/png;base64,' + Buffer.from(data).toString('base64') })
        });
        assert.equal((await putPhoto('first-photo')).status, 200);
        const photo = await fetch(`${baseUrl}/fotos/p1.png`, { headers: photoHeaders });
        assert.equal(photo.status, 200);
        assert.equal(photo.headers.get('cache-control'), 'private, max-age=300');
        assert.equal(await photo.text(), 'first-photo');
        const etag = photo.headers.get('etag');
        assert.ok(etag);
        const unchanged = await fetch(`${baseUrl}/fotos/p1.png`, { headers: { ...photoHeaders, 'If-None-Match': etag } });
        assert.equal(unchanged.status, 304);
        assert.equal(await unchanged.text(), '');
        assert.equal((await putPhoto('updated-photo')).status, 200);
        const updated = await fetch(`${baseUrl}/fotos/p1.png?v=updated`, { headers: { ...photoHeaders, 'If-None-Match': etag } });
        assert.equal(updated.status, 200);
        assert.notEqual(updated.headers.get('etag'), etag);
        assert.equal(await updated.text(), 'updated-photo');
        const guestLanding = await fetch(`${baseUrl}/?umfrage=st_test`);
        const guestLandingHtml = await guestLanding.text();
        assert.equal(guestLanding.status, 200);
        assert.match(guestLandingHtml, /Willkommen beim FC M:sys/);
        assert.match(guestLandingHtml, /background:#fff/);
        assert.match(guestLandingHtml, /<video id="landingVideo" src="\/img\/landing\.mp4" autoplay muted playsinline preload="auto"><\/video>/);
        assert.doesNotMatch(guestLandingHtml, /\bloop\b|setTimeout|box-shadow|video-wrap/);
        assert.match(guestLandingHtml, /\/login\?returnTo=%2F%3Fumfrage%3Dst_test%26intro%3Ddone/);
        const landingScripts = [...guestLandingHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        assert.equal(landingScripts.length, 1);
        for (const trigger of ['timeupdate', 'ended']) {
            const handlers = new Map();
            const redirects = [];
            const video = { currentTime: 0, addEventListener: (event, callback) => handlers.set(event, callback) };
            new Function('document', 'location', landingScripts[0][1])({
                getElementById: id => id === 'landingVideo' ? video : { href: '/login?returnTo=test' }
            }, { replace: url => redirects.push(url) });
            assert.deepEqual([...handlers.keys()].sort(), ['ended', 'timeupdate']);
            assert.deepEqual(redirects, []);
            video.currentTime = 3.99;
            handlers.get('timeupdate')();
            assert.deepEqual(redirects, []);
            video.currentTime = 4;
            handlers.get(trigger)();
            assert.deepEqual(redirects, ['/login?returnTo=test']);
            handlers.get('timeupdate')();
            handlers.get('ended')();
            assert.equal(redirects.length, 1, 'video events must redirect only once');
        }
        const landingVideo = await fetch(`${baseUrl}/img/landing.mp4`);
        assert.equal(landingVideo.status, 200);
        assert.equal(landingVideo.headers.get('content-type'), 'video/mp4');
        assert.equal(await landingVideo.text(), 'test-landing-video');
        const loggedInLanding = await fetch(`${baseUrl}/`, { headers: { Cookie: sessionCookie('admin', 'admin') } });
        const loggedInHtml = await loggedInLanding.text();
        assert.match(loggedInHtml, /<dialog id="appIntro"/);
        assert.match(loggedInHtml, /<button type="button">Weiter zur App<\/button>/);
        assert.match(loggedInHtml, /id="surveyModal"/);
        const landingImage = await fetch(`${baseUrl}/img/landing.gif`);
        assert.equal(landingImage.status, 200);
        assert.equal(landingImage.headers.get('content-type'), 'image/gif');
        assert.equal(await landingImage.text(), 'GIF89a-test-image');
        const removedLandingVideo = await fetch(`${baseUrl}/video/landing.mp4`);
        assert.notEqual(removedLandingVideo.headers.get('content-type'), 'video/mp4');
        const appPage = await fetch(`${baseUrl}/?intro=done`, { headers: { Cookie: sessionCookie('admin', 'admin') } });
        const appHtml = await appPage.text();
        assert.match(appHtml, /id="surveyModal"/);
        assert.doesNotMatch(appHtml, /<dialog id="appIntro"/);

        const day = await call('/api/spieltage', { method: 'POST', body: { datum: '2026-10-20', uhrzeit: '19:00' } });
        assert.equal(day.response.status, 200);
        const dayId = day.data.id;
        const savedDay = await call('/api/zahlungen');
        assert.equal(savedDay.data.spieltage.find(item => item.id === dayId).uhrzeit, '19:00');
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
        const adminParticipantForm = await call(`/api/umfragen/${dayId}`, { role: 'admin' });
        assert.equal(adminParticipantForm.response.status, 200);
        assert.deepEqual(adminParticipantForm.data.form, first.data.form);
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
        const makeUiAnswers = (form, strong = false) => Object.fromEntries([
            ['surprise', 'none'], ['motm', 'unsure'],
            ...form.comparisons.map((question, index) => [
                question.id,
                strong && question.kind === 'attribute' && index === form.comparisons.findIndex(item => item.kind === 'attribute') ? 'a_much' : 'equal'
            ])
        ]);
        const p1UiAnswer = makeUiAnswers(first.data.form, true);
        const p2Form = (await call(`/api/umfragen/${dayId}`, { role: 'player', playerId: 'p2' })).data.form;
        const [p1Submit, p2Submit] = await Promise.all([
            call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p1', method: 'POST', body: { answers: p1UiAnswer } }),
            call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p2', method: 'POST', body: { answers: makeAnswers(p2Form) } })
        ]);
        assert.equal(p1Submit.response.status, 200);
        assert.equal(p2Submit.response.status, 200);
        const progress = (await call('/api/umfragen')).data.surveys.find(item => item.id === dayId);
        assert.equal(progress.inviteDetails.find(item => item.playerId === 'p1').answered, true);
        assert.equal(progress.inviteDetails.find(item => item.playerId === 'p2').answered, true);
        assert.equal(progress.inviteDetails.find(item => item.playerId === 'p3').answered, false);
        const updatedState = await call('/api/state');
        assert.deepEqual(updatedState.data.surveyHistory, []);
        const updatedRows = updatedState.data.spieler.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(row => row.split(';'));
        assert.ok(updatedRows.slice(1).some(row => row.slice(4, 10).some(value => Number(value) !== 50)));
        for (const row of updatedRows.slice(1)) {
            const mean = row.slice(4, 10).reduce((sum, value) => sum + Number(value), 0) / 6;
            assert.ok(Math.abs(Number(row[2]) - (29 * mean - 337)) < 1e-9);
        }
        const repeatedState = await call('/api/state');
        assert.equal(repeatedState.data.spieler, updatedState.data.spieler);
        await call('/api/state', { method: 'PUT', body: updatedState.data });
        assert.equal((await call('/api/state')).data.spieler, updatedState.data.spieler);
        const duplicate = await call(`/api/umfragen/${dayId}/antwort`, { role: 'player', playerId: 'p1', method: 'POST', body: { answers: p1UiAnswer } });
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
        const closedState = (await call('/api/state')).data;
        assert.equal(closedState.surveyHistory.length, 1);
        const surveyPoint = closedState.surveyHistory[0];
        assert.equal(surveyPoint.dayId, dayId);
        assert.equal(surveyPoint.dayNumber, 1);
        assert.equal(surveyPoint.changes.length, playerIds.length);
        assert.ok(surveyPoint.changes.some(change => Math.abs(change.delta) > 0));
        for (const change of surveyPoint.changes) {
            assert.ok(Math.abs(change.after - change.before - change.delta) < 1e-9);
        }
        assert.deepEqual((await call('/api/state')).data.surveyHistory, closedState.surveyHistory);
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
        assert.deepEqual((await call('/api/state')).data.surveyHistory, closedState.surveyHistory);
        assert.equal(afterRestartDay.inviteDetails.find(item => item.playerId === 'p5').status, 'uncertain');
        // Older surveys recover their Elo deltas once from the stored submissions.
        const legacyData = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8'));
        delete legacyData.days[dayId].eloHistory;
        delete legacyData.days[dayId].eloDeltas;
        fs.writeFileSync(path.join(dataDir, 'umfragen.json'), JSON.stringify(legacyData));
        const recovered = (await call('/api/state')).data.surveyHistory;
        assert.equal(recovered.length, 1);
        for (const change of recovered[0].changes) {
            const original = surveyPoint.changes.find(item => item.playerId === change.playerId);
            assert.ok(Math.abs(change.delta - original.delta) < 1e-9);
        }
        assert.deepEqual((await call('/api/state')).data.surveyHistory, recovered);

        // Full participation closes immediately, without waiting for the deadline.
        const earlyId = unlinkedDay.data.id;
        for (const playerId of playerIds) {
            const detail = await call(`/api/umfragen/${earlyId}`, { role: 'player', playerId });
            const answers = makeAnswers(detail.data.form);
            const nominee = playerIds.find(id => id !== playerId);
            answers.motm = nominee;
            answers.surprise = nominee;
            const submit = await call(`/api/umfragen/${earlyId}/antwort`, { role: 'player', playerId, method: 'POST', body: { answers } });
            assert.equal(submit.response.status, 200);
            const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8')).days[earlyId];
            if (playerId !== playerIds.at(-1)) {
                assert.equal(persisted.results, null);
                assert.equal(persisted.eloHistory, undefined);
            } else {
                assert.equal(persisted.closedReason, 'all_answered');
                assert.ok(Date.parse(persisted.closesAt) < Date.parse(persisted.scheduledClosesAt));
                assert.ok(persisted.results.motm.winners.length);
                assert.ok(persisted.results.surprise.winners.length);
                assert.equal(persisted.eloHistory.t, persisted.closesAt);
            }
        }
        const earlyView = (await call('/api/umfragen')).data.surveys.find(day => day.id === earlyId);
        assert.equal(earlyView.status, 'closed');
        assert.ok(earlyView.results.motm.winners.length);
        assert.ok(earlyView.results.motm.ranking.length);
        for (const endpoint of ['/api/umfragen', `/api/umfragen/${earlyId}`]) {
            const userResponse = await call(endpoint, { role: 'player', playerId: 'p1' });
            assert.equal(userResponse.response.status, 200);
            const userResults = endpoint === '/api/umfragen' ? userResponse.data.surveys.find(day => day.id === earlyId).results : userResponse.data.results;
            for (const key of ['motm', 'surprise']) {
                assert.deepEqual(userResults[key].winners, earlyView.results[key].winners);
                assert.equal(Object.hasOwn(userResults[key], 'ranking'), false);
            }
        }
        const earlyHistory = (await call('/api/state')).data.surveyHistory;
        assert.equal(earlyHistory.filter(point => point.dayId === earlyId).length, 1);
        assert.deepEqual((await call('/api/state')).data.surveyHistory, earlyHistory);

        // Already completed surveys from the old version close on startup too.
        const completedStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'umfragen.json'), 'utf8'));
        const completedDay = completedStore.days[earlyId];
        completedDay.closesAt = completedDay.scheduledClosesAt;
        completedDay.results = null;
        delete completedDay.eloHistory;
        delete completedDay.closedReason;
        await stopServer();
        fs.writeFileSync(path.join(dataDir, 'umfragen.json'), JSON.stringify(completedStore));
        await startServer();
        const backfilled = (await call('/api/umfragen')).data.surveys.find(day => day.id === earlyId);
        assert.equal(backfilled.status, 'closed');
        assert.deepEqual(backfilled.results, earlyView.results);
        assert.equal((await call('/api/state')).data.surveyHistory.filter(point => point.dayId === earlyId).length, 1);
    } finally {
        await stopServer();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
