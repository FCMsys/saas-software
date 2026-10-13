# FC-M:Sys auf Render veröffentlichen (kostenlos mit Supabase)

## 1. Supabase einrichten
1. Projekt anlegen auf supabase.com (Region EU).
2. **SQL Editor** → Inhalt von `supabase/schema.sql` einfügen und ausführen.
3. **Project Settings → API**: `Project URL` und den **secret**-Key (alt: `service_role`) notieren.

## 2. Bestehende Daten übertragen (einmalig)
In `.env` eintragen: `SUPABASE_URL=…` und `SUPABASE_SERVICE_KEY=…`, dann:

```
node scripts/migrate-to-supabase.js
```

Danach kannst du lokal mit denselben Variablen gegen Supabase testen (`start.bat`). Ohne die beiden Variablen nutzt der Server weiter den Ordner `daten`.

## 3. GitHub
```
git init
git add .
git commit -m "FC-M:Sys"
git branch -M main
git remote add origin https://github.com/<DEIN-NAME>/<REPO>.git
git push -u origin main
```
Die `.gitignore` hält `.env` und `daten/` aus dem Repository. Prüfe vor dem Push mit `git status`, dass keine `.env` dabei ist.

## 4. Render
1. Render → **New → Blueprint** → das GitHub-Repo wählen (liest `render.yaml`), oder **New → Web Service** mit Build Command leer und Start Command `node server.js`.
2. Unter **Environment** setzen: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `KINDE_DOMAIN`, `KINDE_CLIENT_ID`, `KINDE_CLIENT_SECRET`, `KINDE_ORG_CODE`, `KINDE_AUDIENCE`, `ADMIN_EMAILS`, optional `BREVO_API_KEY` und `MAIL_FROM`.
   `SESSION_SECRET` erzeugt Render selbst, `PUBLIC_URL` ergibt sich aus der Render-Adresse.
3. Nach dem ersten Deploy die Adresse (`https://<name>.onrender.com`) in Kinde bei **FC-M:Sys → Details** eintragen:
   - Allowed callback URLs: `https://<name>.onrender.com/callback`
   - Allowed logout redirect URLs: `https://<name>.onrender.com`

## Hinweise zum Free-Tarif
- Render schläft nach ca. 15 Minuten ohne Aufruf ein; der erste Aufruf danach dauert bis zu einer Minute.
- Render Free sperrt ausgehendes SMTP. Deshalb für Mails `BREVO_API_KEY` statt `SMTP_*` verwenden.
- Supabase pausiert Free-Projekte nach etwa einer Woche ohne Aktivität (im Dashboard wieder startbar).
- Der Server muss als genau **eine** Instanz laufen (die Daten werden im Speicher gepuffert).
