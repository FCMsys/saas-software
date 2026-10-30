# Spieltagsumfragen

## Ablauf

Ein Admin schließt einen Spieltag in der Spieltagskarte ab, nachdem alle Einzelspiele gespeichert sind. Die App ermittelt die tatsächlichen Teilnehmer aus `spiele.csv` über die Spalte `match_day_id`. Bei älteren Spielen ohne diese Zuordnung zeigt die App die unzugeordneten historischen Spiele mit Datum, Uhrzeit, Ergebnis und Spielern zur Auswahl an. Spiele am Datum des Spieltags sind vorausgewählt; falls es keine gibt, kann der Admin die passenden Spiele anhand der Historie auswählen. Nach Bestätigung werden die ausgewählten CSV-Spielzeilen dauerhaft dem Spieltag zugeordnet. Der Server akzeptiert nur vorhandene, noch nicht zugeordnete Spiel-IDs. In der Spielhistorie ist für jedes Ergebnis sichtbar, ob und welchem Spieltag es zugeordnet ist. Wenn der Server keine unzugeordneten Ergebnisse findet, können die im Browser sichtbaren Spiele noch nicht mit dem Server synchronisiert oder bereits einem anderen Spieltag zugeordnet sein.

Der Abschlusszeitpunkt wird als ISO-Zeitstempel in `umfragen.json` gespeichert. Die Umfrage endet spätestens 48 Stunden danach, oder sofort, sobald alle Teilnehmer abgesendet haben. Der Server prüft dies bei jedem Abruf und jeder Einreichung; ein gezielter Timer veröffentlicht die Ergebnisse bei Fristablauf. Nach einem Neustart werden fällige und bereits vollständig beantwortete Umfragen beim Start geschlossen. Antworten können pro zugeordnetem Spieler und Spieltag nur einmal eingereicht werden.

Teilnehmer mit gültiger Login-Zuordnung erhalten eine E-Mail. Spieler ohne E-Mail finden die Umfrage weiterhin im Bereich **Spieltage**. Fehlgeschlagene Versandversuche sind in der Admin-Ansicht sichtbar und können dort erneut angestoßen werden. Ein nach einem Serverabbruch unklarer SMTP-Versand wird nicht automatisch wiederholt, um mögliche Doppel-E-Mails zu vermeiden.

Der Umfrage-Link führt über den regulären Login zurück zur persönlichen Umfrage. Nicht angemeldete Nutzer müssen sich anmelden; die Zuordnung des Kontos zu einem Spielerprofil bleibt erforderlich.

## Fragen und Auswertung

Jeder Fragebogen wird beim Spieltagsabschluss einmalig erzeugt und gespeichert. Paarungen enthalten nur tatsächliche Teilnehmer, schließen den Befragten aus, verwenden bevorzugt GES-Abstände bis 3 und niemals mehr als 5. Paarungen und Attributauswahl werden pro Spieltag möglichst gleichmäßig verteilt. Bei zu wenigen geeigneten Spielern entfallen Vergleichsfragen.

Attributvergleiche verwenden ein regularisiertes Bradley-Terry-Modell mit den vorhandenen Attributen als unsicheren Startwerten. Das Modell wird deterministisch aus allen bisher eingegangenen Vergleichsantworten neu berechnet; die Antwortstufen entsprechen Präferenzen von 0,9 / 0,65 / 0,5 / 0,35 / 0,1. Werte werden auf ganze Zahlen von 1 bis 99 begrenzt. Änderungen werden mit Zeitpunkt, Spieler, Attribut und Vorher-/Nachher-Wert protokolliert. Die Elo-Berechnung und der daraus abgeleitete GES-Wert bleiben davon getrennt.

Die Tagesleistungsvergleiche werden während der Umfrage aggregiert angezeigt. Nominierungen für **Man of the Match** und **Überraschung des Spieltags** bleiben bis zum Umfrageabschluss serverseitig verborgen. Sobald alle Teilnehmer geantwortet haben oder die Frist abläuft, werden Ranglisten, gleichplatzierte Gewinner und die Datenpunkte der Historie veröffentlicht.

## Elo bei Umfrageänderungen

Der gespeicherte Elo-Wert ist der Ausgangspunkt. Eine Umfrage addiert ausschließlich die tatsächlich angewandte Änderung der sechs Attribute, multipliziert mit 29/6. Der Elo-Wert wird beim Laden nicht aus dem Attributmittelwert neu gebildet. Bei erstmaliger Anwendung dienen die gespeicherten Umfrage-Startattribute als Referenz; danach verhindern die `survey_*`-Marker eine erneute Anwendung. Nachkommastellen bleiben erhalten, und Attributgrenzen werden berücksichtigt.

Neue Antworten speichern ihre tatsächlichen Elo-Differenzen. Neue Umfragepunkte in der Historie verwenden aufgezeichnete Elo-Anker und die bis zum Abschlusszeitpunkt eingegangenen Antworten, auch wenn der Abschluss erst später verarbeitet wird. Alte Antworten ohne gespeicherte Elo-Differenzen werden über das Attributmodell rekonstruiert. Bereits gespeicherte falsche Elo-Werte und Umfragepunkte benötigen eine separate Datenkorrektur; die Codekorrektur überschreibt sie nicht automatisch.

## Speicherung und Betrieb

- `spiele.csv`: neue Spiele speichern `match_day_id`; ältere Zeilen erhalten die Zuordnung erst nach expliziter Admin-Auswahl in der Historie/Umfrage.
- `umfragen.json`: Abschlusszeit, Frist, Teilnehmer, gespeicherte Fragebögen, Einreichungen, Versandstatus, Rating-Ausgangswerte, aktuelle Werte, Änderungsverlauf und veröffentlichte Auszeichnungen.
- `spieler.csv`: bestehende Attribute bleiben erhalten; die über Umfragen ermittelten Werte werden beim Laden der App serverseitig eingeblendet und durch spätere CSV-Speicherungen nicht zurückgesetzt.
- Wie die übrigen lokalen/Supabase-Daten ist auch der Umfragezustand für eine einzelne Serverinstanz ausgelegt.

Automatisierte Prüfungen: `node --test test/survey.test.js test/survey-api.test.js`.
