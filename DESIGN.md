# Corporate-Design-Farben

Quelle: `Msys_Farben-2021-09.pdf`, Corporate Design Manual, Stand 02. September 2021.

Die gemeinsame Palette steht in `src/design.js`. Die App verwendet daraus CSS-Variablen und die Tailwind-Farbskalen. Servergerenderte Seiten (Landingpage, Anmeldung und Zu-/Absage) verwenden dieselben Werte. Das Docker-Image enthält die Palette ebenfalls.

| Rolle | Farbe | Hex |
| --- | --- | --- |
| Marke, Akzente | Signalblau | `#00a0e4` |
| Buttons, Links mit weißem Hintergrund | Dunkelblau | `#204a97` |
| Text, dunkle Flächen | Blauschwarz | `#283278` |
| Hinweise, Gold-Karten | Signalgelb | `#ffd200` |
| Fehler, Absagen | Signalrot | `#dd2e42` |
| Erfolg, Zusagen | Dunkelgrün | `#0a642d` |
| Flächen und Abgrenzungen | Weiß, Grau, Grau-Blau und dokumentierte Abstufungen | siehe Palette |

Diagramme und Karten verwenden zusätzlich die eindeutigen Braun-, Violett-, Grün-, Petrol- und Orange-Werte des PDFs. Bestehende Tailwind-Klassennamen werden auf diese Palette abgebildet; es werden keine Standardfarben von Tailwind ergänzt. Neue Farben gehören ausschließlich in die gemeinsame Palette und müssen im PDF belegt sein.

Das PDF enthält widersprüchliche Angaben, etwa bei Kaki, Pastellpetrol und einzelnen RGB-Zeilen. Diese Einträge werden nicht verwendet. Bei Signalblau 20 % stimmen Farbfeld und RGB `212/237/252` überein; verwendet wird daher `#d4edfc` statt des abweichenden gedruckten Hex-Werts `#0cedfc`.

Transparenzen, Verläufe und Schatten verwenden ausschließlich die dokumentierten Grundfarben. Das FC-M:sys-Wappen verwendet ebenfalls die Palette. Hochgeladene Fotos, Sponsorlogos und bestehende Animations-/Bilddateien bleiben Originalinhalte.
