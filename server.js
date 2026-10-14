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

// --- .env laden (optional, ohne Abhängigkeit) ---
try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
} catch { /* keine .env */ }

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'daten');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const IMAGES = { 'msys.svg': 'Msys-Wappen.svg', 'lm.svg': 'L&M-Logo.svg', 'ramazzotti.svg': 'Ramazzotti-Logo.svg' };
const FILES = { spieler: 'spieler.csv', spiele: 'spiele.csv', presets: 'presets.csv' };

const KINDE_DOMAIN = (process.env.KINDE_DOMAIN || '').replace(/\/+$/, '');
const KINDE_CLIENT_ID = process.env.KINDE_CLIENT_ID || '';
const KINDE_CLIENT_SECRET = process.env.KINDE_CLIENT_SECRET || '';
const KINDE_ORG_CODE = process.env.KINDE_ORG_CODE || '';
const KINDE_AUDIENCE = process.env.KINDE_AUDIENCE || '';

// Mailversand über SMTP (z. B. Gmail mit App-Passwort). Ohne SMTP_USER/SMTP_PASS keine Mails.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 465;   // 465 = TLS, sonst STARTTLS (z. B. 587)
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
// Alternativ per Brevo-HTTP-API (nötig auf Hostern, die ausgehendes SMTP sperren, z. B. Render Free)
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_ENABLED = !!(BREVO_API_KEY ? MAIL_FROM : (SMTP_USER && SMTP_PASS));
// Fallback, falls Kinde keine Rollen ins Token schreibt: kommagetrennte Admin-E-Mail-Adressen
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const AUTH_ENABLED =!!(KINDE_DOMAIN && KINDE_CLIENT_ID);
// Auf Render setzt die Plattform RENDER_EXTERNAL_URL automatisch
const PUBLIC_URL_SET = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
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
// Die Render-Adresse bleibt neben einer eigenen Domain erreichbar; weitere Hosts (z. B. Domain ohne www) über ALLOWED_HOSTS
try { if (process.env.RENDER_EXTERNAL_URL) ALLOWED_HOSTS.add(new URL(process.env.RENDER_EXTERNAL_URL).hostname); } catch { }
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
const loadZahlungen = () => { const z = readJson('zahlungen.json', {}); if (!Array.isArray(z.spieltage)) z.spieltage = []; z.spieltage.forEach(normSpieltag); return z; };

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

function startLogin(res) {
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
        'Set-Cookie': cookie('mm_oauth', makeToken({ state, verifier, exp: Date.now() + 10 * 60e3 }), 600),
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
        Location: '/',
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

function buildMessage({ to, subject, text }) {
    const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
    return [
        `From: ${headerSafe(MAIL_FROM)}`, `To: ${headerSafe(to)}`, `Subject: ${encodeWord(headerSafe(subject))}`,
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

async function sendMail(msg) {
    if (!BREVO_API_KEY) return smtpSend(msg);
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(MAIL_FROM);
    const sender = m ? { ...(m[1] ? { name: m[1] } : {}), email: m[2] } : { email: MAIL_FROM.trim() };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: msg.to }], subject: msg.subject, textContent: msg.text })
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

const fmtDe = iso => iso.split('-').reverse().join('.');
const fmtEur = cent => (cent / 100).toFixed(2).replace('.', ',') + ' €';

// Schickt die Zahlungsanforderung an alle Teilnehmer, deren Login einem Spieler zugeordnet ist
async function mailZahlungsanforderung(spieltag) {
    const result = { sent: 0, failed: [], skipped: 0 };
    const paypal = loadZahlungen().paypal || '';
    const users = Object.values(loadUsers());
    const subject = `Fußball ${fmtDe(spieltag.datum)}: Beitrag ${fmtEur(spieltag.betragCent)}`;
    const pay = !paypal ? '' : /^https:/i.test(paypal)
        ? `Bezahlen: ${paypal.replace(/\/+$/, '')}/${(spieltag.betragCent / 100).toFixed(2)}EUR\n`
        : `Bitte per PayPal (Freunde & Familie) an: ${paypal}\n`;
    const text = `Hallo Sportsfreund,\n\nfür den Spieltag am ${fmtDe(spieltag.datum)}${spieltag.ort || spieltag.titel ? ' (' + (spieltag.ort || spieltag.titel) + ')' : ''} sind ${fmtEur(spieltag.betragCent)} fällig.\n` +
        pay + (PUBLIC_URL_SET ? `\nMehr Infos: ${PUBLIC_URL}\n` : '') + '\nDanke!\nFC:MSys';
    for (const id of spieltag.teilnehmer.filter(x => !spieltag.bezahlt[x])) {   // wer schon bezahlt hat, bekommt keine Mail
        const email = (users.find(u => u.spielerId === id) || {}).email;
        if (!email || !EMAIL_RE.test(email)) { result.skipped++; continue; }
        try { await sendMail({ to: email, subject, text }); result.sent++; }
        catch (e) { console.error(`Mail an ${email} fehlgeschlagen:`, e.message); result.failed.push(email + ': ' + e.message); }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Spieltage: Einladung per Mail, Zu-/Absagen
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const berlinToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const fmtDay = s => new Date(s.datum + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) + (s.uhrzeit ? ' · ' + s.uhrzeit + ' Uhr' : '');
const escHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function normSpieltag(s) {
    s.antworten = s.antworten || {}; s.uhrzeit = s.uhrzeit || ''; s.ort = s.ort || ''; s.titel = s.titel || '';
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
    const list = [...z.spieltage].sort((a, b) => (b.datum + b.uhrzeit).localeCompare(a.datum + a.uhrzeit));
    if (session.role === 'admin') return list;
    const mine = spielerIdOf(session);
    // Spieler sehen alle Spieltage mit den Zu-/Absagen, aber nur ihren eigenen Zahlungsstatus
    return list.map(s => {
        const billed = !!mine && s.betragCent != null && s.teilnehmer.includes(mine);
        return {
            id: s.id, datum: s.datum, uhrzeit: s.uhrzeit, ort: s.ort, titel: s.titel, einladungAt: s.einladungAt || null,
            antworten: Object.fromEntries(Object.entries(s.antworten).map(([id, a]) => [id, { status: a.status }])),
            betragCent: billed ? s.betragCent : null,
            teilnehmer: billed ? [mine] : [],
            bezahlt: billed && s.bezahlt[mine] ? { [mine]: s.bezahlt[mine] } : {}
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
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(fs.readFileSync(path.join(ROOT, 'src', 'img', imgFile)));
    }

    // Zu-/Absage über den Link aus der Mail (signierter Token, kein Login nötig)
    if (url === '/rsvp' && (method === 'GET' || method === 'POST')) return handleRsvp(req, res, parsed);

    // --- ohne Login erreichbar ---
    if (AUTH_ENABLED && method === 'GET' && url === '/login') return startLogin(res);
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

    if (method === 'GET' && (url === '/' || url === '/index.html' || url === '/random.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(ROOT, 'random.html')));
    }

    if (method === 'GET' && url === '/api/me') {
        return sendJson(res, 200, {
            sub: session.sub, name: session.name, email: session.email, role: session.role,
            spielerId: spielerIdOf(session), authEnabled: AUTH_ENABLED, mailEnabled: MAIL_ENABLED, paypal: loadZahlungen().paypal || '', tiers: loadTiers(), statMode: loadStatMode()
        });
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

    // --- Spieltage & Zahlungen ---
    if (url === '/api/zahlungen' && method === 'GET') return sendJson(res, 200, { spieltage: zahlungenFor(session) });

    if (url === '/api/spieltage' && method === 'POST') {
        if (!requireAdmin()) return;
        const b = await readJsonBody(req, 1e4);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.datum || '')) return sendJson(res, 400, { ok: false, error: 'Datum erforderlich' });
        const uhrzeit = String(b.uhrzeit || '').trim();
        if (uhrzeit && !/^([01]\d|2[0-3]):[0-5]\d$/.test(uhrzeit)) return sendJson(res, 400, { ok: false, error: 'Uhrzeit im Format HH:MM' });
        const z = loadZahlungen();
        const spieltag = normSpieltag({
            id: 'st_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
            datum: b.datum, uhrzeit, ort: String(b.ort || '').trim().slice(0, 80)
        });
        z.spieltage.push(spieltag);
        await writeJson('zahlungen.json', z);
        return sendJson(res, 200, { ok: true, id: spieltag.id });
    }

    const stApi = /^\/api\/spieltage\/([\w-]+)(?:\/(bezahlt|einladung|teilnahme|antwort|anwesend|abrechnung))?$/.exec(url);
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
            z.spieltage = z.spieltage.filter(x => x.id !== id);
            return ok();
        }
        if (!s) return sendJson(res, 404, { ok: false, error: 'Spieltag nicht gefunden' });

        if (action === 'bezahlt' && method === 'POST') {
            if (!requireAdmin()) return;
            const b = await readJsonBody(req, 1e4);
            if (!s.teilnehmer.includes(b.spielerId)) return sendJson(res, 404, { ok: false, error: 'Nicht gefunden' });
            if (b.paid) s.bezahlt[b.spielerId] = { via: 'manuell', at: new Date().toISOString() };
            else delete s.bezahlt[b.spielerId];
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
            const mail = MAIL_ENABLED && b.mail !== false ? await mailZahlungsanforderung(s) : null;
            return sendJson(res, 200, { ok: true, mail });
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

loadStore().then(() => {
    server.listen(PORT, HOST, () => {
        const addr = `http://localhost:${PORT}`;
        console.log(`FC-M:Sys läuft auf ${AUTH_ENABLED ? PUBLIC_URL : addr}`);
        console.log(`Login: ${AUTH_ENABLED ? 'Kinde (' + KINDE_DOMAIN + ')' : 'AUS (lokaler Modus, jeder ist Admin)'}`);
        console.log(`Daten: ${USE_SUPABASE ? 'Supabase (' + SUPABASE_URL + ')' : DATA_DIR}`);
        console.log(`Mail: ${MAIL_ENABLED ? (BREVO_API_KEY ? 'Brevo-API' : 'SMTP ' + SMTP_HOST) : 'AUS'}`);
        console.log('Zum Beenden: Strg+C');
        if (process.platform === 'win32' && !AUTH_ENABLED && !process.env.NO_OPEN) exec(`start "" ${addr}`);
    });
}).catch(e => {
    // Ohne erfolgreich geladene Daten nicht starten, damit nichts mit leeren Daten überschrieben wird
    console.error('Start abgebrochen:', e.message);
    process.exit(1);
});
