// FC-M:Sys-Server (keine Abhängigkeiten, Node >= 18):
//  - liefert die Seite aus; Daten in Supabase (oder lokal im Ordner "daten", wenn SUPABASE_* fehlt)
//  - Login über Kinde (OpenID Connect, Authorization Code + PKCE), Rollen "admin" / "player"
//  - Spieltage mit Zahlungsstatus, Bezahlung über einen PayPal.Me-Link (Admin hakt ab)
//
// Konfiguration über Umgebungsvariablen (siehe .env.example). Ohne KINDE_* läuft
// der Server im lokalen Entwicklungsmodus: nur localhost, jeder ist Admin.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { exec } = require('child_process');
const { ATTRIBUTES, OUTCOMES, generateQuestionnaire, validAnswer, updateAttributeRatings, surveyDeadline, isSurveyClosed, countAwardVotes } = require('./src/logic/survey');

// --- .env laden (optional, ohne Abhängigkeit) ---
try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
} catch { /* keine .env */ }

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'daten');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const IMAGES = { 'msys.svg': 'Msys-Wappen.svg', 'lm.svg': 'L&M-Logo.svg', 'ramazzotti.svg': 'Ramazzotti-Logo.svg', 'ad-plane-banner.png': 'ad-plane-banner.png' };
const FILES = { spieler: 'spieler.csv', spiele: 'spiele.csv', presets: 'presets.csv' };

const KINDE_DOMAIN = (process.env.KINDE_DOMAIN || '').replace(/\/+$/, '');
const KINDE_CLIENT_ID = process.env.KINDE_CLIENT_ID || '';
const KINDE_CLIENT_SECRET = process.env.KINDE_CLIENT_SECRET || '';
const KINDE_ORG_CODE = process.env.KINDE_ORG_CODE || '';
const KINDE_AUDIENCE = process.env.KINDE_AUDIENCE || '';

// Mailversand direkt über SMTP (IONOS: smtp.ionos.de, Port 465 mit TLS, Benutzer = volle Postfach-Adresse).
// Ohne SMTP_USER/SMTP_PASS werden keine Mails verschickt.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.ionos.de';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 465;   // 465 = TLS, sonst STARTTLS (z. B. 587)
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
// Absender: bei IONOS muss die Adresse zum Postfach gehören (oder ein Alias davon sein)
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const MAIL_ENABLED = !!(SMTP_USER && SMTP_PASS);
// Fallback, falls Kinde keine Rollen ins Token schreibt: kommagetrennte Admin-E-Mail-Adressen
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const AUTH_ENABLED =!!(KINDE_DOMAIN && KINDE_CLIENT_ID);
const PUBLIC_URL_SET = process.env.PUBLIC_URL || '';
const PUBLIC_URL = (PUBLIC_URL_SET || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
const HOST = process.env.HOST || (AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1');

if (PUBLIC_URL_SET && !AUTH_ENABLED) {
    console.error('PUBLIC_URL ist gesetzt, aber KINDE_DOMAIN / KINDE_CLIENT_ID fehlen. Ohne Login darf der Server nicht öffentlich laufen.');
    process.exit(1);
}
let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (AUTH_ENABLED && SESSION_SECRET.length < 16) {
    console.error('SESSION_SECRET fehlt oder ist zu kurz (mind. 16 Zeichen, z. B. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`).');
    process.exit(1);
}
if (!SESSION_SECRET) SESSION_SECRET = crypto.randomBytes(32).toString('hex');

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
try { ALLOWED_HOSTS.add(new URL(PUBLIC_URL).hostname); } catch { }
// Weitere erlaubte Hosts (z. B. die Domain ohne www) über ALLOWED_HOSTS, kommagetrennt
(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '')).filter(Boolean).forEach(h => ALLOWED_HOSTS.add(h));

const FOTO_DIR = path.join(DATA_DIR, 'fotos');

// ---------------------------------------------------------------------------
// Speicher: Supabase (Produktion) oder lokaler Ordner "daten" (Entwicklung)
//  - Supabase: Tabelle "kv" (key, value) für CSV/JSON, Storage-Bucket "fotos" für Bilder.
//    Beim Start wird alles in den Speicher geladen; Schreibzugriffe laufen sofort in den
//    Cache und werden der Reihe nach nach Supabase geschrieben (genau eine Server-Instanz).
//  - Ohne SUPABASE_URL/SUPABASE_SERVICE_KEY: Dateien im Ordner "daten".
// ---------------------------------------------------------------------------
const SUPABASE_URL = (() => { try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ''; } })();   // nur Host, ein evtl. angehängtes /rest/v1 entfällt
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);
const FOTO_BUCKET = 'fotos';
const cache = new Map();
let saveChain = Promise.resolve();
let surveyMutation = Promise.resolve();
let surveyCloseTimer = null;

function sb(pathAndQuery, opts = {}) {
    // Neue "sb_secret_…"-Keys gehören nur in apikey, alte JWT-Keys zusätzlich in Authorization
    const headers = { apikey: SUPABASE_KEY, ...(SUPABASE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}), ...opts.headers };
    return fetch(SUPABASE_URL + pathAndQuery, { ...opts, headers });
}

async function sbError(what, r) {
    return new Error(`${what} (Supabase ${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

async function loadStore() {
    if (!USE_SUPABASE) { fs.mkdirSync(FOTO_DIR, { recursive: true }); return; }
    const r = await sb('/rest/v1/kv?select=key,value');
    if (!r.ok) throw await sbError('Laden der Daten fehlgeschlagen', r);
    for (const row of await r.json()) cache.set(row.key, row.value);
}

function readFile(name) {
    if (USE_SUPABASE) return cache.get(name) || '';
    try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8'); } catch { return ''; }
}

async function writeFileAtomic(name, content) {
    if (!USE_SUPABASE) {
        const target = path.join(DATA_DIR, name);
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, target);
        return;
    }
    cache.set(name, content);
    const job = saveChain.then(async () => {
        const r = await sb('/rest/v1/kv?on_conflict=key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify([{ key: name, value: content, updated_at: new Date().toISOString() }])
        });
        if (!r.ok) throw await sbError('Speichern fehlgeschlagen', r);
    });
    saveChain = job.catch(() => { });
    return job;
}

function readJson(name, fallback) {
    try { return JSON.parse(readFile(name)) || fallback; } catch { return fallback; }
}
const writeJson = (name, obj) => writeFileAtomic(name, JSON.stringify(obj, null, 2));
const loadSurveys = () => readJson('umfragen.json', { days: {}, ratings: { priors: {}, current: {} } });
const mutateSurveys = action => {
    const job = surveyMutation.then(action);
    surveyMutation = job.catch(() => { });
    return job;
};

// --- Spielerfotos ---
const FOTO_TYPES = { png: 'image/png', jpg: 'image/jpeg' };

async function fotoDelete(id) {
    for (const ext of Object.keys(FOTO_TYPES)) {
        if (!USE_SUPABASE) { try { fs.unlinkSync(path.join(FOTO_DIR, `${id}.${ext}`)); } catch { } continue; }
        await sb(`/storage/v1/object/${FOTO_BUCKET}/${id}.${ext}`, { method: 'DELETE' }).catch(() => { });
    }
}

async function fotoPut(id, ext, buf) {
    await fotoDelete(id);
    if (!USE_SUPABASE) { fs.writeFileSync(path.join(FOTO_DIR, `${id}.${ext}`), buf); return; }
    const r = await sb(`/storage/v1/object/${FOTO_BUCKET}/${id}.${ext}`, { method: 'POST', headers: { 'Content-Type': FOTO_TYPES[ext], 'x-upsert': 'true' }, body: buf });
    if (!r.ok) throw await sbError('Foto speichern fehlgeschlagen', r);
}

async function fotoGet(id, ext) {
    if (!USE_SUPABASE) { try { return fs.readFileSync(path.join(FOTO_DIR, `${id}.${ext}`)); } catch { return null; } }
    const r = await sb(`/storage/v1/object/${FOTO_BUCKET}/${id}.${ext}`);
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

// settings.json: { tiers: { silber, gold, ikone }, mode }  Elo, ab der ein Spieler in die jeweilige Karten-Stufe springt, und Verteilungsmodus
const DEFAULT_TIERS = { silber: 1548, gold: 1838, ikone: 2215 };   // = GES 65 / 75 / 88 (GES = (Elo + 337) / 29)
const STAT_MODES = ['zufall', 'deterministisch'];   // Verteilung der Wertepunkte bei Elo-Änderungen
const validTiers = t => !!t && ['silber', 'gold', 'ikone'].every(k => Number.isInteger(t[k]) && t[k] >= 100 && t[k] <= 3000) && t.silber < t.gold && t.gold < t.ikone;
const loadStatMode = () => { const m = readJson('settings.json', {}).mode; return STAT_MODES.includes(m) ? m : 'zufall'; };
const loadTiers = () => { const t = readJson('settings.json', {}).tiers; return validTiers(t) ? { silber: t.silber, gold: t.gold, ikone: t.ikone } : { ...DEFAULT_TIERS }; };
// users.json: { <kinde-sub>: { email, name, role, spielerId, lastLogin } }
const loadUsers = () => readJson('users.json', {});
// zahlungen.json: { paypal, spieltage: [{
//     id, datum, uhrzeit, ort, titel, einladungAt,
//     antworten: { [spielerId]: { status: 'zu'|'ab', at, by: 'mail'|'app'|'admin'|'spiel' } },   // Zu-/Absagen zum Spieltag
//     betragCent|null, teilnehmer: [spielerId], bezahlt: { [spielerId]: { via, at } }              // Abrechnung (null = noch nicht abgerechnet)
// }] }
const loadZahlungen = () => {
    const z = readJson('zahlungen.json', {});
    if (!Array.isArray(z.spieltage)) z.spieltage = [];
    if (!Array.isArray(z.kassenbuch)) z.kassenbuch = [];
    z.spieltage.forEach(normSpieltag);
    return z;
};

// ---------------------------------------------------------------------------
// HTTP-Helfer
// ---------------------------------------------------------------------------
function sendJson(res, code, obj, headers = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(obj));
}

function readBody(req, limit = 20e6) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('Anfrage zu groß')); req.destroy(); } });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

const readJsonBody = async (req, limit) => { const b = await readBody(req, limit); return b ? JSON.parse(b) : {}; };

// ---------------------------------------------------------------------------
// Sessions (zustandslos: signiertes Cookie)
// ---------------------------------------------------------------------------
const b64u = buf => Buffer.from(buf).toString('base64url');
const sign = data => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');

function makeToken(payload) {
    const data = b64u(JSON.stringify(payload));
    return `${data}.${sign(data)}`;
}

function readToken(token) {
    if (!token) return null;
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = sign(data);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        return payload.exp > Date.now() ? payload : null;
    } catch { return null; }
}

function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(c => {
        const i = c.indexOf('=');
        if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    });
    return out;
}

function cookie(name, value, maxAgeSec) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function getSession(req) {
    if (!AUTH_ENABLED) return { sub: 'local', email: '', name: 'Lokal', role: 'admin' };
    return readToken(parseCookies(req).mm_session);
}

// ---------------------------------------------------------------------------
// Kinde (OIDC)
// ---------------------------------------------------------------------------
function decodeJwt(jwt) {
    try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function roleFromClaims(...claims) {
    const keys = [];
    for (const c of claims) {
        if (Array.isArray(c.roles)) c.roles.forEach(r => keys.push(String(r && r.key || r).toLowerCase()));
    }
    return keys.includes('admin') ? 'admin' : 'player';
}

function startLogin(res, returnTo = '/') {
    const safeReturnTo = typeof returnTo === 'string' && returnTo.startsWith('/') &&
        !returnTo.startsWith('//') && !returnTo.includes('\\') && !/[\r\n]/.test(returnTo) ? returnTo : '/';
    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
        response_type: 'code', client_id: KINDE_CLIENT_ID, redirect_uri: `${PUBLIC_URL}/callback`,
        scope: 'openid profile email', state, code_challenge: challenge, code_challenge_method: 'S256'
    });
    // Rollen stehen im Token nur für die Organisation, mit der man sich anmeldet
    if (KINDE_ORG_CODE) params.set('org_code', KINDE_ORG_CODE);
    // Kinde nimmt Rollen nur ins Access Token auf, wenn eine API (audience) angefragt wird
    if (KINDE_AUDIENCE) params.set('audience', KINDE_AUDIENCE);
    res.writeHead(302, {
        Location: `${KINDE_DOMAIN}/oauth2/auth?${params}`,
        'Set-Cookie': cookie('mm_oauth', makeToken({ state, verifier, returnTo: safeReturnTo, exp: Date.now() + 10 * 60e3 }), 600),
        'Cache-Control': 'no-store'
    });
    res.end();
}

async function finishLogin(req, res, query) {
    const oauth = readToken(parseCookies(req).mm_oauth);
    if (!oauth || !query.get('code') || query.get('state') !== oauth.state) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Login fehlgeschlagen (ungültiger Status). Bitte erneut versuchen: ' + PUBLIC_URL + '/login');
    }
    const body = new URLSearchParams({
        grant_type: 'authorization_code', client_id: KINDE_CLIENT_ID, redirect_uri: `${PUBLIC_URL}/callback`,
        code: query.get('code'), code_verifier: oauth.verifier
    });
    if (KINDE_CLIENT_SECRET) body.set('client_secret', KINDE_CLIENT_SECRET);
    const r = await fetch(`${KINDE_DOMAIN}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const tok = await r.json();
    if (!r.ok || !tok.access_token) throw new Error('Token-Austausch fehlgeschlagen: ' + (tok.error_description || tok.error || r.status));

    // Die Tokens kommen direkt vom Token-Endpoint über TLS; die Signatur muss daher nicht erneut geprüft werden.
    const idc = decodeJwt(tok.id_token), acc = decodeJwt(tok.access_token);
    const sub = idc.sub || acc.sub;
    if (!sub) throw new Error('Kein Benutzer im Token');
    const name = [idc.given_name, idc.family_name].filter(Boolean).join(' ') || idc.name || idc.email || 'Unbekannt';
    const isAdminMail = !!idc.email && ADMIN_EMAILS.has(idc.email.toLowerCase());
    const role = isAdminMail ? 'admin' : roleFromClaims(acc, idc);
    console.log(`Login ${idc.email || sub}: org_code=${acc.org_code || idc.org_code || '-'} roles(access)=${JSON.stringify(acc.roles)} roles(id)=${JSON.stringify(idc.roles)} -> ${role}`);

    const users = loadUsers();
    users[sub] = { ...(users[sub] || {}), email: idc.email || '', name, role, lastLogin: new Date().toISOString() };
    await writeJson('users.json', users);

    res.writeHead(302, {
        Location: oauth.returnTo || '/',
        'Set-Cookie': [
            cookie('mm_session', makeToken({ sub, email: idc.email || '', name, role, exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS / 1000),
            cookie('mm_oauth', '', 0)
        ]
    });
    res.end();
}

// ---------------------------------------------------------------------------
// Mail (minimaler SMTP-Client ohne Abhängigkeiten)
// ---------------------------------------------------------------------------
const headerSafe = s => String(s).replace(/[\r\n]+/g, ' ').trim();
const encodeWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

// Absender-Header: Name immer in Anführungszeichen (ein Doppelpunkt wie in "FC M:sys" würde sonst den Header zerstören
// und z. B. IONOS lehnt die Mail dann als "Unauthorized sender address" ab); Nicht-ASCII-Namen werden kodiert
function fromHeader() {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(MAIL_FROM);
    if (!m) return headerSafe(MAIL_FROM);
    const name = headerSafe(m[1]);
    if (!name) return `<${m[2]}>`;
    return `${/^[\x20-\x7e]*$/.test(name) ? '"' + name.replace(/["\\]/g, '\\$&') + '"' : encodeWord(name)} <${m[2]}>`;
}

function buildMessage({ to, subject, text }) {
    const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    return [
        `From: ${fromHeader()}`, `To: ${headerSafe(to)}`, `Subject: ${encodeWord(headerSafe(subject))}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@fcmsys>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body
    ].join('\r\n');
}

function smtpSend(msg) {
    const fromAddr = (/<([^>]+)>/.exec(MAIL_FROM) || [, MAIL_FROM])[1];
    return new Promise((resolve, reject) => {
        let socket = null, buf = '', pending = null, finished = false;
        const finish = err => {
            if (finished) return;
            finished = true;
            try { socket && socket.destroy(); } catch { }
            err ? reject(err) : resolve();
        };
        // Eine Antwort ist vollständig, wenn die letzte Zeile "NNN " (ohne Bindestrich) beginnt
        const flush = () => {
            if (!pending || !buf.endsWith('\r\n')) return;
            const lines = buf.split('\r\n'); lines.pop();
            const last = lines[lines.length - 1];
            if (!/^\d{3} /.test(last)) return;
            const p = pending, text = buf;
            pending = null; buf = '';
            p({ code: parseInt(last, 10), text });
        };
        const attach = s => {
            socket = s;
            s.on('data', d => { buf += d.toString('utf8'); flush(); });
            s.on('error', finish);
            s.setTimeout(20000, () => finish(new Error('SMTP-Zeitüberschreitung')));
        };
        const cmd = async (line, ok) => {
            if (line !== null) socket.write(line + '\r\n');
            const r = await new Promise(res => { pending = res; flush(); });
            if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.text.trim().split('\r\n').pop().slice(4)}`);
        };
        (async () => {
            attach(SMTP_PORT === 465 ? tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST }) : net.connect({ host: SMTP_HOST, port: SMTP_PORT }));
            await cmd(null, [220]);
            await cmd('EHLO fcmsys', [250]);
            if (SMTP_PORT !== 465) {
                await cmd('STARTTLS', [220]);
                const plain = socket;
                plain.removeAllListeners('data');
                buf = '';
                attach(tls.connect({ socket: plain, servername: SMTP_HOST }));
                await cmd('EHLO fcmsys', [250]);
            }
            await cmd('AUTH LOGIN', [334]);
            await cmd(Buffer.from(SMTP_USER).toString('base64'), [334]);
            await cmd(Buffer.from(SMTP_PASS).toString('base64'), [235]);
            await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
            await cmd(`RCPT TO:<${msg.to}>`, [250, 251]);
            await cmd('DATA', [354]);
            await cmd(buildMessage(msg) + '\r\n.', [250]);   // Body ist base64, daher kein Dot-Stuffing nötig
            socket.write('QUIT\r\n');
            finish();
        })().catch(finish);
    });
}

const maskMail = a => String(a).replace(/^(.).*(@.*)$/, '$1***$2');
async function sendMail(msg) {
    await smtpSend(msg);
    console.log(`Mail an ${maskMail(msg.to)} per SMTP angenommen`);
}

const fmtDe = iso => iso.split('-').reverse().join('.');
const fmtEur = cent => (cent / 100).toFixed(2).replace('.', ',') + ' €';

// Schickt die Zahlungsanforderung an alle Teilnehmer, deren Login einem Spieler zugeordnet ist
async function mailZahlungsanforderung(spieltag, { reminder = false, openAmounts = {} } = {}) {
    const result = { sent: 0, failed: [], skipped: 0 };
    const paypal = loadZahlungen().paypal || '';
    const users = Object.values(loadUsers());
    const subject = `${reminder ? 'Erinnerung: ' : ''}Fußball ${fmtDe(spieltag.datum)}: Beitrag`;
    for (const id of spieltag.teilnehmer) {
        const betragCent = Number.isSafeInteger(openAmounts[id]) ? openAmounts[id] : spieltag.bezahlt[id] ? 0 : spieltag.betragCent;
        if (betragCent <= 0) continue;
        const email = (users.find(u => u.spielerId === id) || {}).email;
        if (!email || !EMAIL_RE.test(email)) { result.skipped++; continue; }
        const pay = !paypal ? '' : /^https:/i.test(paypal)
            ? `Bezahlen: ${paypal.replace(/\/+$/, '')}/${(betragCent / 100).toFixed(2)}EUR\n`
            : `Bitte per PayPal (Freunde & Familie) an: ${paypal}\n`;
        const text = `Hallo Sportsfreund,\n\nfür den Spieltag am ${fmtDe(spieltag.datum)}${spieltag.ort || spieltag.titel ? ' (' + (spieltag.ort || spieltag.titel) + ')' : ''} sind ${fmtEur(betragCent)} ${reminder ? 'noch offen' : 'fällig'}.\n` +
            pay + (PUBLIC_URL_SET ? `\nMehr Infos: ${PUBLIC_URL}\n` : '') + '\nDanke!\nFC:MSys';
        try { await sendMail({ to: email, subject, text }); result.sent++; }
        catch (e) { console.error(`Mail an ${email} fehlgeschlagen:`, e.message); result.failed.push(email + ': ' + e.message); }
    }
    return result;
}

function cashSummary(z) {
    const knownPlayers = playerNames();
    const playerIdForEntry = entry => {
        if (entry.spielerId && knownPlayers.has(entry.spielerId)) return entry.spielerId;
        const normalizeName = value => String(value || '').toLocaleLowerCase('de-DE').replace(/[^a-z0-9äöüß]/g, '');
        const name = normalizeName(entry.gegenkonto);
        if (!name) return null;
        return [...knownPlayers].find(([, playerName]) => normalizeName(playerName) === name)?.[0] || null;
    };
    const events = [];
    let incomeCent = 0, expensesCent = 0;
    (z.kassenbuch || []).forEach((entry, index) => {
        const amount = Number(entry.betragCent) || 0;
        if (entry.typ === 'einnahme') incomeCent += amount;
        if (entry.typ === 'ausgabe' || entry.typ === 'auszahlung') expensesCent += amount;
        events.push({
            datum: entry.datum || '', order: 0, index, type: 'credit',
            playerId: playerIdForEntry(entry), amount: entry.typ === 'auszahlung' ? -amount : amount
        });
    });
    (z.spieltage || []).filter(s => s.betragCent != null).forEach((s, dayIndex) => {
        s.teilnehmer.forEach((playerId, playerIndex) => {
            events.push({
                datum: s.datum, order: 1, index: dayIndex * 10000 + playerIndex, type: 'charge',
                spieltag: s, playerId, amount: s.betragCent, key: `${s.id}:${playerId}`
            });
        });
    });
    events.sort((a, b) => a.datum.localeCompare(b.datum) || a.order - b.order || a.index - b.index);

    const balances = new Map();
    const debts = new Map();
    const chargeStatus = {};
    const balanceOf = id => balances.get(id) || 0;
    const changeBalance = (id, amount) => balances.set(id, balanceOf(id) + amount);
    const reduceDebts = (id, amount) => {
        const list = debts.get(id) || [];
        let remaining = amount;
        for (const debt of list) {
            const paid = Math.min(remaining, debt.openCent);
            debt.openCent -= paid;
            debt.creditAppliedCent += paid;
            remaining -= paid;
            if (remaining <= 0) break;
        }
        debts.set(id, list.filter(debt => debt.openCent > 0));
    };

    for (const event of events) {
        if (!event.playerId) continue;
        if (event.type === 'credit') {
            if (event.amount > 0) reduceDebts(event.playerId, event.amount);
            changeBalance(event.playerId, event.amount);
            continue;
        }
        const before = balanceOf(event.playerId);
        const creditAppliedCent = Math.min(event.amount, Math.max(0, before));
        const dueCent = event.amount - creditAppliedCent;
        const payment = event.spieltag.bezahlt[event.playerId];
        const paidCent = !payment ? 0 : Number.isSafeInteger(payment.betragCent)
            ? Math.min(dueCent, payment.betragCent)
            : dueCent;
        const state = { creditAppliedCent, dueCent, paidCent, openCent: dueCent - paidCent };
        chargeStatus[event.key] = state;
        changeBalance(event.playerId, -event.amount + paidCent);
        if (state.openCent > 0) {
            const list = debts.get(event.playerId) || [];
            list.push(state);
            debts.set(event.playerId, list);
        }
        incomeCent += paidCent;
    }

    const playerBalances = Object.fromEntries([...knownPlayers.keys()].map(id => [id, balanceOf(id)]));
    const outstandingCent = Object.values(playerBalances).reduce((sum, balance) => sum + Math.max(0, -balance), 0);
    return { incomeCent, expensesCent, balanceCent: incomeCent - expensesCent, outstandingCent, playerBalances, chargeStatus };
}

// ---------------------------------------------------------------------------
// Spieltage: Einladung per Mail, Zu-/Absagen
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const berlinToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const fmtDay = s => new Date(s.datum + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) + (s.uhrzeit ? ' · ' + s.uhrzeit + ' Uhr' : '') + (s.dauerMinuten ? ' · ' + s.dauerMinuten + ' Min.' : '');
const escHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normSpieltag(s) {
    s.antworten = s.antworten || {}; s.uhrzeit = s.uhrzeit || ''; s.ort = s.ort || ''; s.titel = s.titel || '';
    s.dauerMinuten = Number.isInteger(s.dauerMinuten) ? s.dauerMinuten : null;
    if (s.betragCent === undefined) s.betragCent = null;
    s.teilnehmer = s.teilnehmer || []; s.bezahlt = s.bezahlt || {};
    return s;
}

// Spielernamen (id -> Name) aus spieler.csv, wird für Mails und Prüfungen gebraucht
function csvRows(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ';') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
}
function playerNames() {
    const rows = csvRows(readFile('spieler.csv'));
    const head = rows[0] || [], iId = head.indexOf('id'), iName = head.indexOf('name'), names = new Map();
    if (iId >= 0 && iName >= 0) rows.slice(1).forEach(r => { if (r[iId]) names.set(r[iId], r[iName] || ''); });
    return names;
}

function surveyData() {
    const saved = loadSurveys();
    if (!saved.days || typeof saved.days !== 'object') saved.days = {};
    if (!saved.ratings || typeof saved.ratings !== 'object') saved.ratings = {};
    if (!saved.ratings.priors || typeof saved.ratings.priors !== 'object') saved.ratings.priors = {};
    if (!saved.ratings.current || typeof saved.ratings.current !== 'object') saved.ratings.current = {};
    if (!Array.isArray(saved.ratings.history)) saved.ratings.history = [];
    return saved;
}

function surveyPlayers() {
    const rows = csvRows(readFile('spieler.csv'));
    const header = rows[0] || [];
    const index = Object.fromEntries(header.map((name, i) => [name, i]));
    return rows.slice(1).filter(row => row[index.id]).map(row => {
        const stats = Object.fromEntries(ATTRIBUTES.map(attribute => [
            attribute, Math.max(1, Math.min(99, parseInt(row[index[attribute.toLowerCase()]]) || 50))
        ]));
        const elo = parseInt(row[index.elo]) || 1500;
        return {
            id: row[index.id],
            name: row[index.name] || '',
            elo,
            ges: Math.max(1, Math.min(99, Math.floor((elo + 337) / 29 + 0.5))),
            photo: row[index.foto] ? '/' + row[index.foto].split('?')[0].replace(/^\/+/, '') : '',
            stats
        };
    });
}

function snapshotSurveyPriors(saved, players) {
    for (const player of players) {
        if (!saved.ratings.priors[player.id]) saved.ratings.priors[player.id] = player.stats;
    }
}

function playersCsvWithSurveyRatings(csv, ratings) {
    if (!ratings || !Object.keys(ratings).length) return csv;
    const rows = csvRows(csv);
    if (!rows.length) return csv;
    const header = [...rows[0]];
    const keys = ATTRIBUTES.map(attribute => attribute.toLowerCase());
    keys.forEach(key => { if (!header.includes(key)) header.push(key); });
    const idIndex = header.indexOf('id');
    const next = [header];
    for (const source of rows.slice(1)) {
        const row = [...source];
        while (row.length < header.length) row.push('');
        const id = row[idIndex];
        keys.forEach((key, index) => {
            const value = ratings[ATTRIBUTES[index]] && ratings[ATTRIBUTES[index]][id];
            if (Number.isInteger(value)) row[header.indexOf(key)] = String(Math.max(1, Math.min(99, value)));
        });
        next.push(row);
    }
    const quote = value => {
        const text = String(value == null ? '' : value);
        return /[;"\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return '\uFEFF' + next.map(row => row.map(quote).join(';')).join('\r\n') + '\r\n';
}

function surveyComparisons(saved) {
    return Object.values(saved.days).flatMap(day =>
        Object.values(day.submissions || {}).flatMap(submission =>
            (submission.answers.comparisons || [])
                .filter(answer => answer.value !== 'unsure')
                .map(answer => ({ ...answer, dayId: day.id, respondentId: submission.playerId }))
        )
    );
}

function aggregateSurveyComparisons(saved, kind) {
    const totals = {};
    for (const day of Object.values(saved.days)) {
        for (const submission of Object.values(day.submissions || {})) {
            const questions = day.forms[submission.playerId].comparisons || [];
            for (const answer of submission.answers.comparisons || []) {
                const question = questions.find(item => item.id === answer.id);
                if (!question || (kind === 'performance' ? question.kind !== 'performance' : question.kind !== 'attribute')) continue;
                if (answer.value === 'unsure') continue;
                const score = OUTCOMES[answer.value];
                for (const [playerId, value] of [[question.a, score], [question.b, 1 - score]]) {
                    const key = kind === 'attribute' ? `${playerId}:${question.attribute}` : playerId;
                    const item = totals[key] || { playerId, attribute: question.attribute || null, votes: 0, score: 0 };
                    item.votes++;
                    item.score += value;
                    totals[key] = item;
                }
            }
        }
    }
    return Object.values(totals).map(item => ({
        ...item,
        average: Math.round(item.score / item.votes * 100) / 100,
        player: surveyPlayers().find(player => player.id === item.playerId)?.name || '(gelöscht)'
    })).sort((a, b) => b.average - a.average || b.votes - a.votes || a.player.localeCompare(b.player));
}

function calculateSurveyAwards(day) {
    const players = surveyPlayers();
    const decorate = item => ({
        ...item,
        player: players.find(player => player.id === item.playerId)?.name || '(gelöscht)',
        photo: players.find(player => player.id === item.playerId)?.photo || ''
    });
    return Object.fromEntries(Object.entries(countAwardVotes(day.submissions)).map(([award, result]) => [
        award,
        { winners: result.winners.map(decorate), ranking: result.ranking.map(decorate) }
    ]));
}

async function closeDueSurveys(now = Date.now()) {
    return mutateSurveys(async () => {
        const saved = surveyData();
        let changed = false;
        for (const day of Object.values(saved.days)) {
            if (!day.results && isSurveyClosed(day.closesAt, now)) {
                day.results = calculateSurveyAwards(day);
                day.publishedAt = day.closesAt;
                changed = true;
            }
        }
        if (changed) await writeJson('umfragen.json', saved);
        return saved;
    });
}

function scheduleNextSurveyClose(retryDelay = 0) {
    clearTimeout(surveyCloseTimer);
    const nextDeadline = Object.values(surveyData().days)
        .filter(day => !day.results)
        .map(day => Date.parse(day.closesAt))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
    if (nextDeadline === undefined) return;
    surveyCloseTimer = setTimeout(async () => {
        let retry = 0;
        try { await closeDueSurveys(); }
        catch (error) {
            console.error('Umfragefrist konnte nicht geschlossen werden:', error.message);
            retry = 30000;
        }
        scheduleNextSurveyClose(retry);
    }, Math.max(1, retryDelay, nextDeadline - Date.now()));
    surveyCloseTimer.unref();
}

async function recalculateSurveyRatings(saved, dayId) {
    const players = surveyPlayers();
    snapshotSurveyPriors(saved, players);
    const previous = saved.ratings.current;
    const current = updateAttributeRatings(saved.ratings.priors, surveyComparisons(saved));
    const at = new Date().toISOString();
    for (const attribute of ATTRIBUTES) {
        for (const [playerId, after] of Object.entries(current[attribute] || {})) {
            const before = previous[attribute] && previous[attribute][playerId];
            if (Number.isInteger(before) && before !== after) {
                saved.ratings.history.push({ at, dayId, playerId, attribute, before, after });
            }
        }
    }
    saved.ratings.current = current;
}

async function sendSurveyInvitation(dayId, playerId, retry = false) {
    const start = await mutateSurveys(async () => {
        const saved = surveyData();
        const day = saved.days[dayId];
        const invite = day && day.invites[playerId];
        if (!invite || invite.status === 'sent' || invite.status === 'sending' || (!retry && invite.status !== 'pending') || (retry && invite.status !== 'failed')) return null;
        invite.status = 'sending';
        invite.attempts = (invite.attempts || 0) + 1;
        invite.updatedAt = new Date().toISOString();
        await writeJson('umfragen.json', saved);
        return { day, invite };
    });
    if (!start) return;
    const user = Object.values(loadUsers()).find(item => item.spielerId === playerId && EMAIL_RE.test(item.email || ''));
    if (!user) {
        await mutateSurveys(async () => {
            const saved = surveyData();
            const invite = saved.days[dayId].invites[playerId];
            invite.status = 'no_email';
            invite.error = 'Keine gültige E-Mail-Adresse hinterlegt';
            await writeJson('umfragen.json', saved);
        });
        return;
    }
    if (!MAIL_ENABLED) {
        await mutateSurveys(async () => {
            const saved = surveyData();
            const invite = saved.days[dayId].invites[playerId];
            invite.status = 'failed';
            invite.error = 'Mail-Versand ist nicht eingerichtet (SMTP_USER und SMTP_PASS fehlen)';
            invite.updatedAt = new Date().toISOString();
            await writeJson('umfragen.json', saved);
        });
        return;
    }
    try {
        const returnTo = `/?umfrage=${encodeURIComponent(dayId)}`;
        await sendMail({
            to: user.email,
            subject: 'FC M – Bewerte deinen Spieltag! ⚽',
            text: `Der Spieltag ist vorbei – jetzt seid ihr gefragt!\n\nWer war die Überraschung des Spieltags? Wer war der Man of the Match? Und wie stark sind eure Mitspieler wirklich?\n\nHilf uns, die Spielerkarten zu verbessern und zukünftig noch ausgeglichenere Mannschaften zusammenzustellen.\n\nDie Umfrage dauert nur etwa 60–90 Sekunden und ist noch 48 Stunden nach Spielschluss geöffnet.\n\nZur Spieltagsumfrage:\n${PUBLIC_URL}/login?returnTo=${encodeURIComponent(returnTo)}\n\nViel Spaß!\nDein FC M`
        });
        await mutateSurveys(async () => {
            const saved = surveyData();
            const invite = saved.days[dayId].invites[playerId];
            invite.status = 'sent';
            invite.sentAt = new Date().toISOString();
            delete invite.error;
            await writeJson('umfragen.json', saved);
        });
    } catch (error) {
        console.error(`Umfrage-Einladung an ${maskMail(user.email)} fehlgeschlagen:`, error.message);
        await mutateSurveys(async () => {
            const saved = surveyData();
            const invite = saved.days[dayId].invites[playerId];
            invite.status = 'failed';
            invite.error = error.message.slice(0, 300);
            invite.updatedAt = new Date().toISOString();
            await writeJson('umfragen.json', saved);
        });
    }
}

function publicSurveyDay(day, session) {
    const playerId = spielerIdOf(session);
    const closed = isSurveyClosed(day.closesAt);
    if (session.role === 'admin') {
        const invites = Object.values(day.invites || {}).reduce((counts, invite) => {
            counts[invite.status] = (counts[invite.status] || 0) + 1;
            return counts;
        }, {});
        return {
            id: day.id, finishedAt: day.finishedAt, closesAt: day.closesAt,
            participantCount: day.participants.length,
            submittedCount: Object.keys(day.submissions || {}).length,
            invites, status: closed ? 'closed' : 'open',
            performance: aggregateSurveyComparisons({ days: { [day.id]: day }, ratings: {} }, 'performance'),
            attributes: aggregateSurveyComparisons({ days: { [day.id]: day }, ratings: {} }, 'attribute'),
            results: closed ? day.results || calculateSurveyAwards(day) : null
        };
    }
    const eligible = !!playerId && day.participants.includes(playerId);
    return {
        id: day.id, eligible, closesAt: day.closesAt,
        status: closed ? 'closed' : 'open',
        answered: !!(playerId && day.submissions && day.submissions[playerId]),
        results: closed ? day.results || null : null
    };
}

function matchedSurveyForm(day, playerId) {
    const players = new Map(surveyPlayers().map(player => [player.id, player]));
    const form = day.forms[playerId];
    if (!form) return null;
    const show = id => {
        const player = players.get(id);
        return player ? { id, name: player.name, photo: player.photo } : { id, name: '(gelöscht)', photo: '' };
    };
    return {
        nominations: {
            surprise: { eligible: form.nominations.surprise.eligible.map(show), options: form.nominations.surprise.options },
            motm: { eligible: form.nominations.motm.eligible.map(show), options: form.nominations.motm.options }
        },
        comparisons: form.comparisons.map(question => ({
            id: question.id, kind: question.kind, prompt: question.prompt,
            a: show(question.a), b: show(question.b)
        }))
    };
}

async function startSurveyForDay(dayId) {
    return mutateSurveys(async () => {
        const saved = surveyData();
        if (saved.days[dayId]) return { error: 'Für diesen Spieltag wurde die Umfrage bereits gestartet' };
        const matches = csvRows(readFile('spiele.csv'));
        const header = matches[0] || [];
        const index = Object.fromEntries(header.map((name, i) => [name, i]));
        const participantIds = [...new Set(matches.slice(1)
            .filter(row => row[index.typ] === 'match' && row[index.match_day_id] === dayId)
            .map(row => row[index.spieler_id])
            .filter(Boolean))];
        if (!participantIds.length) return { error: 'Für diesen Spieltag wurden keine eindeutig zugeordneten Einzelspiele gefunden. Alte Spiele ohne matchDayId bleiben unverändert.' };

        const players = surveyPlayers();
        const playerById = new Map(players.map(player => [player.id, player]));
        const eligible = participantIds.filter(id => playerById.has(id)).map(id => playerById.get(id));
        if (!eligible.length) return { error: 'Die Spiele enthalten keine Spieler, die aktuell im Kader sind' };

        const finishedAt = new Date().toISOString();
        const closesAt = surveyDeadline(finishedAt);
        const comparisonCounts = {};
        const forms = {};
        for (const player of eligible) forms[player.id] = generateQuestionnaire(player.id, eligible, comparisonCounts);
        snapshotSurveyPriors(saved, players);
        const invites = Object.fromEntries(eligible.map(player => [player.id, {
            status: 'pending', attempts: 0, updatedAt: finishedAt
        }]));
        saved.days[dayId] = {
            id: dayId, finishedAt, closesAt, participants: eligible.map(player => player.id),
            forms, submissions: {}, invites, results: null
        };
        await writeJson('umfragen.json', saved);
        setImmediate(async () => {
            for (const player of eligible) {
                try { await sendSurveyInvitation(dayId, player.id); }
                catch (error) { console.error(`Versand der Umfrageeinladung für ${dayId}/${player.id} fehlgeschlagen:`, error.message); }
            }
        });
        return { day: saved.days[dayId] };
    });
}

// Antwort-Link in der Mail: signiert, gilt bis 3 Tage nach dem Spieltag, ändert beim Aufruf nichts (nur ein Klick auf der Seite)
const rsvpToken = (s, pid) => makeToken({ sid: s.id, pid, exp: new Date(s.datum + 'T23:59:59').getTime() + 3 * 86400e3 });
const rsvpLink = (s, pid, a) => `${PUBLIC_URL}/rsvp?t=${rsvpToken(s, pid)}&a=${a}`;

// Einladung an alle Spieler, deren Login einem Spieler zugeordnet ist (nur dort ist eine Mail-Adresse bekannt)
async function mailEinladung(s) {
    const result = { sent: 0, failed: [], skipped: 0 };
    const users = Object.values(loadUsers());
    const subject = `Fußball ${fmtDay(s)}: Bist du dabei?`;
    for (const [id, name] of playerNames()) {
        const email = (users.find(u => u.spielerId === id) || {}).email;
        if (!email || !EMAIL_RE.test(email)) { result.skipped++; continue; }
        const text = `Hallo ${name},\n\nbist du beim nächsten Spieltag dabei?\n\nWann: ${fmtDay(s)}\n${s.ort ? 'Wo: ' + s.ort + '\n' : ''}\nZusagen: ${rsvpLink(s, id, 'zu')}\nAbsagen: ${rsvpLink(s, id, 'ab')}\n\nDeine Antwort kannst du über denselben Link jederzeit noch ändern.\n\nFC M:sys`;
        try { await sendMail({ to: email, subject, text }); result.sent++; }
        catch (e) { console.error(`Einladung an ${email} fehlgeschlagen:`, e.message); result.failed.push(email + ': ' + e.message); }
    }
    return result;
}

const RSVP_STYLE = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#eef3fb,#f7f9fd);font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
  .box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 4px 24px rgba(15,23,42,.08);padding:28px 24px;width:min(92vw,380px);text-align:center}
  .logo{display:block;height:72px;width:auto;margin:0 auto 12px}
  h1{font-size:19px;margin:0 0 6px}p{font-size:14px;color:#475569;margin:0 0 14px;line-height:1.5}
  .info{background:#f1f5f9;border-radius:10px;padding:10px 12px;font-size:14px;color:#0f172a;margin-bottom:14px}
  .row{display:flex;gap:10px}button{flex:1;font:inherit;font-weight:700;padding:14px 8px;border:2px solid;border-radius:10px;cursor:pointer;background:#fff}
  .yes{color:#059669;border-color:#059669}.yes.on{background:#059669;color:#fff}.no{color:#e11d48;border-color:#e11d48}.no.on{background:#e11d48;color:#fff}
  .pick{box-shadow:0 0 0 4px rgba(37,99,235,.25)}small{display:block;margin-top:12px;font-size:12px;color:#94a3b8}`;
const rsvpPage = (res, code, inner) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>FC M:sys – Spieltag</title><style>${RSVP_STYLE}</style></head><body><div class="box"><img class="logo" src="/img/msys.svg" alt="FC M:sys">${inner}</div></body></html>`);
};

// Öffentliche Seite für die Links aus der Mail: GET zeigt nur an, erst der Klick (POST) speichert. Mail-Scanner, die Links vorab aufrufen, ändern so nichts.
async function handleRsvp(req, res, parsed) {
    let token = parsed.searchParams.get('t'), pick = parsed.searchParams.get('a');
    let action = null;
    if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req, 1e4));
        token = form.get('t'); action = form.get('a');
    }
    const payload = readToken(token);
    if (!payload || !payload.sid || !payload.pid) return rsvpPage(res, 400, '<h1>Link ungültig</h1><p>Dieser Link ist ungültig oder abgelaufen. Bitte nutze den Link aus der aktuellen Einladung oder melde dich in der App an.</p>');
    const z = loadZahlungen();
    const st = z.spieltage.find(x => x.id === payload.sid);
    if (!st) return rsvpPage(res, 404, '<h1>Spieltag nicht gefunden</h1><p>Diesen Spieltag gibt es nicht mehr.</p>');
    const name = playerNames().get(payload.pid) || 'Spieler';
    const vorbei = st.datum < berlinToday();
    let note = '';
    if (action === 'zu' || action === 'ab') {
        if (vorbei) note = '<p><b>Der Spieltag ist vorbei, die Antwort wurde nicht mehr geändert.</b></p>';
        else {
            st.antworten[payload.pid] = { status: action, at: new Date().toISOString(), by: 'mail' };
            await writeJson('zahlungen.json', z);
            note = action === 'zu' ? '<p><b style="color:#059669">Danke, du bist dabei!</b></p>' : '<p><b style="color:#e11d48">Schade, du hast abgesagt.</b></p>';
        }
        pick = action;
    }
    const cur = (st.antworten[payload.pid] || {}).status;
    const curText = cur === 'zu' ? 'Aktuell: zugesagt' : cur === 'ab' ? 'Aktuell: abgesagt' : 'Noch keine Antwort';
    rsvpPage(res, 200, `<h1>Hallo ${escHtml(name)}</h1>
      ${note}
      <div class="info"><b>${escHtml(fmtDay(st))}</b>${st.ort ? '<br>' + escHtml(st.ort) : ''}</div>
      ${vorbei ? '<p>Der Spieltag ist vorbei.</p>' : `<form method="post" action="/rsvp"><input type="hidden" name="t" value="${escHtml(token)}">
        <div class="row">
          <button name="a" value="zu" class="yes${cur === 'zu' ? ' on' : ''}${pick === 'zu' && cur !== 'zu' ? ' pick' : ''}">Zusagen</button>
          <button name="a" value="ab" class="no${cur === 'ab' ? ' on' : ''}${pick === 'ab' && cur !== 'ab' ? ' pick' : ''}">Absagen</button>
        </div></form><small>${curText} · du kannst deine Antwort jederzeit ändern.</small>`}`);
}

// ---------------------------------------------------------------------------
// Zahlungs-Sicht je Rolle
// ---------------------------------------------------------------------------
function spielerIdOf(session) {
    if (!AUTH_ENABLED) return null;
    const u = loadUsers()[session.sub];
    return u && u.spielerId || null;
}

function zahlungenFor(session) {
    const z = loadZahlungen();
    const surveys = surveyData().days;
    const list = [...z.spieltage].map(day => {
        const survey = surveys[day.id];
        return {
            ...day,
            finishedAt: survey ? survey.finishedAt : null,
            closesAt: survey ? survey.closesAt : null,
            surveyStarted: !!survey
        };
    }).sort((a, b) => (b.datum + b.uhrzeit).localeCompare(a.datum + a.uhrzeit));
    if (session.role === 'admin') return list;
    const mine = spielerIdOf(session);
    const cash = mine ? cashSummary(z) : null;
    // Spieler sehen alle Spieltage mit den Zu-/Absagen, aber nur ihren eigenen Zahlungsstatus
    return list.map(s => {
        const billed = !!mine && s.betragCent != null && s.teilnehmer.includes(mine);
        const account = billed ? cash.chargeStatus[`${s.id}:${mine}`] : null;
        return {
            id: s.id, datum: s.datum, uhrzeit: s.uhrzeit, dauerMinuten: s.dauerMinuten, ort: s.ort, titel: s.titel,
            finishedAt: s.finishedAt, closesAt: s.closesAt, surveyStarted: s.surveyStarted, einladungAt: s.einladungAt || null,
            antworten: Object.fromEntries(Object.entries(s.antworten).map(([id, a]) => [id, { status: a.status }])),
            betragCent: billed ? s.betragCent : null,
            teilnehmer: billed ? [mine] : [],
            bezahlt: billed && s.bezahlt[mine] ? { [mine]: s.bezahlt[mine] } : {},
            guthabenCent: mine ? cash.playerBalances[mine] || 0 : 0,
            ...(account ? { creditAppliedCent: account.creditAppliedCent, paidCent: account.paidCent, offenCent: account.openCent } : {})
        };
    });
}

// ---------------------------------------------------------------------------
// Startseite für nicht angemeldete Besucher
// ---------------------------------------------------------------------------
const LOGIN_PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FC M:sys – Anmelden</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#eef3fb,#f7f9fd);font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}
  .box{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 4px 24px rgba(15,23,42,.08);padding:32px 28px;width:min(92vw,360px);text-align:center}
  .logo{display:block;height:84px;width:auto;margin:0 auto 14px}
  h1{font-size:20px;margin:0 0 6px}h1 span{color:#2563eb}
  p{font-size:14px;color:#64748b;margin:0 0 22px}
  a.btn{display:block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:10px}
  a.btn:hover{background:#1d4ed8}
  small{display:block;margin-top:14px;font-size:12px;color:#94a3b8}
</style></head><body>
<div class="box">
  <img class="logo" src="/img/msys.svg" alt="FC M:Sys">
  <h1>FC M<span>:sys</span></h1>
  <p>Bitte melde dich an, um Statistiken und Zahlungen zu sehen.</p>
  <a class="btn" href="/login">Anmelden / Registrieren</a>
  <small>Neue Accounts sehen zunächst nur die Statistiken, bis der Admin sie einem Spieler zuordnet.</small>
</div></body></html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    try {
        await handle(req, res);
    } catch (e) {
        console.error(e);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(e.message) });
        else res.end();
    }
});

async function handle(req, res) {
    // Health-Check für den Hoster (keine Daten, kein Login)
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    // Schutz gegen DNS-Rebinding: nur erlaubte Hosts
    const host = (req.headers.host || '').split(':')[0];
    if (!ALLOWED_HOSTS.has(host)) { res.writeHead(403); return res.end(); }
    // Immer über die Hauptadresse arbeiten (Cookies gelten pro Domain, der Login-Rücksprung muss dazu passen)
    if (PUBLIC_URL_SET && req.method === 'GET' && host !== 'localhost' && host !== '127.0.0.1' && host !== new URL(PUBLIC_URL).hostname) {
        res.writeHead(301, { Location: PUBLIC_URL + req.url });
        return res.end();
    }

    const parsed = new URL(req.url, 'http://x');
    const url = parsed.pathname;
    const method = req.method;

    // --- Logos (öffentlich, auch für die Login-Seite): feste Liste, keine freien Pfade ---
    const imgFile = method === 'GET' && (url === '/favicon.ico' ? IMAGES['msys.svg'] : IMAGES[url.replace(/^\/img\//, '')]);
    if (imgFile) {
        res.writeHead(200, { 'Content-Type': imgFile.endsWith('.png') ? 'image/png' : 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(path.join(ROOT, 'src', 'img', imgFile)));
    }

    // Zu-/Absage über den Link aus der Mail (signierter Token, kein Login nötig)
    if (url === '/rsvp' && (method === 'GET' || method === 'POST')) return handleRsvp(req, res, parsed);

    // --- ohne Login erreichbar ---
    if (AUTH_ENABLED && method === 'GET' && url === '/login') return startLogin(res, parsed.searchParams.get('returnTo') || '/');
    if (AUTH_ENABLED && method === 'GET' && url === '/callback') {
        try { return await finishLogin(req, res, parsed.searchParams); }
        catch (e) {
            console.error(e);
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Login fehlgeschlagen: ' + e.message);
        }
    }
    if (method === 'GET' && url === '/logout') {
        res.writeHead(302, {
            Location: AUTH_ENABLED ? `${KINDE_DOMAIN}/logout?redirect=${encodeURIComponent(PUBLIC_URL)}` : '/',
            'Set-Cookie': cookie('mm_session', '', 0)
        });
        return res.end();
    }
    // --- ab hier nur mit Login ---
    const session = getSession(req);
    const isApi = url.startsWith('/api/') || url.startsWith('/fotos/');
    if (!session) {
        if (isApi) return sendJson(res, 401, { ok: false, error: 'Nicht angemeldet' });
        if (method === 'GET' && (url === '/' || url === '/index.html' || url === '/random.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(LOGIN_PAGE);
        }
        res.writeHead(302, { Location: '/' });
        return res.end();
    }
    const isAdmin = session.role === 'admin';
    const requireAdmin = () => { if (isAdmin) return true; sendJson(res, 403, { ok: false, error: 'Nur für Admins' }); return false; };

    if (url === '/api/umfragen' && method === 'GET') {
        const saved = await closeDueSurveys();
        return sendJson(res, 200, {
            surveys: Object.values(saved.days).map(day => {
                const view = publicSurveyDay(day, session);
                if (isAdmin) {
                    const names = new Map(surveyPlayers().map(player => [player.id, player.name]));
                    view.inviteDetails = Object.entries(day.invites || {}).map(([playerId, invite]) => ({
                        playerId, player: names.get(playerId) || '(gelöscht)', status: invite.status,
                        error: invite.error || ''
                    }));
                    view.ratingChanges = saved.ratings.history.filter(change => change.dayId === day.id)
                        .map(change => ({ ...change, player: names.get(change.playerId) || '(gelöscht)' }));
                }
                return view;
            })
        });
    }

    const surveyApi = /^\/api\/umfragen\/([\w-]+)(?:\/(antwort))?$/.exec(url);
    if (surveyApi && surveyApi[2] && method === 'POST') {
        const [, dayId] = surveyApi;
        const playerId = spielerIdOf(session);
        if (!playerId) return sendJson(res, 403, { ok: false, error: 'Dein Login ist noch keinem Spieler zugeordnet' });
        const body = await readJsonBody(req, 1e5);
        const result = await mutateSurveys(async () => {
            const saved = surveyData();
            const day = saved.days[dayId];
            if (!day || !day.participants.includes(playerId)) return { status: 403, error: 'Du bist für diesen Spieltag nicht teilnahmeberechtigt' };
            if (isSurveyClosed(day.closesAt)) {
                if (!day.results) {
                    day.results = calculateSurveyAwards(day);
                    day.publishedAt = day.closesAt;
                    await writeJson('umfragen.json', saved);
                }
                return { status: 410, error: 'Die Umfrage für diesen Spieltag ist abgeschlossen.' };
            }
            if (day.submissions[playerId]) return { status: 409, error: 'Du hast diese Umfrage bereits abgeschickt' };
            const answers = body && typeof body === 'object' && !Array.isArray(body) ? body.answers : null;
            if (!validAnswer(day.forms[playerId], answers)) return { status: 400, error: 'Bitte beantworte alle Fragen mit den angebotenen Antworten' };
            day.submissions[playerId] = {
                playerId, submittedAt: new Date().toISOString(),
                answers: {
                    surprise: answers.surprise,
                    motm: answers.motm,
                    comparisons: answers.comparisons.map(answer => {
                        const question = day.forms[playerId].comparisons.find(item => item.id === answer.id);
                        return {
                            id: question.id, kind: question.kind, attribute: question.attribute,
                            a: question.a, b: question.b, value: answer.value
                        };
                    })
                }
            };
            await recalculateSurveyRatings(saved, dayId);
            await writeJson('umfragen.json', saved);
            return { submittedAt: day.submissions[playerId].submittedAt, ratings: saved.ratings.current };
        });
        if (result.error) return sendJson(res, result.status, { ok: false, error: result.error });
        return sendJson(res, 200, { ok: true, submittedAt: result.submittedAt });
    }

    if (surveyApi && !surveyApi[2] && method === 'GET') {
        const [, dayId] = surveyApi;
        const saved = await closeDueSurveys();
        const day = saved.days[dayId];
        if (!day) return sendJson(res, 404, { ok: false, error: 'Für diesen Spieltag wurde keine Umfrage gestartet' });
        if (isAdmin) return sendJson(res, 200, publicSurveyDay(day, session));
        const playerId = spielerIdOf(session);
        if (!playerId) return sendJson(res, 403, { ok: false, error: 'Dein Login ist noch keinem Spieler zugeordnet' });
        if (!day.participants.includes(playerId)) return sendJson(res, 403, { ok: false, error: 'Du bist für diesen Spieltag nicht teilnahmeberechtigt' });
        const closed = isSurveyClosed(day.closesAt);
        const submission = day.submissions[playerId];
        return sendJson(res, 200, {
            id: dayId, closesAt: day.closesAt, status: closed ? 'closed' : 'open',
            submitted: !!submission, submittedAt: submission ? submission.submittedAt : null,
            answers: submission ? submission.answers : null,
            form: !closed && !submission ? matchedSurveyForm(day, playerId) : null,
            results: closed ? day.results : null
        });
    }

    const finishSurveyApi = /^\/api\/spieltage\/([\w-]+)\/umfrage\/abschliessen$/.exec(url);
    if (finishSurveyApi && method === 'POST') {
        if (!requireAdmin()) return;
        const dayId = finishSurveyApi[1];
        const dayRecord = loadZahlungen().spieltage.find(item => item.id === dayId);
        if (!dayRecord) return sendJson(res, 404, { ok: false, error: 'Spieltag nicht gefunden' });
        const result = await startSurveyForDay(dayId);
        if (result.error) return sendJson(res, 409, { ok: false, error: result.error });
        scheduleNextSurveyClose();
        return sendJson(res, 201, { ok: true, finishedAt: result.day.finishedAt, closesAt: result.day.closesAt, participantCount: result.day.participants.length });
    }

    const retrySurveyInviteApi = /^\/api\/spieltage\/([\w-]+)\/umfrage\/einladungen\/([\w-]+)$/.exec(url);
    if (retrySurveyInviteApi && method === 'POST') {
        if (!requireAdmin()) return;
        const [, dayId, playerId] = retrySurveyInviteApi;
        const saved = surveyData(), invite = saved.days[dayId] && saved.days[dayId].invites[playerId];
        if (!invite) return sendJson(res, 404, { ok: false, error: 'Einladung nicht gefunden' });
        if (invite.status !== 'failed') return sendJson(res, 409, { ok: false, error: 'Nur fehlgeschlagene Einladungen können erneut versendet werden' });
        await sendSurveyInvitation(dayId, playerId, true);
        const updated = surveyData().days[dayId].invites[playerId];
        return sendJson(res, updated.status === 'sent' ? 200 : 502, { ok: updated.status === 'sent', status: updated.status, error: updated.error || null });
    }

    if (method === 'GET' && (url === '/' || url === '/index.html' || url === '/random.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(ROOT, 'random.html')));
    }

    if (method === 'GET' && url === '/api/me') {
        const spielerId = spielerIdOf(session);
        const z = loadZahlungen();
        const cash = spielerId ? cashSummary(z) : null;
        return sendJson(res, 200, {
            sub: session.sub, name: session.name, email: session.email, role: session.role,
            spielerId, guthabenCent: spielerId ? cash.playerBalances[spielerId] || 0 : 0,
            authEnabled: AUTH_ENABLED, mailEnabled: MAIL_ENABLED, paypal: z.paypal || '', tiers: loadTiers(), statMode: loadStatMode()
        });
    }

    if (url === '/api/werbung' && method === 'GET') {
        const saved = readJson('werbung.json', {});
        const text = typeof saved.text === 'string' ? saved.text.slice(0, 200) : '';
        const image = typeof saved.image === 'string' && /^\/fotos\/werbung_[a-f0-9]{16}\.(?:png|jpg)$/.test(saved.image) ? saved.image : '';
        return sendJson(res, 200, { enabled: saved.enabled === true && (!!text || !!image), text, image });
    }
    if (url === '/api/werbung' && method === 'PUT') {
        if (!requireAdmin()) return;
        try {
            const b = await readJsonBody(req, 3 * 1024 * 1024);
            const saved = readJson('werbung.json', {});
            const text = typeof b.text === 'string' ? b.text.trim() : '';
            if (text.length > 200) return sendJson(res, 400, { ok: false, error: 'Der Werbetext darf höchstens 200 Zeichen enthalten' });

            let image = typeof saved.image === 'string' && /^\/fotos\/werbung_[a-f0-9]{16}\.(?:png|jpg)$/.test(saved.image) ? saved.image : '';
            let uploadedImage = '';
            if (b.removeImage === true) image = '';
            if (typeof b.imageData === 'string' && b.imageData) {
                const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(b.imageData);
                if (!match) return sendJson(res, 400, { ok: false, error: 'Bitte ein PNG- oder JPEG-Bild hochladen' });
                const buffer = Buffer.from(match[2], 'base64');
                if (!buffer.length || buffer.length > 2 * 1024 * 1024 || buffer.toString('base64') !== match[2]) {
                    return sendJson(res, 400, { ok: false, error: 'Das Bild muss kleiner als 2 MB und gültig kodiert sein' });
                }
                const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
                const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
                if ((match[1] === 'png' && !isPng) || (match[1] === 'jpeg' && !isJpeg)) {
                    return sendJson(res, 400, { ok: false, error: 'Der Bildinhalt passt nicht zum Dateiformat' });
                }
                const ext = isPng ? 'png' : 'jpg';
                const id = `werbung_${crypto.randomBytes(8).toString('hex')}`;
                await fotoPut(id, ext, buffer);
                image = `/fotos/${id}.${ext}`;
                uploadedImage = image;
            }

            if (b.enabled === true && !text && !image) {
                if (uploadedImage) await fotoDelete(uploadedImage.match(/^\/fotos\/([\w-]+)\./)[1]);
                return sendJson(res, 400, { ok: false, error: 'Für eine aktive Werbebanderole bitte Text oder Bild angeben' });
            }
            try {
                await writeJson('werbung.json', { enabled: b.enabled === true, text, image });
            } catch (e) {
                if (uploadedImage) await fotoDelete(uploadedImage.match(/^\/fotos\/([\w-]+)\./)[1]);
                throw e;
            }
            if (saved.image && saved.image !== image) {
                const oldId = saved.image.match(/^\/fotos\/([\w-]+)\./);
                if (oldId) await fotoDelete(oldId[1]);
            }
            return sendJson(res, 200, { ok: true, enabled: b.enabled === true, text, image });
        } catch (e) {
            return sendJson(res, 400, { ok: false, error: String(e.message) });
        }
    }

    // PayPal-Empfänger (E-Mail oder paypal.me-Link), den Spieler zum Bezahlen sehen
    if (url === '/api/einstellungen' && method === 'PUT') {
        if (!requireAdmin()) return;
        const b = await readJsonBody(req, 1e4);
        const v = String(b.paypal || '').trim().slice(0, 120);
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !/^https:\/\/(www\.)?paypal\.me\/[\w.-]+\/?$/i.test(v)) {
            return sendJson(res, 400, { ok: false, error: 'Bitte eine PayPal-E-Mail oder einen paypal.me-Link angeben' });
        }
        const z = loadZahlungen();
        z.paypal = v;
        await writeJson('zahlungen.json', z);
        return sendJson(res, 200, { ok: true });
    }

    // Elo-Grenzen der Karten-Stufen (Silber/Gold/Ikone); alle sehen sie (über /api/me), nur Admins ändern sie
    if (url === '/api/einstellungen/stufen' && method === 'PUT') {
        if (!requireAdmin()) return;
        const b = await readJsonBody(req, 1e3);
        const tiers = { silber: Number(b.silber), gold: Number(b.gold), ikone: Number(b.ikone) };
        if (!validTiers(tiers)) return sendJson(res, 400, { ok: false, error: 'Ganze Zahlen von 100 bis 3000, aufsteigend: Silber < Gold < Ikone' });
        const mode = b.mode === undefined ? loadStatMode() : b.mode;
        if (!STAT_MODES.includes(mode)) return sendJson(res, 400, { ok: false, error: 'Unbekannter Verteilungsmodus' });
        await writeJson('settings.json', { ...readJson('settings.json', {}), tiers, mode });
        return sendJson(res, 200, { ok: true, tiers, mode });
    }

    // --- Benutzer-Zuordnung (Kinde-User <-> Spieler) ---
    if (url === '/api/users' && method === 'GET') {
        if (!requireAdmin()) return;
        return sendJson(res, 200, loadUsers());
    }
    const userApi = /^\/api\/users\/([^/]+)$/.exec(url);
    if (userApi && method === 'PUT') {
        if (!requireAdmin()) return;
        const sub = decodeURIComponent(userApi[1]);
        const users = loadUsers();
        if (!users[sub]) return sendJson(res, 404, { ok: false, error: 'Unbekannter Benutzer' });
        const b = await readJsonBody(req, 1e4);
        users[sub].spielerId = typeof b.spielerId === 'string' && b.spielerId ? b.spielerId : null;
        await writeJson('users.json', users);
        return sendJson(res, 200, { ok: true });
    }

    // Testmail an die eigene Adresse des angemeldeten Admins: zeigt bei Problemen die Fehlermeldung des Mail-Dienstes
    if (url === '/api/mailtest' && method === 'POST') {
        if (!requireAdmin()) return;
        if (!MAIL_ENABLED) return sendJson(res, 400, { ok: false, error: 'Mail-Versand ist nicht eingerichtet (SMTP_USER und SMTP_PASS fehlen)' });
        if (!EMAIL_RE.test(session.email || '')) return sendJson(res, 400, { ok: false, error: 'Dein Login hat keine E-Mail-Adresse' });
        try {
            await sendMail({ to: session.email, subject: 'FC M:sys – Testmail', text: 'Hallo,\n\ndas ist eine Testmail aus FC M:sys. Der Mail-Versand funktioniert.\n\nFC M:sys' });
            return sendJson(res, 200, { ok: true, to: maskMail(session.email), via: 'SMTP ' + SMTP_HOST, from: MAIL_FROM });
        } catch (e) { console.error('Testmail fehlgeschlagen:', e.message); return sendJson(res, 502, { ok: false, error: e.message }); }
    }

    // --- Spieltage & Zahlungen ---
    if (url === '/api/zahlungen' && method === 'GET') return sendJson(res, 200, { spieltage: zahlungenFor(session) });

    const kasseApi = /^\/api\/kasse(?:\/([\w-]+))?$/.exec(url);
    if (kasseApi) {
        if (!requireAdmin()) return;
        const z = loadZahlungen();
        if (!kasseApi[1] && method === 'GET') {
            return sendJson(res, 200, { eintraege: z.kassenbuch, summary: cashSummary(z) });
        }
        if (!kasseApi[1] && method === 'POST') {
            const b = await readJsonBody(req, 1e4);
            if (!b || typeof b !== 'object' || Array.isArray(b)) return sendJson(res, 400, { ok: false, error: 'Ungültige Buchung' });
            const datum = typeof b.datum === 'string' ? b.datum : '';
            const beschreibung = typeof b.beschreibung === 'string' ? b.beschreibung.trim().slice(0, 120) : '';
            const gegenkonto = typeof b.gegenkonto === 'string' ? b.gegenkonto.trim().slice(0, 80) : '';
            const betragCent = Number(b.betragCent);
            const spielerId = typeof b.spielerId === 'string' && b.spielerId ? b.spielerId : null;
            if (!['einnahme', 'ausgabe', 'auszahlung'].includes(b.typ)) return sendJson(res, 400, { ok: false, error: 'Unbekannte Buchungsart' });
            const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(datum) ? new Date(datum + 'T00:00:00Z') : null;
            if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== datum) {
                return sendJson(res, 400, { ok: false, error: 'Ungültiges Datum' });
            }
            if (!beschreibung) return sendJson(res, 400, { ok: false, error: 'Beschreibung erforderlich' });
            if (!Number.isSafeInteger(betragCent) || betragCent < 1 || betragCent > 100000000) {
                return sendJson(res, 400, { ok: false, error: 'Betrag muss zwischen 0,01 € und 1.000.000,00 € liegen' });
            }
            if (spielerId && !playerNames().has(spielerId)) return sendJson(res, 400, { ok: false, error: 'Unbekannter Spieler' });
            if (b.typ === 'auszahlung' && !spielerId) return sendJson(res, 400, { ok: false, error: 'Für eine Guthabenauszahlung muss ein Spielerkonto ausgewählt werden' });
            if (b.typ === 'auszahlung' && cashSummary(z).playerBalances[spielerId] < betragCent) {
                return sendJson(res, 400, { ok: false, error: 'Das Spielerguthaben reicht für diese Auszahlung nicht aus' });
            }
            const eintrag = {
                id: 'k_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
                typ: b.typ, datum, beschreibung, betragCent, spielerId, gegenkonto
            };
            z.kassenbuch.push(eintrag);
            await writeJson('zahlungen.json', z);
            return sendJson(res, 201, { ok: true, eintrag });
        }
        if (kasseApi[1] && method === 'DELETE') {
            const before = z.kassenbuch.length;
            z.kassenbuch = z.kassenbuch.filter(x => x.id !== kasseApi[1]);
            if (z.kassenbuch.length === before) return sendJson(res, 404, { ok: false, error: 'Buchung nicht gefunden' });
            await writeJson('zahlungen.json', z);
            return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { ok: false, error: 'Methode nicht erlaubt' }, { Allow: kasseApi[1] ? 'DELETE' : 'GET, POST' });
    }

    if (url === '/api/spieltage' && method === 'POST') {
        if (!requireAdmin()) return;
        const b = await readJsonBody(req, 1e4);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.datum || '')) return sendJson(res, 400, { ok: false, error: 'Datum erforderlich' });
        const uhrzeit = String(b.uhrzeit || '').trim();
        if (uhrzeit && !/^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit)) return sendJson(res, 400, { ok: false, error: 'Uhrzeit im Format HH:MM' });
        const dauerMinuten = b.dauerMinuten == null || b.dauerMinuten === '' ? null : Number(b.dauerMinuten);
        if (dauerMinuten !== null && (!Number.isInteger(dauerMinuten) || dauerMinuten < 1 || dauerMinuten > 1440)) {
            return sendJson(res, 400, { ok: false, error: 'Dauer muss eine ganze Zahl zwischen 1 und 1440 Minuten sein' });
        }
        const z = loadZahlungen();
        const spieltag = normSpieltag({
            id: 'st_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
            datum: b.datum, uhrzeit, dauerMinuten, ort: String(b.ort || '').trim().slice(0, 80)
        });
        z.spieltage.push(spieltag);
        await writeJson('zahlungen.json', z);
        return sendJson(res, 200, { ok: true, id: spieltag.id });
    }

    const stApi = /^\/api\/spieltage\/([\w-]+)(?:\/(bezahlt|einladung|teilnahme|antwort|anwesend|abrechnung|erinnerung))?$/.exec(url);
    if (stApi) {
        const [, id, action] = stApi;
        const z = loadZahlungen();
        const s = z.spieltage.find(x => x.id === id);
        const known = playerNames();
        const isPlayer = pid => typeof pid === 'string' && (!known.size || known.has(pid));
        const setAnswer = (pid, status, by) => { if (status) s.antworten[pid] = { status, at: new Date().toISOString(), by }; else delete s.antworten[pid]; };
        const ok = async extra => { await writeJson('zahlungen.json', z); return sendJson(res, 200, { ok: true, ...extra }); };

        if (!action && method === 'DELETE') {
            if (!requireAdmin()) return;
            if (surveyData().days[id]) return sendJson(res, 409, { ok: false, error: 'Ein Spieltag mit gestarteter Umfrage kann nicht gelöscht werden' });
            z.spieltage = z.spieltage.filter(x => x.id !== id);
            return ok();
        }
        if (!s) return sendJson(res, 404, { ok: false, error: 'Spieltag nicht gefunden' });

        if (action === 'bezahlt' && method === 'POST') {
            if (!requireAdmin()) return;
            const b = await readJsonBody(req, 1e4);
            if (!s.teilnehmer.includes(b.spielerId)) return sendJson(res, 404, { ok: false, error: 'Nicht gefunden' });
            if (b.paid) {
                const state = cashSummary(z).chargeStatus[`${s.id}:${b.spielerId}`];
                const dueCent = state ? state.openCent : s.betragCent;
                const betragCent = Number(b.betragCent);
                if (!Number.isSafeInteger(betragCent) || betragCent !== dueCent || betragCent <= 0) {
                    return sendJson(res, 400, { ok: false, error: 'Der zu erfassende Betrag hat sich geändert. Bitte aktualisieren und erneut versuchen.' });
                }
                s.bezahlt[b.spielerId] = { via: 'manuell', at: new Date().toISOString(), betragCent };
            } else delete s.bezahlt[b.spielerId];
            return ok();
        }

        // Admin: Zusage/Absage/Zurücksetzen für einen Spieler
        if (action === 'teilnahme' && method === 'POST') {
            if (!requireAdmin()) return;
            const b = await readJsonBody(req, 1e4);
            if (!isPlayer(b.spielerId)) return sendJson(res, 400, { ok: false, error: 'Unbekannter Spieler' });
            if (b.status && b.status !== 'zu' && b.status !== 'ab') return sendJson(res, 400, { ok: false, error: 'Status zu, ab oder leer' });
            setAnswer(b.spielerId, b.status || null, 'admin');
            return ok();
        }

        // Eingeloggter Spieler: eigene Zu-/Absage (auch nachträglich ändern, solange der Spieltag nicht vorbei ist)
        if (action === 'antwort' && method === 'POST') {
            const pid = spielerIdOf(session);
            if (!pid) return sendJson(res, 400, { ok: false, error: 'Dein Login ist noch keinem Spieler zugeordnet' });
            const b = await readJsonBody(req, 1e3);
            if (b.status !== 'zu' && b.status !== 'ab') return sendJson(res, 400, { ok: false, error: 'Status zu oder ab' });
            if (s.datum < berlinToday()) return sendJson(res, 400, { ok: false, error: 'Der Spieltag ist vorbei' });
            setAnswer(pid, b.status, 'app');
            return ok();
        }

        // Admin: Spieler, die tatsächlich gespielt haben, gelten als anwesend (zugesagt)
        if (action === 'anwesend' && method === 'POST') {
            if (!requireAdmin()) return;
            const b = await readJsonBody(req, 1e5);
            (Array.isArray(b.spielerIds) ? b.spielerIds : []).filter(isPlayer).forEach(pid => { if ((s.antworten[pid] || {}).status !== 'zu') setAnswer(pid, 'zu', 'spiel'); });
            return ok();
        }

        // Admin: Einladung per Mail an alle Spieler mit bekanntem Login
        if (action === 'einladung' && method === 'POST') {
            if (!requireAdmin()) return;
            if (!MAIL_ENABLED) return sendJson(res, 400, { ok: false, error: 'Mail-Versand ist nicht eingerichtet' });
            const mail = await mailEinladung(s);
            if (mail.sent) s.einladungAt = new Date().toISOString();
            return ok({ mail });
        }

        // Admin: Abrechnung für den Spieltag (Betrag + Teilnehmer), optional mit Mail
        if (action === 'abrechnung' && method === 'POST') {
            if (!requireAdmin()) return;
            const b = await readJsonBody(req, 1e5);
            const betragCent = Math.round(Number(b.betragCent));
            const teilnehmer = Array.isArray(b.teilnehmer) ? [...new Set(b.teilnehmer.map(String))].filter(isPlayer) : [];
            if (!(betragCent >= 0 && betragCent <= 100000) || !teilnehmer.length) return sendJson(res, 400, { ok: false, error: 'Betrag und Teilnehmer erforderlich' });
            s.betragCent = betragCent; s.teilnehmer = teilnehmer;
            Object.keys(s.bezahlt).forEach(pid => { if (!teilnehmer.includes(pid)) delete s.bezahlt[pid]; });
            await writeJson('zahlungen.json', z);
            const summary = cashSummary(z);
            const openAmounts = Object.fromEntries(teilnehmer.map(pid => [pid, summary.chargeStatus[`${s.id}:${pid}`]?.openCent || 0]));
            const mail = MAIL_ENABLED && b.mail !== false ? await mailZahlungsanforderung(s, { openAmounts }) : null;
            return sendJson(res, 200, { ok: true, mail });
        }
        // Admin: Zahlungserinnerung per Mail an alle, die noch nicht bezahlt haben
        if (action === 'erinnerung' && method === 'POST') {
            if (!requireAdmin()) return;
            if (!MAIL_ENABLED) return sendJson(res, 400, { ok: false, error: 'Mail-Versand ist nicht eingerichtet' });
            if (s.betragCent == null || !s.teilnehmer.length) return sendJson(res, 400, { ok: false, error: 'Für diesen Spieltag gibt es noch keine Abrechnung' });
            const summary = cashSummary(z);
            const openAmounts = Object.fromEntries(s.teilnehmer.map(pid => [pid, summary.chargeStatus[`${s.id}:${pid}`]?.openCent || 0]));
            return sendJson(res, 200, { ok: true, mail: await mailZahlungsanforderung(s, { reminder: true, openAmounts }) });
        }
        if (action === 'abrechnung' && method === 'DELETE') {
            if (!requireAdmin()) return;
            s.betragCent = null; s.teilnehmer = []; s.bezahlt = {};
            return ok();
        }
    }

    // --- Spielerfotos (lokal: daten/fotos, sonst Supabase-Storage) ---
    const fotoApi = /^\/api\/foto\/([\w-]+)$/.exec(url);
    if (fotoApi && (method === 'PUT' || method === 'DELETE')) {
        if (!requireAdmin()) return;
        const id = fotoApi[1];
        if (method === 'DELETE') {
            await fotoDelete(id);
            return sendJson(res, 200, { ok: true });
        }
        try {
            const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec((await readJsonBody(req)).data || '');
            if (!m) throw new Error('Ungültiges Bild');
            const ext = m[1] === 'png' ? 'png' : 'jpg';
            await fotoPut(id, ext, Buffer.from(m[2], 'base64'));
            return sendJson(res, 200, { ok: true, path: `fotos/${id}.${ext}` });
        } catch (e) {
            return sendJson(res, 400, { ok: false, error: String(e.message) });
        }
    }

    const fotoFile = /^\/fotos\/([\w-]+)\.(png|jpg)$/.exec(url);
    if (fotoFile && method === 'GET') {
        const buf = await fotoGet(fotoFile[1], fotoFile[2]);
        if (!buf) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': FOTO_TYPES[fotoFile[2]], 'Cache-Control': 'private, no-cache' });
        return res.end(buf);
    }

    // --- Spieldaten (CSV) ---
    if (url === '/api/state' && method === 'GET') {
        const state = {};
        for (const [key, file] of Object.entries(FILES)) state[key] = readFile(file);
        state.spieler = playersCsvWithSurveyRatings(state.spieler, surveyData().ratings.current);
        return sendJson(res, 200, state);
    }

    if (url === '/api/state' && method === 'PUT') {
        if (!requireAdmin()) return;
        try {
            const state = await readJsonBody(req);
            for (const [key, file] of Object.entries(FILES)) {
                if (typeof state[key] === 'string') await writeFileAtomic(file, state[key]);
            }
            return sendJson(res, 200, { ok: true });
        } catch (e) {
            return sendJson(res, 400, { ok: false, error: String(e.message) });
        }
    }

    res.writeHead(404);
    res.end();
}

async function recoverSurveyTasks() {
    await mutateSurveys(async () => {
        const saved = surveyData();
        let changed = false;
        for (const day of Object.values(saved.days)) {
            for (const invite of Object.values(day.invites || {})) {
                if (invite.status === 'sending') {
                    invite.status = 'uncertain';
                    invite.error = 'Versandstatus nach Serverneustart unklar; kein automatischer erneuter Versand';
                    invite.updatedAt = new Date().toISOString();
                    changed = true;
                }
                if (invite.status === 'pending' && isSurveyClosed(day.closesAt)) {
                    invite.status = 'expired';
                    invite.error = 'Die Umfragefrist ist vor dem Versand abgelaufen';
                    invite.updatedAt = new Date().toISOString();
                    changed = true;
                }
            }
        }
        if (changed) await writeJson('umfragen.json', saved);
    });
    const saved = await closeDueSurveys();
    for (const day of Object.values(saved.days)) {
        for (const [playerId, invite] of Object.entries(day.invites || {})) {
            if (invite.status === 'pending') {
                sendSurveyInvitation(day.id, playerId).catch(error =>
                    console.error(`Wiederaufnahme der Umfrageeinladung für ${day.id}/${playerId} fehlgeschlagen:`, error.message)
                );
            }
        }
    }
}

loadStore().then(async () => {
    try { await recoverSurveyTasks(); }
    catch (error) { console.error('Umfrage-Wiederherstellung fehlgeschlagen:', error.message); }
    scheduleNextSurveyClose();
    server.listen(PORT, HOST, () => {
        const addr = `http://localhost:${PORT}`;
        console.log(`FC-M:Sys läuft auf ${AUTH_ENABLED ? PUBLIC_URL : addr}`);
        console.log(`Login: ${AUTH_ENABLED ? 'Kinde (' + KINDE_DOMAIN + ')' : 'AUS (lokaler Modus, jeder ist Admin)'}`);
        console.log(`Daten: ${USE_SUPABASE ? 'Supabase (' + SUPABASE_URL + ')' : DATA_DIR}`);
        console.log(`Mail: ${MAIL_ENABLED ? 'SMTP ' + SMTP_HOST + ':' + SMTP_PORT + ', Absender ' + MAIL_FROM : 'AUS (SMTP_USER/SMTP_PASS fehlen)'}`);
        console.log('Zum Beenden: Strg+C');
        if (process.platform === 'win32' && !AUTH_ENABLED && !process.env.NO_OPEN) exec(`start "" ${addr}`);
    });
}).catch(e => {
    // Ohne erfolgreich geladene Daten nicht starten, damit nichts mit leeren Daten überschrieben wird
    console.error('Start abgebrochen:', e.message);
    process.exit(1);
});
