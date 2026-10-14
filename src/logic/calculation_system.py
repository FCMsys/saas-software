#!/usr/bin/env python3

"""Zema-Liga: Elo-System mit positionsgewichteter Attribut-Verteilung.
 
Kernlogik:

- Elo -> GES:  ges = RUNDEN((elo + 337) / 29)     [gedeckelt auf 99]

- GES -> Elo:  elo = 29 * ges - 337

- +1 GES = genau 6 Punkte, die auf die 6 Attribute verteilt werden

- Verteilung nach Positionsgewichten (bestimmt ODER zufaellig)

- Cap-Handling: Attribute am 99-Deckel (bzw. 1-Boden) werden uebergangen,

  die Punkte gehen an Attribute mit Spielraum. Punkte verfallen nur,

  wenn ALLE Attribute am Anschlag sind (Summe 6 x 99 = 594 erreicht).

"""

import math

import random
 
# ------------------------------------------------------------------

# Positionsgewichte: Ziehungschance bzw. Anteil je Attribut.

# Positionstypische Attribute haben hohe Werte (Verteidiger -> VER/PHY,

# Stuermer -> SCH/PHY, Aussen -> TEM/PAS ...). Jede Zeile = 100 %.

# ------------------------------------------------------------------

GEWICHTE = {

    "IV":  {"TEM": 0.10, "SCH": 0.10, "PAS": 0.15, "DRL": 0.10, "VER": 0.30, "PHY": 0.25},

    "LV":  {"TEM": 0.25, "SCH": 0.10, "PAS": 0.15, "DRL": 0.10, "VER": 0.20, "PHY": 0.20},

    "RV":  {"TEM": 0.25, "SCH": 0.10, "PAS": 0.15, "DRL": 0.10, "VER": 0.20, "PHY": 0.20},

    "ZDM":  {"TEM": 0.10, "SCH": 0.10, "PAS": 0.25, "DRL": 0.15, "VER": 0.20, "PHY": 0.20},

    "ZM":  {"TEM": 0.15, "SCH": 0.15, "PAS": 0.30, "DRL": 0.20, "VER": 0.10, "PHY": 0.10},

    "ZOM": {"TEM": 0.15, "SCH": 0.20, "PAS": 0.30, "DRL": 0.20, "VER": 0.10, "PHY": 0.05},

    "ST":  {"TEM": 0.20, "SCH": 0.30, "PAS": 0.10, "DRL": 0.15, "VER": 0.05, "PHY": 0.20},

    "LF":  {"TEM": 0.30, "SCH": 0.15, "PAS": 0.20, "DRL": 0.20, "VER": 0.05, "PHY": 0.10},

    "RF":  {"TEM": 0.30, "SCH": 0.15, "PAS": 0.20, "DRL": 0.20, "VER": 0.05, "PHY": 0.10},

}
 
ATTRS = ["TEM", "SCH", "PAS", "DRL", "VER", "PHY"]
 
MIN_WERT, MAX_WERT = 1, 99
 
 
# ------------------------------------------------------------------

# Grundformeln

# ------------------------------------------------------------------

def ges_aus_elo(elo):

    """Elo -> GES. Rundet wie Excel (.5 immer auf), gedeckelt auf 99."""

    return min(MAX_WERT, math.floor((elo + 337) / 29 + 0.5))
 
 
def elo_aus_ges(ges):

    """Rueckrichtung: GES -> passendes Elo."""

    return 29 * ges - 337
 
 
def karte(ges):

    """Kartenstufe nach GES."""

    if ges >= 75:

        return "Gold"

    if ges >= 65:

        return "Silber"

    return "Bronze"
 
 
def elo_update(elo, sieg):

    """Nach einem Spiel: Sieger +25, Verlierer -25."""

    return elo + 25 if sieg else elo - 25
 
 
def _gewichte_fuer(positionen):

    """Gewichte fuer eine Position oder Liste (Mehrfachposition: Mittel)."""

    if isinstance(positionen, str):

        positionen = [positionen]

    return {

        a: sum(GEWICHTE[p][a] for p in positionen) / len(positionen)

        for a in ATTRS

    }
 
 
# ------------------------------------------------------------------

# Verteilung: deterministisch (Erwartungswert) mit Cap-Umverteilung

# ------------------------------------------------------------------

def verteile_punkte(punkte, gewichte, attrs):

    """Verteilt `punkte` (int, auch negativ) gewichtet auf die Attribute.
 
    Anteile = punkte * gewicht, gerundet per groesstem Nachkomma-Rest.

    Cap-Handling: Punkte, die ein Attribut nicht aufnehmen kann, werden

    an Attribute mit Spielraum umverteilt. Verfallen tun Punkte nur,

    wenn ALLE Attribute am Anschlag sind.

    """

    deltas = {a: 0 for a in ATTRS}

    offen = punkte

    while offen != 0:

        if offen > 0:

            kopf = {a: MAX_WERT - (attrs[a] + deltas[a]) for a in ATTRS}

        else:

            kopf = {a: (attrs[a] + deltas[a]) - MIN_WERT for a in ATTRS}

        kandidaten = [a for a in ATTRS if kopf[a] > 0]

        if not kandidaten:

            break  # alle am Anschlag: restliche Punkte verfallen

        total = abs(offen)

        anteile = {a: total * gewichte[a] for a in kandidaten}

        zuteilung = {a: min(kopf[a], math.floor(anteile[a] + 1e-9))

                     for a in kandidaten}

        rest = total - sum(zuteilung.values())

        if rest > 0:

            reihen = sorted(

                kandidaten,

                key=lambda a: -(anteile[a] - math.floor(anteile[a] + 1e-9)))

            for i in range(rest):

                a = reihen[i % len(reihen)]

                if zuteilung[a] < kopf[a]:

                    zuteilung[a] += 1

        vergeben = sum(zuteilung.values())

        for a in kandidaten:

            deltas[a] += (1 if offen > 0 else -1) * zuteilung[a]

        offen -= (1 if offen > 0 else -1) * vergeben

        if vergeben == 0:

            break

    return deltas
 
 
# ------------------------------------------------------------------

# Verteilung: zufaellig (Wahrscheinlichkeiten = Positionsgewichte)

# ------------------------------------------------------------------

def verteile_zufaellig(punkte, gewichte, attrs, rng=random):

    """Wirft `punkte` einzeln auf Attribute (Ziehungen mit Wiederholung).
 
    Die Ziehungschance je Attribut entspricht dem Positionsgewicht.

    Attribute OHNE Spielraum (schon 99 bzw. schon 1) werden von der

    Ziehung ausgeschlossen -> jedes geworfene Gewicht wird auf die

    Attribute mit Spielraum umnormiert, d.h. das volle Attribut wird

    automatisch durch ein anderes ersetzt. Nur wenn ALLE Attribute am

    Anschlag sind, verfallen die restlichen Punkte.

    """

    deltas = {a: 0 for a in ATTRS}

    for _ in range(abs(punkte)):

        if punkte > 0:

            frei = [a for a in ATTRS if attrs[a] + deltas[a] < MAX_WERT]

        else:

            frei = [a for a in ATTRS if attrs[a] + deltas[a] > MIN_WERT]

        if not frei:

            break  # totale Saettigung: restliche Punkte verfallen

        a = rng.choices(frei, weights=[gewichte[x] for x in frei])[0]

        deltas[a] += 1 if punkte > 0 else -1

    return deltas
 
 
# ------------------------------------------------------------------

# Hauptfunktion: Elo-Aenderung -> neue Attribute + neues GES

# ------------------------------------------------------------------

def passe_attribute_an(attrs, elo_neu, positionen, ges_alt=None,

                       modus="zufall", rng=random):

    """Passt die Attribute an ein neues Elo an (positionsgewichtet).
 
    attrs:      dict TEM..PHY (aktuelle Werte)

    elo_neu:    neues Elo

    positionen: str oder Liste, z. B. "IV" oder ["Z6", "IV"]

    ges_alt:    alter offizieller GES-Wert

                - None  = Voll-Ausrichtung: Attribut-Mittel wird exakt

                          auf das neue GES gezogen (haelt Mittel == GES).

                - Wert = Nur-Aenderung: nur die GES-Aenderung wird

                          verteilt, das bisherige Profil bleibt erhalten.

    modus:      "zufall"          -> Zufallsziehung (Spielgefuehl)

                "deterministisch" -> Erwartungswert (reproduzierbar)

    Rueckgabe:  (neues attrs-dict, neues GES)

    """

    gewichte = _gewichte_fuer(positionen)

    ges_neu = ges_aus_elo(elo_neu)

    if ges_alt is None:

        delta = 6 * ges_neu - sum(attrs.values())

    else:

        delta = 6 * (ges_neu - ges_alt)

    if modus == "zufall":

        deltas = verteile_zufaellig(delta, gewichte, attrs, rng)

    else:

        deltas = verteile_punkte(delta, gewichte, attrs)

    neu = {a: min(MAX_WERT, max(MIN_WERT, attrs[a] + deltas[a])) for a in ATTRS}

    return neu, ges_neu
 
 
# ------------------------------------------------------------------

# Demo

# ------------------------------------------------------------------

if __name__ == "__main__":

    random.seed(42)  # nur fuer die Demo; in der Software weglassen
 
    # Beispiel: Fabian gewinnt (+25 Elo)

    elo = 1550

    ges = ges_aus_elo(elo)

    attrs = dict(TEM=51, SCH=60, PAS=79, DRL=60, VER=73, PHY=62)

    print(f"Fabian | Elo {elo} | GES {ges} | Karte {karte(ges)}")

    print("Vorher:", attrs)
 
    elo = elo_update(elo, sieg=True)

    attrs, ges = passe_attribute_an(attrs, elo, ["Z6", "IV"],

                                    ges_alt=ges, modus="zufall")

    print(f"Nach Sieg: Elo {elo} | GES {ges} | Karte {karte(ges)}")

    print("Nachher:", attrs)
 
    # Cap-Verhalten: fast alles auf 99, zufaellige Ziehung muss ausweichen

    attrs = dict(TEM=99, SCH=99, PAS=99, DRL=99, VER=99, PHY=90)

    d = verteile_zufaellig(12, GEWICHTE["IV"], attrs)

    neu = {a: attrs[a] + d[a] for a in ATTRS}

    print("\nCap-Test: nur PHY < 99, +12 Punkte zufaellig:", d)

    print("Nachher:", neu, "| alles <= 99:", all(v <= 99 for v in neu.values()))
 
    # Totale Saettigung: Punkte verfallen

    attrs = dict(TEM=99, SCH=99, PAS=99, DRL=99, VER=99, PHY=99)

    d = verteile_zufaellig(6, GEWICHTE["IV"], attrs)

    print("\nSaettigungs-Test: alles 99, +6 Punkte ->", d, "(Punkte verfallen)")
 