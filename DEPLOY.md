# FC M:sys auf dem IONOS-VPS (Docker)

Aufbau: `docker compose` startet zwei Container.
- **app**: der Node-Server (Port 3000, nur intern erreichbar)
- **caddy**: nimmt Port 80/443 an, holt das HTTPS-Zertifikat selbst (Let's Encrypt) und leitet an die App weiter

Mails gehen direkt über den IONOS-SMTP-Server (`smtp.ionos.de:465`), die Daten liegen weiter in Supabase (oder lokal im Docker-Volume, siehe unten).

## 1. DNS (bei IONOS)
Beide Einträge auf die öffentliche IPv4-Adresse des VPS stellen:

| Typ | Name | Wert |
|---|---|---|
| A | `www` | IP des VPS |
| A | `@` | IP des VPS |

Danach kurz warten und prüfen: `nslookup www.fc-msys.de`.

## 2. VPS vorbereiten (Ubuntu/Debian)
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # danach einmal ab- und wieder anmelden
```
Im IONOS-Cloud-Panel unter **Netzwerk → Firewall-Richtlinien** müssen die Ports **80** und **443** (TCP, und 443 UDP) eingehend erlaubt sein. Läuft auf dem Server `ufw`: `sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp`.

## 3. Code auf den Server
```bash
git clone https://github.com/FCMsys/saas-software.git fc-m-sys
cd fc-m-sys
```
(Bei privatem Repo mit Access-Token oder Deploy-Key; alternativ den Projektordner per `scp` kopieren.)

## 4. `.env` anlegen
```bash
cp .env.example .env
nano .env
```
Wichtig:
- `PUBLIC_URL=https://www.fc-msys.de` (Zeile einkommentieren)
- `SESSION_SECRET` (zufälliger Wert, siehe Kommentar in der Datei)
- `KINDE_*`, `ADMIN_EMAILS` wie bisher
- `SUPABASE_URL` und `SUPABASE_SERVICE_KEY` wie bisher (dann bleiben alle Daten, wie sie sind)
- `SMTP_PASS` = Passwort des Postfachs `info@fc-msys.de`
- `PORT` und `HOST` **nicht** eintragen

## 5. Starten
```bash
docker compose up -d --build
docker compose logs -f           # Strg+C beendet nur die Anzeige
```
Im Log der App stehen: `Daten: Supabase …`, `Mail: SMTP smtp.ionos.de:465, Absender …`. Caddy meldet, sobald das Zertifikat da ist.

Dann `https://www.fc-msys.de` öffnen und anmelden. In der App unter dem Regler-Symbol (Karten-Einstellungen) gibt es **„Mail-Versand testen“**: schickt eine Testmail an deine eigene Adresse und zeigt Fehlermeldungen direkt an.

## 6. Kinde
Bei der App FC-M:Sys unter Details müssen stehen:
- Allowed callback URLs: `https://www.fc-msys.de/callback`
- Allowed logout redirect URLs: `https://www.fc-msys.de`

## Updates einspielen
```bash
cd fc-m-sys
git pull
docker compose up -d --build
```
Die Container starten bei einem Server-Neustart von selbst wieder (`restart: unless-stopped`).

### Automatisch nach Push auf `main`
Der GitHub-Actions-Workflow `.github/workflows/deploy.yml` aktualisiert den VPS nach jedem Push auf `main`. Er verbindet sich per SSH-Schlüssel, holt `main` im bestehenden Checkout `/root/saas-software` und baut die Compose-App neu.

Einmalige Einrichtung:
1. Einen dedizierten SSH-Schlüssel für den Deployment-Zugriff erzeugen. Den privaten Schlüssel ausschließlich als GitHub-Repository-Secret `VPS_SSH_PRIVATE_KEY` hinterlegen; den zugehörigen öffentlichen Schlüssel auf dem VPS in `~/.ssh/authorized_keys` des SSH-Benutzers eintragen.
2. Unter **Repository → Settings → Secrets and variables → Actions → Variables** die Variablen `VPS_HOST` (VPS-Adresse) und `VPS_USER` (SSH-Benutzer; für den aktuellen Checkout unter `/root/saas-software` ist das `root`) anlegen.
3. Den verifizierten SSH-Hostschlüssel als Repository-Secret `VPS_SSH_KNOWN_HOSTS` speichern. Den Hostschlüssel-Fingerprint vorab direkt auf dem VPS prüfen; `ssh-keyscan` allein verifiziert den Schlüssel nicht.
4. Einen Test-Push auf `main` ausführen und unter **Actions** den Deploy-Workflow sowie anschließend den App-Status prüfen.

Passwörter oder private Schlüssel niemals in Workflow-Dateien, Commits oder Chatnachrichten ablegen. Für automatisches Deployment ist SSH-Schlüssel-Authentifizierung erforderlich; interaktive Passwortabfragen funktionieren in GitHub Actions nicht.

## Nützliche Befehle
```bash
docker compose ps                  # läuft alles? (app sollte "healthy" sein)
docker compose logs app --tail 100
docker compose restart app
docker compose down                # stoppt alles (Daten und Zertifikate bleiben in den Volumes)
```

## Daten
- **Mit Supabase (empfohlen, wie bisher):** nichts weiter zu tun. Das Docker-Volume `daten` bleibt ungenutzt.
- **Ohne Supabase:** `SUPABASE_*` in der `.env` leer lassen. Dann speichert der Server in das Volume `fc-m-sys_daten`. Bestehende Daten vorher mit `node scripts/migrate-to-supabase.js` (aus Supabase) bzw. den Dateien aus `daten/` übernehmen. Sicherung des Volumes:
  ```bash
  docker run --rm -v fc-m-sys_daten:/d -v "$PWD":/b alpine tar czf /b/daten-backup.tgz -C /d .
  ```

## Mail-Hinweise
- `SMTP_USER` ist die komplette Adresse, `MAIL_FROM` muss dieselbe Adresse (oder ein Alias des Postfachs) sein, sonst lehnt IONOS mit „Unauthorized sender address“ ab.
- Gehen Mails nicht raus, zuerst den Testknopf in der App benutzen: Die Meldung nennt den Grund (Passwort falsch, Port gesperrt, Absender nicht erlaubt).
- Ausgehend muss Port 465 offen sein. Bei IONOS-VPS ist er normalerweise erlaubt; sonst im Panel die Firewall bzw. den Mailversand freischalten.

## Umzug von Render
Erst wenn die App auf dem VPS läuft und das Zertifikat da ist: DNS-Einträge (siehe oben) auf den VPS umstellen und den Render-Dienst anhalten. Bis das DNS überall angekommen ist, kann es etwas dauern.
