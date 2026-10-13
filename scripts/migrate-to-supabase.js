// Überträgt die lokalen Daten (Ordner "daten") einmalig nach Supabase.
// Aufruf:  node scripts/migrate-to-supabase.js        (liest SUPABASE_URL / SUPABASE_SERVICE_KEY aus .env)
// Vorhandene Einträge in Supabase werden überschrieben.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
} catch { /* keine .env */ }

const URL_ = (() => { try { return new URL(process.env.SUPABASE_URL).origin; } catch { return ''; } })();
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL und SUPABASE_SERVICE_KEY müssen gesetzt sein (.env).'); process.exit(1); }

const DATA = path.join(ROOT, 'daten');
const headers = { apikey: KEY, ...(KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}) };

(async () => {
    const rows = [];
    for (const f of ['spieler.csv', 'spiele.csv', 'presets.csv', 'users.json', 'zahlungen.json']) {
        try { rows.push({ key: f, value: fs.readFileSync(path.join(DATA, f), 'utf8'), updated_at: new Date().toISOString() }); }
        catch { console.log(`- ${f}: nicht vorhanden, übersprungen`); }
    }
    if (rows.length) {
        const r = await fetch(`${URL_}/rest/v1/kv?on_conflict=key`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows)
        });
        if (!r.ok) { console.error(`Tabelle kv: Fehler ${r.status}: ${await r.text()}\nWurde supabase/schema.sql ausgeführt?`); process.exit(1); }
        rows.forEach(x => console.log(`✓ ${x.key} (${x.value.length} Zeichen)`));
    }

    let n = 0;
    const fotoDir = path.join(DATA, 'fotos');
    for (const f of fs.existsSync(fotoDir) ? fs.readdirSync(fotoDir) : []) {
        const ext = path.extname(f).slice(1).toLowerCase();
        if (!['png', 'jpg'].includes(ext)) continue;
        const r = await fetch(`${URL_}/storage/v1/object/fotos/${f}`, {
            method: 'POST', headers: { ...headers, 'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg', 'x-upsert': 'true' }, body: fs.readFileSync(path.join(fotoDir, f))
        });
        if (!r.ok) { console.error(`Foto ${f}: Fehler ${r.status}: ${await r.text()}`); process.exit(1); }
        n++;
    }
    console.log(`✓ ${n} Foto(s) hochgeladen`);
    console.log('Fertig.');
})().catch(e => { console.error(e.message); process.exit(1); });
