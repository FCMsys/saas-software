# Corporate-Design-Farben

Quelle: `Msys_Farben-2021-09.pdf`, Corporate Design Manual, Stand 02. September 2021.

Die gemeinsame Palette steht in `src/design.js`. Die App verwendet daraus CSS-Variablen und die Tailwind-Farbskalen. Servergerenderte Seiten (Landingpage, Anmeldung und Zu-/Absage) verwenden dieselben Werte. Das Docker-Image enthält die Palette ebenfalls.

| Rolle | Farbe | Hex |
| --- | --- | --- |
| Überwiegende Flächen, auch Spielerkarten | Weiß | `#ffffff` |
| Allgemeine Schrift | Schwarz | `#000000` |
| Hauptakzent, aktive Elemente, Buttons, Doppelpunkt in M:sys | Signalblau | `#00a0e4` |
| Kleine Auszeichnungsdetails | Signalgelb | `#ffd200` |
| Dezente Abgrenzungen | Grau und dokumentierte Abstufungen | siehe Palette |
| Untergeordnete Diagramm- und Effektakzente | Dunkelblau | `#204a97` |
| Absagen, abgelehnte/fehlgeschlagene Aktionen | Signalrot | `#dd2e42` |
| Zusagen, Bestätigungen | Dunkelgrün | `#0a642d` |

Maßgeblich ist die Abbildung **Gewichtung der Farben**: Weiß dominiert, Signalblau ist der wichtigste Farbakzent; Gelb, Grau und Dunkelblau bleiben deutlich untergeordnet. Dies ist eine visuelle Hierarchie, keine feste Pixelquote für jede Ansicht. Braun, Violett, Petrol und Orange werden nicht als dekorative Farben verwendet. Grün und Rot bleiben semantischen Bestätigungen beziehungsweise Absagen/Fehlern vorbehalten und erscheinen nicht als Team- oder Diagrammfarben.

Spielerkarten bleiben überwiegend weiß; Stufen und Auszeichnungen unterscheiden sich durch schmale Ränder, kleine Akzente und Beschriftungen. Allgemeine Schrift ist schwarz, auf dunklen Overlays und Bestätigungs-/Absageflächen weiß. Signalblaue und gelbe Buttons erhalten schwarze Schrift. Der Schriftzug lautet `M<span class="brand-colon">:</span>sys`: ausschließlich der Doppelpunkt ist signalblau.

Bestehende Tailwind-Klassennamen werden auf diese Palette abgebildet; für Textfarben gibt es eine eigene schwarze Standardskala. Es werden keine Standardfarben von Tailwind ergänzt. Neue Farben gehören ausschließlich in die gemeinsame Palette und müssen im PDF belegt sein.

Das PDF enthält widersprüchliche Angaben, etwa bei Kaki, Pastellpetrol und einzelnen RGB-Zeilen. Diese Einträge werden nicht verwendet. Bei Signalblau 20 % stimmen Farbfeld und RGB `212/237/252` überein; verwendet wird daher `#d4edfc` statt des abweichenden gedruckten Hex-Werts `#0cedfc`.

Transparenzen, Verläufe und Schatten verwenden ausschließlich die dokumentierten Grundfarben. Das FC-M:sys-Wappen verwendet ebenfalls die Palette. Hochgeladene Fotos, Sponsorlogos und bestehende Animations-/Bilddateien bleiben Originalinhalte.
