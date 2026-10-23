// UI language (German is the source language of all texts; English,
// Italian and Spanish are translations). Translation is automatic: every text node and
// every title/placeholder/aria-label whose German text is in the dictionary of
// the chosen language (or matches one of its patterns) is replaced; a
// MutationObserver translates what the scripts write later (status line,
// tooltips, dialogs). The German original is remembered per node, so switching
// back restores it. Texts without a translation stay German. The choice is per
// browser (localStorage), English by default. In German nothing is observed.
// A new language = one more entry in DICT and PATTERNS (+ an <option> in the
// language select in index.html).
(function () {
  const KEY = "open890rc.lang";
  const DICT = {
    en: {
    "Signal anklicken oder rechts/links wischen": "Click the signal or swipe right/left",
    "Einstellungen": "Settings",
    "Client Einstellungen": "Client settings",
    "Sprache": "Language",
    "Sprache der Oberfläche (nur dieser Browser)": "Interface language (this browser only)",
    "Schließen": "Close",
    "HTTPS-Zertifikat": "HTTPS certificate",
    "Der Server signiert sein Zertifikat mit einer eigenen CA. Installiert man diese CA einmal auf Handy oder Rechner und vertraut ihr, kommt keine Zertifikatswarnung mehr für diese IP/hostname.": "The server signs its certificate with its own CA. Once this CA is installed and trusted on a phone or computer, there is no more certificate warning for this IP/hostname.",
    "CA-Zertifikat laden (open890rc-ca.crt)": "Download CA certificate (open890rc-ca.crt)",
    "Codec:": "Codec:",
    "RX Taktkompensation": "RX clock compensation",
    "Bei Browser RX  Pufferüberlauf:": "On browser RX buffer overflow:",
    "Kürzen ab": "Trim above",
    "auf": "to",
    "TX anderer Clients mithören": "Listen to other clients' TX",
    "Tonausgabe auf:": "Audio output:",
    "Mikrofon": "Microphone",
    "Halte Bluetooth-/CarPlay Hands-Free Profile aktiv": "Keep Bluetooth/CarPlay Hands-Free profile active",
    "Reset VoIP Verbindung zum TS890 (wirkt auf alle verbundenen Clients)": "Reset VoIP connection to the TS890 (affects all connected clients)",
    "Der Server startet den VoIP-Strom des TS890 in diesem Abstand selbst neu (wirkt auf alle Clients, wartet während Senden/Tunen)": "The server restarts the TS890 VoIP stream at this interval (affects all clients, waits while transmitting/tuning)",
    "Codec für Audio-Übertragung": "Codec for audio transmission",
    "LAN, geringste Latenz": "LAN, lowest latency",
    "reduzierte Bitrate, für Mobilverbindungen": "reduced bitrate, for mobile connections",
    "Gleicht Taktabweichungen zwischen Radio und Browser automatisch aus": "Automatically compensates clock drift between radio and browser",
    "Wird der Rückstand im Browser-Puffer zu groß, werden die ältesten Audio-Daten verworfen": "If the browser buffer backlog gets too large, the oldest audio data is dropped",
    "Lautstärke, wenn ein anderer Client TX sendet und hier mitgehört wird (unabhängig von AF)": "Volume when another client transmits and is monitored here (independent of AF)",
    "Gerät für die Tonausgabe (nur dieser Browser). Auf iPhone/iPad wählt iOS das Gerät selbst, dort wird die Auswahl nicht angezeigt": "Device for audio output (this browser only). On iPhone/iPad iOS picks the device itself, so the choice is not shown there",
    "Eingabegerät für das Senden (nur dieses Gerät). Das eingebaute Mikrofon vermeidet bei Bluetooth die Umschaltung ins Headset-Profil": "Input device for transmitting (this device only). The built-in microphone avoids switching Bluetooth to the headset profile",
    "Verstärkung des Mikrofons im Browser vor dem Senden (nur dieses Gerät)": "Microphone gain in the browser before transmitting (this device only)",
    "Pegel des Browser-MIC": "Browser MIC level",
    "Sanfte Pegel-Begrenzung vor dem Senden gegen vereinzelte Übersteuerungsspitzen bei hohem Mic Gain": "Soft level limiting before transmitting against occasional overload peaks at high mic gain",
    "Hält HFP aktiv/offen um lange Umschaltzeiten zwischen Profilen bei TX zu vermeiden.": "Keeps HFP active/open to avoid long switching delays between profiles on TX.",
    "TS-890 ein-/ausschalten": "Power TS-890 on/off",
    "Gesamter Netzwerk-Traffic (Browser, empfangen) — Klick für die Aufteilung": "Total network traffic (browser, received) — click for the breakdown",
    "RX-Audio-Verzögerung (Server → Wiedergabe), Klick für Details": "RX audio delay (server → playback), click for details",
    "Aufnahme starten (RX, und beim Senden auch der eigene TX-Ton) — beim Beenden Download, mit Esc abbrechen und verwerfen": "Start recording (RX, and your own TX audio while transmitting) — download when stopped, Esc cancels and discards",
    "RX-Audio ein/aus": "RX audio on/off",
    "TON": "AUDIO",
    "Audio-Einstellungen (VOIP)": "Settings",
    "Datum und Uhrzeit (Browser)": "Date and time (browser)",
    "Aktiver VFO (A/B) - Klick zum Umschalten": "Active VFO (A/B) - click to switch",
    "Frequenz des inaktiven VFO": "Frequency of the inactive VFO",
    "Ein/Aus - lange drücken für Einstellungen": "On/Off - long press for settings",
    "Meter - Lange drücken für Einstellungen": "Meter - long press for settings",
    "Ein/Aus - drehen zum Einstellen / lange drücken für reset": "On/Off - turn to adjust / long press to reset",
    "Rauschreduzierung aktivieren / mehrmals drücken für AI NR": "Enable noise reduction / press repeatedly for AI NR",
    "Zeigerinstrument": "Analog meter",
    "Trägheit der Nadel": "Needle inertia",
    "Spitzenwert halten": "Hold peak value",
    "Wie schwer/träge sich die Nadel bewegt (Feder-Dämpfung) — 100% = Standard": "How heavy/sluggish the needle moves (spring damping) — 100% = default",
    "Zeit, die die Nadel auf einem neuen Spitzenwert verharrt, bevor sie absinkt — 0 = aus (folgt sofort)": "How long the needle stays on a new peak before it sinks — 0 = off (follows immediately)",
    "Rückgang": "Release",
    "Wie viel langsamer die Nadel sinkt als sie steigt (Vielfaches der Trägheit) — 100% = gleich schnell": "How much slower the needle sinks than it rises (multiple of Inertia) — 100% = same speed",
    "Voreinstellung des Limiters: sanft oder stark": "Limiter preset: soft or hard",
    "Senden/Empfangen umschalten (Alternativ \"t\" auf Tastatur drücken)": "Toggle transmit/receive (alternatively press the \"t\" key on the keyboard)",
    "Senden, solange gedrückt (Alternativ \"t\" auf Tastatur gedrückt halten)": "Transmit while pressed (alternatively hold the \"t\" key on the keyboard)",
    "Spektrum/Wasserfall ein- und ausschalten": "Switch spectrum/waterfall on or off",
    "Analoges Meter anstelle des Spektrums anzeigen": "Show the analog meter instead of the spectrum",
    "Spektrum-Geschwindigkeit (Hi/Mid/Lo)": "Spectrum speed (Hi/Mid/Lo)",
    "Spitzenwerte je Frequenz dauerhaft festhalten (leicht durchsichtig hinter der live weiterlaufenden Hüllkurve) — setzt sich beim Ein-/Ausschalten oder Verstimmen zurück": "Hold peak values per frequency (slightly transparent behind the live curve) — resets on switching on/off or retuning",
    "Waagerechte Dehnung weich (an) oder in scharfen Blöcken (aus) darstellen — wirkt nur auf unsere Anzeige": "Draw horizontal stretching smooth (on) or in sharp blocks (off) — only affects our display",
    "Stärke der waagerechten Glättung je Zeile (nur bei aktivem Smooth wirksam)": "Strength of the horizontal smoothing per row (only with Smooth on)",
    "Stärke der senkrechten Glättung über die Zeit (Schmiereffekt), nur bei aktivem Smooth wirksam": "Strength of the vertical smoothing over time (smear effect), only with Smooth on",
    "Darstellung anpassen (wirkt nur auf unsere Anzeige, ändert nichts am Radio) — linker Griff: Nullpunkt/Rauschboden, rechter Griff: Höhe/Kontrast der Werte": "Adjust the display (only affects our display, nothing on the radio) — left handle: zero point/noise floor, right handle: height/contrast of the values",
    "Floor/Ceiling automatisch aus den echten Werten je Zeile nachführen, träge geglättet statt sofort zu springen": "Track floor/ceiling automatically from the real values per row, smoothed slowly instead of jumping",
    "Aus": "Off",
    "Sanft": "Gentle",
    "Leicht": "Light",
    "Mittel": "Medium",
    "Stark": "Strong",
    "Maximal": "Maximum",
    "Spectrum aus": "Spectrum off",
    "Server nicht erreichbar": "Server not reachable",
    "Keine Verbindung zum Web-Server...": "No connection to the web server...",
    "Server Einstellungen": "Server settings",
    "Trenne WebServer <-> TS890": "Disconnect web server <-> TS890",
    "Verbinde WebServer <-> TS890": "Connect web server <-> TS890",
    "Trennt die Verbindung zwischen Web-Server und TS890 (wirkt für alle Clients)": "Disconnects the web server from the TS890 (affects all clients)",
    "Verbindet den Web-Server mit dem TS890 (mit den eingetragenen Werten, wie OK)": "Connects the web server to the TS890 (with the entered values, like OK)",
    "Benutzer": "Users",
    "IP or hostname of TS890": "IP or hostname of TS890",
    "MAC-Adresse für Wake-on-LAN (optional, wird automatisch ermittelt)": "MAC address for Wake-on-LAN (optional, detected automatically)",
    "automatisch": "automatic",
    "KNS Passwort": "KNS password",
    "Einstellungen merken und beim Start des Servers automatisch verbinden": "Remember the settings and connect automatically when the server starts",
    "verbinden": "connect",
    "trennen": "disconnect",
    "PA automatisch verbinden": "Connect the PA automatically",
    "PA TX (TimeOutTimer)": "PA TX (timeout timer)",
    "PA TimeOutTimer (Sicherheitsfeature falls TX mal hängt in Sek, 0 = AUS)": "PA timeout timer (safety feature if TX gets stuck, in seconds, 0 = off)",
    "Max PWR bei aktiver PA": "Max PWR with PA active",
    "Maximale Transceiverleistung (PWR), solange die PA aktiv ist": "Maximum transceiver power (PWR) while the PA is active",
    "Benutzeranmeldung für Anwender ausserhalb des lokalen LAN": "User login for people outside the local LAN",
    "Login Nachricht:": "Login message:",
    "speichern": "save",
    "Neuer Benutzer": "New user",
    "Abbrechen": "Cancel",
    "IP und User sind Pflichtfelder.": "IP and user are required fields.",
    "Beenden": "Quit",
    "Session beenden": "End session",
    "TS890 ausschalten": "Switch TS890 off",
    "TS890 einschalten": "Switch TS890 on",
    "Trennt diesen Browser vom Web-Server (meldet ihn ab und schliesst das Fenster); das TS890 bleibt an": "Disconnects this browser from the web server (logs it out and closes the window); the TS890 stays on",
    "Sitzung beendet": "Session ended",
    "Browser ist nun vom Webserver getrennt.": "Browser is now disconnected from the web server.",
    "Fenster bitte schliessen!": "Please close this window!",
    "Passwort": "Password",
    "Anmelden": "Log in",
    "Benutzer bearbeiten": "Edit user",
    "(leer = unverändert)": "(empty = unchanged)",
    "Löschen": "Delete",
    "Abbruch": "Cancel",
    "Admin: sieht die Einstellungen und die Benutzerverwaltung (und die PA)": "Admin: sees the settings and the user management (and the PA)",
    "PA: sieht und bedient die PA (Admins immer)": "PA: sees and operates the PA (admins always)",
    "kein Mikro": "no mic",
    "(nicht verfügbar)": "(not available)",
    "Netzwerk-Traffic": "Network traffic",
    "Status / Steuerung": "Status / control",
    "Spektrum": "Spectrum",
    "Summe": "Total",
    "Clients am Server:": "Clients connected to the server",
    "RX-Audio Verzögerung": "RX audio delay",
    "Puffer im Browser": "Buffer in the browser",
    "Ausgabe Browser": "Browser output",
    "Netzwerk (RTT/2)": "Network (RTT/2)",
    "RTT zum Server": "RTT to server",
    "RX-Audio": "RX audio",
    "Schliessen": "Close",
    "Filter Einstellungen": "Filter settings",
    "Filter wählen": "Select filter",
    "SSB Filter Mode": "SSB filter mode",
    "Breite": "Width",
    "APF Breite": "APF width",
    "Effekt": "Effect",
    "TX-Button Funktionsweise:": "TX button behavior:",
    "TX wenn gedrückt": "TX when pressed",
    "TX/RX umschalten": "TX/RX toggle",
    "TX wenn gedrückt: TX läuft nur, solange die Taste gehalten wird. TX/RX umschalten: ein Druck schaltet ein, der nächste aus. Die Taste T funktioniert immer als TX wenn gedrückt.": "TX when pressed: TX runs only while the button is held. TX/RX toggle: one press switches on, the next off. The T key always works as TX when pressed.",
    "Einstellen": "Adjust",
    "Zurücksetzen": "Reset",
    "Alle Bänder auf Ausgangswert zurücksetzen": "Reset all bands to their initial value",
    "Remote-Station von HB9INA": "Remote station of HB9INA",
    "JN37RE 500 m ü. M": "JN37RE 500 m a.s.l.",
    "OFF - Einschalten über PowerON links": "OFF - switch on with Power ON (left)",
    "PA wird ausgeschaltet...": "PA is being switched off...",
    "PA wird ausgeschalten": "PA is being switched off",
    "TS890 wird ausgeschalten": "TS890 is being switched off",
    "AUS-Befehl ohne Wirkung": "OFF command had no effect",
    "PA - STANDBY": "PA - STANDBY",
    "PA wird eingeschaltet... Verstärkung aktivieren mit PA OPER": "PA is switching on... enable amplification with PA OPER",
    "PA Tuner Anpassversuch läuft...": "PA tuner matching attempt running...",
    "Opus wird von diesem Browser nicht unterstützt (WebCodecs AudioDecoder fehlt).": "Opus is not supported by this browser (WebCodecs AudioDecoder missing).",
    "Opus-Encoding wird von diesem Browser nicht unterstützt": "Opus encoding is not supported by this browser",
    "Aufnahme wird von diesem Browser nicht unterstützt.": "Recording is not supported by this browser.",
    "Aufnahme konnte nicht gestartet werden: ": "Recording could not be started: ",
    "RX-Audio: ab diesem Rückstand im Browser-Puffer wird gekürzt (Sekunden)": "RX audio: the browser buffer is trimmed once the backlog exceeds this (seconds)",
    "RX-Audio: so viel Rückstand bleibt nach dem Kürzen (Sekunden)": "RX audio: this much backlog remains after trimming (seconds)",
    "Lautstärke des Mithörens, wenn ein anderer Client sendet (0 = aus)": "Monitoring volume when another client transmits (0 = off)",
    "Abstand in Minuten": "Interval in minutes",
    "Anmelden …": "Logging in …",
    "Mikrofonzugriff fehlgeschlagen": "Microphone access failed"
    },
    it: {
    "Signal anklicken oder rechts/links wischen": "Tocca il segnale o scorri a destra/sinistra",
    "Einstellungen": "Impostazioni",
    "Client Einstellungen": "Impostazioni client",
    "Sprache": "Lingua",
    "Sprache der Oberfläche (nur dieser Browser)": "Lingua dell'interfaccia (solo questo browser)",
    "Schließen": "Chiudi",
    "HTTPS-Zertifikat": "Certificato HTTPS",
    "Der Server signiert sein Zertifikat mit einer eigenen CA. Installiert man diese CA einmal auf Handy oder Rechner und vertraut ihr, kommt keine Zertifikatswarnung mehr für diese IP/hostname.": "Il server firma il proprio certificato con una CA propria. Dopo aver installato questa CA una volta su smartphone o computer e averle dato fiducia, non compare più l'avviso del certificato per questo IP/hostname.",
    "CA-Zertifikat laden (open890rc-ca.crt)": "Scarica certificato CA (open890rc-ca.crt)",
    "Codec:": "Codec:",
    "RX Taktkompensation": "Compensazione clock RX",
    "Bei Browser RX  Pufferüberlauf:": "In caso di overflow del buffer RX del browser:",
    "Kürzen ab": "Taglia sopra",
    "auf": "a",
    "TX anderer Clients mithören": "Ascolta il TX di altri client",
    "Tonausgabe auf:": "Uscita audio:",
    "Mikrofon": "Microfono",
    "Halte Bluetooth-/CarPlay Hands-Free Profile aktiv": "Mantieni attivo il profilo vivavoce Bluetooth/CarPlay",
    "Reset VoIP Verbindung zum TS890 (wirkt auf alle verbundenen Clients)": "Reset connessione VoIP verso il TS890 (agisce su tutti i client collegati)",
    "Der Server startet den VoIP-Strom des TS890 in diesem Abstand selbst neu (wirkt auf alle Clients, wartet während Senden/Tunen)": "Il server riavvia da solo il flusso VoIP del TS890 a questo intervallo (agisce su tutti i client, attende durante TX/tune)",
    "Codec für Audio-Übertragung": "Codec per la trasmissione audio",
    "LAN, geringste Latenz": "LAN, latenza minima",
    "reduzierte Bitrate, für Mobilverbindungen": "bitrate ridotto, per connessioni mobili",
    "Gleicht Taktabweichungen zwischen Radio und Browser automatisch aus": "Compensa automaticamente la deriva di clock tra radio e browser",
    "Wird der Rückstand im Browser-Puffer zu groß, werden die ältesten Audio-Daten verworfen": "Se l'arretrato nel buffer del browser diventa troppo grande, i dati audio più vecchi vengono scartati",
    "Lautstärke, wenn ein anderer Client TX sendet und hier mitgehört wird (unabhängig von AF)": "Volume quando un altro client trasmette e viene ascoltato qui (indipendente da AF)",
    "Gerät für die Tonausgabe (nur dieser Browser). Auf iPhone/iPad wählt iOS das Gerät selbst, dort wird die Auswahl nicht angezeigt": "Dispositivo per l'uscita audio (solo questo browser). Su iPhone/iPad lo sceglie iOS stesso, quindi la selezione non viene mostrata",
    "Eingabegerät für das Senden (nur dieses Gerät). Das eingebaute Mikrofon vermeidet bei Bluetooth die Umschaltung ins Headset-Profil": "Dispositivo di ingresso per la trasmissione (solo questo dispositivo). Il microfono integrato evita il passaggio del Bluetooth al profilo auricolare",
    "Verstärkung des Mikrofons im Browser vor dem Senden (nur dieses Gerät)": "Guadagno del microfono nel browser prima della trasmissione (solo questo dispositivo)",
    "Pegel des Browser-MIC": "Livello del MIC del browser",
    "Sanfte Pegel-Begrenzung vor dem Senden gegen vereinzelte Übersteuerungsspitzen bei hohem Mic Gain": "Limitazione morbida del livello prima della trasmissione contro i picchi di sovraccarico occasionali con Mic Gain alto",
    "Hält HFP aktiv/offen um lange Umschaltzeiten zwischen Profilen bei TX zu vermeiden.": "Mantiene HFP attivo/aperto per evitare lunghi tempi di commutazione tra i profili durante il TX.",
    "TS-890 ein-/ausschalten": "Accendi/spegni TS-890",
    "Gesamter Netzwerk-Traffic (Browser, empfangen) — Klick für die Aufteilung": "Traffico di rete totale (browser, ricevuto) — clic per il dettaglio",
    "RX-Audio-Verzögerung (Server → Wiedergabe), Klick für Details": "Ritardo audio RX (server → riproduzione), clic per i dettagli",
    "Aufnahme starten (RX, und beim Senden auch der eigene TX-Ton) — beim Beenden Download, mit Esc abbrechen und verwerfen": "Avvia registrazione (RX e, durante la trasmissione, anche il proprio audio TX) — download al termine, Esc annulla e scarta",
    "RX-Audio ein/aus": "Audio RX on/off",
    "TON": "AUDIO",
    "Audio-Einstellungen (VOIP)": "Impostazioni",
    "Datum und Uhrzeit (Browser)": "Data e ora (browser)",
    "Aktiver VFO (A/B) - Klick zum Umschalten": "VFO attivo (A/B) - clic per cambiare",
    "Frequenz des inaktiven VFO": "Frequenza del VFO inattivo",
    "Ein/Aus - lange drücken für Einstellungen": "On/Off - pressione lunga per le impostazioni",
    "Senden/Empfangen umschalten (Alternativ \"t\" auf Tastatur drücken)": "Passa tra trasmissione/ricezione (in alternativa premi il tasto \"t\" sulla tastiera)",
    "Senden, solange gedrückt (Alternativ \"t\" auf Tastatur gedrückt halten)": "Trasmetti finché premuto (in alternativa tieni premuto il tasto \"t\" sulla tastiera)",
    "Spektrum/Wasserfall ein- und ausschalten": "Attiva o disattiva spettro/cascata",
    "Analoges Meter anstelle des Spektrums anzeigen": "Mostra lo strumento analogico al posto dello spettro",
    "Spektrum-Geschwindigkeit (Hi/Mid/Lo)": "Velocità dello spettro (Hi/Mid/Lo)",
    "Spitzenwerte je Frequenz dauerhaft festhalten (leicht durchsichtig hinter der live weiterlaufenden Hüllkurve) — setzt sich beim Ein-/Ausschalten oder Verstimmen zurück": "Mantieni i picchi per frequenza (leggermente trasparenti dietro la curva dal vivo) — si azzera con on/off o sintonia",
    "Waagerechte Dehnung weich (an) oder in scharfen Blöcken (aus) darstellen — wirkt nur auf unsere Anzeige": "Disegna lo stiramento orizzontale morbido (on) o a blocchi netti (off) — agisce solo sulla nostra visualizzazione",
    "Stärke der waagerechten Glättung je Zeile (nur bei aktivem Smooth wirksam)": "Intensità dello smussamento orizzontale per riga (solo con Smooth attivo)",
    "Stärke der senkrechten Glättung über die Zeit (Schmiereffekt), nur bei aktivem Smooth wirksam": "Intensità dello smussamento verticale nel tempo (effetto scia), solo con Smooth attivo",
    "Darstellung anpassen (wirkt nur auf unsere Anzeige, ändert nichts am Radio) — linker Griff: Nullpunkt/Rauschboden, rechter Griff: Höhe/Kontrast der Werte": "Regola la visualizzazione (agisce solo sulla nostra visualizzazione, non cambia nulla sulla radio) — cursore sinistro: punto zero/rumore di fondo, cursore destro: altezza/contrasto dei valori",
    "Floor/Ceiling automatisch aus den echten Werten je Zeile nachführen, träge geglättet statt sofort zu springen": "Segui automaticamente floor/ceiling dai valori reali per riga, con smussamento lento invece di salti",
    "Aus": "Off",
    "Leicht": "Leggero",
    "Mittel": "Medio",
    "Stark": "Forte",
    "Maximal": "Massimo",
    "Spectrum aus": "Spettro off",
    "Server nicht erreichbar": "Server non raggiungibile",
    "Keine Verbindung zum Web-Server...": "Nessuna connessione al server web...",
    "Server Einstellungen": "Impostazioni server",
    "Trenne WebServer <-> TS890": "Disconnetti server web <-> TS890",
    "Verbinde WebServer <-> TS890": "Connetti server web <-> TS890",
    "Trennt die Verbindung zwischen Web-Server und TS890 (wirkt für alle Clients)": "Disconnette il server web dal TS890 (agisce su tutti i client)",
    "Verbindet den Web-Server mit dem TS890 (mit den eingetragenen Werten, wie OK)": "Collega il server web al TS890 (con i valori inseriti, come OK)",
    "Benutzer": "Utenti",
    "IP or hostname of TS890": "IP o hostname del TS890",
    "MAC-Adresse für Wake-on-LAN (optional, wird automatisch ermittelt)": "Indirizzo MAC per Wake-on-LAN (facoltativo, rilevato automaticamente)",
    "automatisch": "automatico",
    "KNS Passwort": "Password KNS",
    "Einstellungen merken und beim Start des Servers automatisch verbinden": "Ricorda le impostazioni e collega automaticamente all'avvio del server",
    "verbinden": "connetti",
    "trennen": "disconnetti",
    "PA automatisch verbinden": "Collega automaticamente la PA",
    "PA TX (TimeOutTimer)": "PA TX (timer di timeout)",
    "PA TimeOutTimer (Sicherheitsfeature falls TX mal hängt in Sek, 0 = AUS)": "Timer di timeout PA (sicurezza se il TX si blocca, in secondi, 0 = off)",
    "Max PWR bei aktiver PA": "PWR max con PA attiva",
    "Maximale Transceiverleistung (PWR), solange die PA aktiv ist": "Potenza massima del transceiver (PWR) mentre la PA è attiva",
    "Benutzeranmeldung für Anwender ausserhalb des lokalen LAN": "Accesso utente per chi è fuori dalla LAN locale",
    "Login Nachricht:": "Messaggio di login:",
    "speichern": "salva",
    "Neuer Benutzer": "Nuovo utente",
    "Abbrechen": "Annulla",
    "IP und User sind Pflichtfelder.": "IP e utente sono campi obbligatori.",
    "Beenden": "Esci",
    "Session beenden": "Termina sessione",
    "TS890 ausschalten": "Spegni il TS890",
    "TS890 einschalten": "Accendi il TS890",
    "Trennt diesen Browser vom Web-Server (meldet ihn ab und schliesst das Fenster); das TS890 bleibt an": "Scollega questo browser dal server web (lo disconnette e chiude la finestra); il TS890 resta acceso",
    "Sitzung beendet": "Sessione terminata",
    "Browser ist nun vom Webserver getrennt.": "Il browser è ora scollegato dal server web.",
    "Fenster bitte schliessen!": "Chiudere questa finestra, per favore!",
    "Passwort": "Password",
    "Anmelden": "Accedi",
    "Benutzer bearbeiten": "Modifica utente",
    "(leer = unverändert)": "(vuoto = invariata)",
    "Löschen": "Elimina",
    "Abbruch": "Annulla",
    "Admin: sieht die Einstellungen und die Benutzerverwaltung (und die PA)": "Admin: vede le impostazioni e la gestione utenti (e la PA)",
    "PA: sieht und bedient die PA (Admins immer)": "PA: vede e usa la PA (gli admin sempre)",
    "kein Mikro": "nessun mic",
    "(nicht verfügbar)": "(non disponibile)",
    "Netzwerk-Traffic": "Traffico di rete",
    "Status / Steuerung": "Stato / controllo",
    "Spektrum": "Spettro",
    "Summe": "Totale",
    "Clients am Server:": "Client collegati al server",
    "RX-Audio Verzögerung": "Ritardo audio RX",
    "Puffer im Browser": "Buffer nel browser",
    "Ausgabe Browser": "Uscita del browser",
    "Netzwerk (RTT/2)": "Rete (RTT/2)",
    "RTT zum Server": "RTT verso il server",
    "RX-Audio": "Audio RX",
    "Schliessen": "Chiudi",
    "Filter Einstellungen": "Impostazioni filtro",
    "Filter wählen": "Scegli filtro",
    "SSB Filter Mode": "Modo filtro SSB",
    "Breite": "Larghezza",
    "APF Breite": "Larghezza APF",
    "Effekt": "Effetto",
    "TX-Button Funktionsweise:": "Funzionamento del pulsante TX:",
    "TX wenn gedrückt": "TX se premuto",
    "TX/RX umschalten": "Commuta TX/RX",
    "TX wenn gedrückt: TX läuft nur, solange die Taste gehalten wird. TX/RX umschalten: ein Druck schaltet ein, der nächste aus. Die Taste T funktioniert immer als TX wenn gedrückt.": "TX se premuto: TX è attivo solo finché il pulsante resta premuto. Commuta TX/RX: una pressione attiva, la successiva disattiva. Il tasto T funziona sempre come TX se premuto.",
    "Voreinstellung des Limiters: sanft oder stark": "Preimpostazione del limitatore: morbida o forte",
    "Einstellen": "Regola",
    "Zurücksetzen": "Ripristina",
    "Alle Bänder auf Ausgangswert zurücksetzen": "Ripristina tutte le bande al valore iniziale",
    "Remote-Station von HB9INA": "Stazione remota di HB9INA",
    "JN37RE 500 m ü. M": "JN37RE 500 m s.l.m.",
    "OFF - Einschalten über PowerON links": "OFF - accendi con Power ON (a sinistra)",
    "PA wird ausgeschaltet...": "La PA si sta spegnendo...",
    "PA wird ausgeschalten": "La PA si sta spegnendo",
    "TS890 wird ausgeschalten": "Il TS890 si sta spegnendo",
    "AUS-Befehl ohne Wirkung": "Il comando OFF non ha avuto effetto",
    "PA - STANDBY": "PA - STANDBY",
    "PA wird eingeschaltet... Verstärkung aktivieren mit PA OPER": "La PA si sta accendendo... attiva l'amplificazione con PA OPER",
    "PA Tuner Anpassversuch läuft...": "Tentativo di accordo del tuner PA in corso...",
    "Opus wird von diesem Browser nicht unterstützt (WebCodecs AudioDecoder fehlt).": "Opus non è supportato da questo browser (manca WebCodecs AudioDecoder).",
    "Opus-Encoding wird von diesem Browser nicht unterstützt": "La codifica Opus non è supportata da questo browser",
    "Aufnahme wird von diesem Browser nicht unterstützt.": "La registrazione non è supportata da questo browser.",
    "Aufnahme konnte nicht gestartet werden: ": "Impossibile avviare la registrazione: ",
    "RX-Audio: ab diesem Rückstand im Browser-Puffer wird gekürzt (Sekunden)": "Audio RX: il buffer del browser viene tagliato quando l'arretrato supera questo valore (secondi)",
    "RX-Audio: so viel Rückstand bleibt nach dem Kürzen (Sekunden)": "Audio RX: questo arretrato rimane dopo il taglio (secondi)",
    "Lautstärke des Mithörens, wenn ein anderer Client sendet (0 = aus)": "Volume di ascolto quando un altro client trasmette (0 = off)",
    "Abstand in Minuten": "Intervallo in minuti",
    "Anmelden …": "Accesso in corso …",
    "Mikrofonzugriff fehlgeschlagen": "Accesso al microfono non riuscito",
    "auto connect": "connessione auto",
    "auto scroll": "scorrimento auto",
    "Auto": "Auto",
    "Smooth": "Smussato",
    "TCP port": "Porta TCP",
    "VoIP UDP port": "Porta UDP VoIP",
    "KNS User": "Utente KNS",
    "VoIP Audio Input": "Ingresso audio VoIP",
    "VoIP Audio Output": "Uscita audio VoIP",
    "VoIP Jitter Buffer": "Buffer jitter VoIP",
    "SPE Expert 1k5 COM port": "Porta COM SPE Expert 1k5",
    "Filter": "Filtro",
    "NAME": "NOME",
    "Level": "Livello",
    "Type": "Tipo",
    "Depth": "Profondità",
    "Width": "Larghezza",
    "TX Monitor": "Monitor TX",
    "Input": "Ingresso",
    "Output": "Uscita",
    "Mode": "Modo",
    "Soft": "Morbido",
    "Hard": "Duro",
    "TS890 VoIP reset": "Reset VoIP TS890",
    "Browser Mic Gain": "Guadagno mic browser",
    "TX Mic Limiter": "Limitatore mic TX",
    "Opus-Decode": "Decodifica Opus",
    "MAC (Wake-on-LAN)": "MAC (Wake-on-LAN)"
    },
    es: {
    "Signal anklicken oder rechts/links wischen": "Toca la señal o desliza a la derecha/izquierda",
    "Einstellungen": "Ajustes",
    "Client Einstellungen": "Ajustes del cliente",
    "Sprache": "Idioma",
    "Sprache der Oberfläche (nur dieser Browser)": "Idioma de la interfaz (solo este navegador)",
    "Schließen": "Cerrar",
    "HTTPS-Zertifikat": "Certificado HTTPS",
    "Der Server signiert sein Zertifikat mit einer eigenen CA. Installiert man diese CA einmal auf Handy oder Rechner und vertraut ihr, kommt keine Zertifikatswarnung mehr für diese IP/hostname.": "El servidor firma su certificado con una CA propia. Si se instala esta CA una vez en el móvil o el ordenador y se confía en ella, ya no aparece la advertencia del certificado para esta IP/hostname.",
    "CA-Zertifikat laden (open890rc-ca.crt)": "Descargar certificado CA (open890rc-ca.crt)",
    "Codec:": "Códec:",
    "RX Taktkompensation": "Compensación de reloj RX",
    "Bei Browser RX  Pufferüberlauf:": "Si se desborda el búfer RX del navegador:",
    "Kürzen ab": "Recortar a partir de",
    "auf": "a",
    "TX anderer Clients mithören": "Escuchar el TX de otros clientes",
    "Tonausgabe auf:": "Salida de audio:",
    "Mikrofon": "Micrófono",
    "Halte Bluetooth-/CarPlay Hands-Free Profile aktiv": "Mantener activo el perfil manos libres Bluetooth/CarPlay",
    "Reset VoIP Verbindung zum TS890 (wirkt auf alle verbundenen Clients)": "Reiniciar la conexión VoIP con el TS890 (afecta a todos los clientes conectados)",
    "Der Server startet den VoIP-Strom des TS890 in diesem Abstand selbst neu (wirkt auf alle Clients, wartet während Senden/Tunen)": "El servidor reinicia por sí mismo el flujo VoIP del TS890 con este intervalo (afecta a todos los clientes, espera durante TX/tune)",
    "Codec für Audio-Übertragung": "Códec para la transmisión de audio",
    "LAN, geringste Latenz": "LAN, latencia mínima",
    "reduzierte Bitrate, für Mobilverbindungen": "tasa de bits reducida, para conexiones móviles",
    "Gleicht Taktabweichungen zwischen Radio und Browser automatisch aus": "Compensa automáticamente la deriva de reloj entre la radio y el navegador",
    "Wird der Rückstand im Browser-Puffer zu groß, werden die ältesten Audio-Daten verworfen": "Si el retraso acumulado en el búfer del navegador es demasiado grande, se descartan los datos de audio más antiguos",
    "Lautstärke, wenn ein anderer Client TX sendet und hier mitgehört wird (unabhängig von AF)": "Volumen cuando otro cliente transmite y se escucha aquí (independiente de AF)",
    "Gerät für die Tonausgabe (nur dieser Browser). Auf iPhone/iPad wählt iOS das Gerät selbst, dort wird die Auswahl nicht angezeigt": "Dispositivo para la salida de audio (solo este navegador). En iPhone/iPad lo elige iOS, por eso la selección no se muestra",
    "Eingabegerät für das Senden (nur dieses Gerät). Das eingebaute Mikrofon vermeidet bei Bluetooth die Umschaltung ins Headset-Profil": "Dispositivo de entrada para transmitir (solo este dispositivo). El micrófono integrado evita que el Bluetooth cambie al perfil de auriculares",
    "Verstärkung des Mikrofons im Browser vor dem Senden (nur dieses Gerät)": "Ganancia del micrófono en el navegador antes de transmitir (solo este dispositivo)",
    "Pegel des Browser-MIC": "Nivel del MIC del navegador",
    "Sanfte Pegel-Begrenzung vor dem Senden gegen vereinzelte Übersteuerungsspitzen bei hohem Mic Gain": "Limitación suave del nivel antes de transmitir contra picos de sobrecarga ocasionales con Mic Gain alto",
    "Hält HFP aktiv/offen um lange Umschaltzeiten zwischen Profilen bei TX zu vermeiden.": "Mantiene HFP activo/abierto para evitar largos tiempos de conmutación entre perfiles al transmitir.",
    "TS-890 ein-/ausschalten": "Encender/apagar el TS-890",
    "Gesamter Netzwerk-Traffic (Browser, empfangen) — Klick für die Aufteilung": "Tráfico de red total (navegador, recibido) — clic para ver el desglose",
    "RX-Audio-Verzögerung (Server → Wiedergabe), Klick für Details": "Retardo del audio RX (servidor → reproducción), clic para detalles",
    "Aufnahme starten (RX, und beim Senden auch der eigene TX-Ton) — beim Beenden Download, mit Esc abbrechen und verwerfen": "Iniciar grabación (RX y, al transmitir, también tu propio audio TX) — descarga al terminar, Esc cancela y descarta",
    "RX-Audio ein/aus": "Audio RX on/off",
    "TON": "AUDIO",
    "Audio-Einstellungen (VOIP)": "Ajustes",
    "Datum und Uhrzeit (Browser)": "Fecha y hora (navegador)",
    "Aktiver VFO (A/B) - Klick zum Umschalten": "VFO activo (A/B) - clic para cambiar",
    "Frequenz des inaktiven VFO": "Frecuencia del VFO inactivo",
    "Ein/Aus - lange drücken für Einstellungen": "On/Off - pulsación larga para ajustes",
    "Senden/Empfangen umschalten (Alternativ \"t\" auf Tastatur drücken)": "Cambiar entre transmisión/recepción (alternativamente pulsar la tecla \"t\" del teclado)",
    "Senden, solange gedrückt (Alternativ \"t\" auf Tastatur gedrückt halten)": "Transmitir mientras se mantiene pulsado (alternativamente mantener la tecla \"t\" del teclado)",
    "Spektrum/Wasserfall ein- und ausschalten": "Activar o desactivar espectro/cascada",
    "Analoges Meter anstelle des Spektrums anzeigen": "Mostrar el instrumento analógico en lugar del espectro",
    "Spektrum-Geschwindigkeit (Hi/Mid/Lo)": "Velocidad del espectro (Hi/Mid/Lo)",
    "Spitzenwerte je Frequenz dauerhaft festhalten (leicht durchsichtig hinter der live weiterlaufenden Hüllkurve) — setzt sich beim Ein-/Ausschalten oder Verstimmen zurück": "Mantener los picos por frecuencia (ligeramente transparentes detrás de la curva en vivo) — se reinicia al encender/apagar o sintonizar",
    "Waagerechte Dehnung weich (an) oder in scharfen Blöcken (aus) darstellen — wirkt nur auf unsere Anzeige": "Dibujar el estiramiento horizontal suave (on) o en bloques nítidos (off) — solo afecta a nuestra visualización",
    "Stärke der waagerechten Glättung je Zeile (nur bei aktivem Smooth wirksam)": "Intensidad del suavizado horizontal por fila (solo con Smooth activo)",
    "Stärke der senkrechten Glättung über die Zeit (Schmiereffekt), nur bei aktivem Smooth wirksam": "Intensidad del suavizado vertical en el tiempo (efecto estela), solo con Smooth activo",
    "Darstellung anpassen (wirkt nur auf unsere Anzeige, ändert nichts am Radio) — linker Griff: Nullpunkt/Rauschboden, rechter Griff: Höhe/Kontrast der Werte": "Ajustar la visualización (solo afecta a nuestra visualización, no cambia nada en la radio) — control izquierdo: punto cero/ruido de fondo, control derecho: altura/contraste de los valores",
    "Floor/Ceiling automatisch aus den echten Werten je Zeile nachführen, träge geglättet statt sofort zu springen": "Seguir automáticamente floor/ceiling a partir de los valores reales por fila, con suavizado lento en lugar de saltos",
    "Aus": "Off",
    "Leicht": "Ligero",
    "Mittel": "Medio",
    "Stark": "Fuerte",
    "Maximal": "Máximo",
    "Spectrum aus": "Espectro off",
    "Server nicht erreichbar": "Servidor no accesible",
    "Keine Verbindung zum Web-Server...": "Sin conexión con el servidor web...",
    "Server Einstellungen": "Ajustes del servidor",
    "Trenne WebServer <-> TS890": "Desconectar servidor web <-> TS890",
    "Verbinde WebServer <-> TS890": "Conectar servidor web <-> TS890",
    "Trennt die Verbindung zwischen Web-Server und TS890 (wirkt für alle Clients)": "Desconecta el servidor web del TS890 (afecta a todos los clientes)",
    "Verbindet den Web-Server mit dem TS890 (mit den eingetragenen Werten, wie OK)": "Conecta el servidor web con el TS890 (con los valores introducidos, como OK)",
    "Benutzer": "Usuarios",
    "IP or hostname of TS890": "IP o hostname del TS890",
    "MAC-Adresse für Wake-on-LAN (optional, wird automatisch ermittelt)": "Dirección MAC para Wake-on-LAN (opcional, se detecta automáticamente)",
    "automatisch": "automático",
    "KNS Passwort": "Contraseña KNS",
    "Einstellungen merken und beim Start des Servers automatisch verbinden": "Recordar los ajustes y conectar automáticamente al iniciar el servidor",
    "verbinden": "conectar",
    "trennen": "desconectar",
    "PA automatisch verbinden": "Conectar la PA automáticamente",
    "PA TX (TimeOutTimer)": "PA TX (temporizador de timeout)",
    "PA TimeOutTimer (Sicherheitsfeature falls TX mal hängt in Sek, 0 = AUS)": "Temporizador de timeout de la PA (seguridad si el TX se bloquea, en segundos, 0 = off)",
    "Max PWR bei aktiver PA": "PWR máx. con PA activa",
    "Maximale Transceiverleistung (PWR), solange die PA aktiv ist": "Potencia máxima del transceptor (PWR) mientras la PA está activa",
    "Benutzeranmeldung für Anwender ausserhalb des lokalen LAN": "Inicio de sesión de usuarios fuera de la LAN local",
    "Login Nachricht:": "Mensaje de inicio de sesión:",
    "speichern": "guardar",
    "Neuer Benutzer": "Nuevo usuario",
    "Abbrechen": "Cancelar",
    "IP und User sind Pflichtfelder.": "IP y usuario son campos obligatorios.",
    "Beenden": "Salir",
    "Session beenden": "Terminar sesión",
    "TS890 ausschalten": "Apagar el TS890",
    "TS890 einschalten": "Encender el TS890",
    "Trennt diesen Browser vom Web-Server (meldet ihn ab und schliesst das Fenster); das TS890 bleibt an": "Desconecta este navegador del servidor web (cierra la sesión y la ventana); el TS890 sigue encendido",
    "Sitzung beendet": "Sesión terminada",
    "Browser ist nun vom Webserver getrennt.": "El navegador ya está desconectado del servidor web.",
    "Fenster bitte schliessen!": "¡Cierre esta ventana, por favor!",
    "Passwort": "Contraseña",
    "Anmelden": "Entrar",
    "Benutzer bearbeiten": "Editar usuario",
    "(leer = unverändert)": "(vacío = sin cambios)",
    "Löschen": "Eliminar",
    "Abbruch": "Cancelar",
    "Admin: sieht die Einstellungen und die Benutzerverwaltung (und die PA)": "Admin: ve los ajustes y la gestión de usuarios (y la PA)",
    "PA: sieht und bedient die PA (Admins immer)": "PA: ve y maneja la PA (los admins siempre)",
    "kein Mikro": "sin mic",
    "(nicht verfügbar)": "(no disponible)",
    "Netzwerk-Traffic": "Tráfico de red",
    "Status / Steuerung": "Estado / control",
    "Spektrum": "Espectro",
    "Summe": "Total",
    "Clients am Server:": "Clientes conectados al servidor",
    "RX-Audio Verzögerung": "Retardo del audio RX",
    "Puffer im Browser": "Búfer en el navegador",
    "Ausgabe Browser": "Salida del navegador",
    "Netzwerk (RTT/2)": "Red (RTT/2)",
    "RTT zum Server": "RTT al servidor",
    "RX-Audio": "Audio RX",
    "Schliessen": "Cerrar",
    "Filter Einstellungen": "Ajustes del filtro",
    "Filter wählen": "Elegir filtro",
    "SSB Filter Mode": "Modo de filtro SSB",
    "Breite": "Anchura",
    "APF Breite": "Anchura APF",
    "Effekt": "Efecto",
    "TX-Button Funktionsweise:": "Funcionamiento del botón TX:",
    "TX wenn gedrückt": "TX al pulsar",
    "TX/RX umschalten": "Alternar TX/RX",
    "TX wenn gedrückt: TX läuft nur, solange die Taste gehalten wird. TX/RX umschalten: ein Druck schaltet ein, der nächste aus. Die Taste T funktioniert immer als TX wenn gedrückt.": "TX al pulsar: TX funciona solo mientras se mantiene pulsado el botón. Alternar TX/RX: una pulsación activa, la siguiente desactiva. La tecla T siempre funciona como TX al pulsar.",
    "Voreinstellung des Limiters: sanft oder stark": "Preajuste del limitador: suave o fuerte",
    "Einstellen": "Ajustar",
    "Zurücksetzen": "Restablecer",
    "Alle Bänder auf Ausgangswert zurücksetzen": "Restablecer todas las bandas al valor inicial",
    "Remote-Station von HB9INA": "Estación remota de HB9INA",
    "JN37RE 500 m ü. M": "JN37RE 500 m s.n.m.",
    "OFF - Einschalten über PowerON links": "OFF - encender con Power ON (a la izquierda)",
    "PA wird ausgeschaltet...": "La PA se está apagando...",
    "PA wird ausgeschalten": "La PA se está apagando",
    "TS890 wird ausgeschalten": "El TS890 se está apagando",
    "AUS-Befehl ohne Wirkung": "El comando OFF no tuvo efecto",
    "PA - STANDBY": "PA - STANDBY",
    "PA wird eingeschaltet... Verstärkung aktivieren mit PA OPER": "La PA se está encendiendo... activa la amplificación con PA OPER",
    "PA Tuner Anpassversuch läuft...": "Intento de adaptación del tuner de la PA en curso...",
    "Opus wird von diesem Browser nicht unterstützt (WebCodecs AudioDecoder fehlt).": "Este navegador no admite Opus (falta WebCodecs AudioDecoder).",
    "Opus-Encoding wird von diesem Browser nicht unterstützt": "Este navegador no admite la codificación Opus",
    "Aufnahme wird von diesem Browser nicht unterstützt.": "Este navegador no admite la grabación.",
    "Aufnahme konnte nicht gestartet werden: ": "No se pudo iniciar la grabación: ",
    "RX-Audio: ab diesem Rückstand im Browser-Puffer wird gekürzt (Sekunden)": "Audio RX: el búfer del navegador se recorta cuando el retraso supera este valor (segundos)",
    "RX-Audio: so viel Rückstand bleibt nach dem Kürzen (Sekunden)": "Audio RX: este retraso permanece tras el recorte (segundos)",
    "Lautstärke des Mithörens, wenn ein anderer Client sendet (0 = aus)": "Volumen de escucha cuando otro cliente transmite (0 = off)",
    "Abstand in Minuten": "Intervalo en minutos",
    "Anmelden …": "Iniciando sesión …",
    "Mikrofonzugriff fehlgeschlagen": "Falló el acceso al micrófono",
    "auto connect": "conexión auto",
    "auto scroll": "desplazamiento auto",
    "Auto": "Auto",
    "Smooth": "Suavizado",
    "TCP port": "Puerto TCP",
    "VoIP UDP port": "Puerto UDP VoIP",
    "KNS User": "Usuario KNS",
    "VoIP Audio Input": "Entrada de audio VoIP",
    "VoIP Audio Output": "Salida de audio VoIP",
    "VoIP Jitter Buffer": "Búfer de jitter VoIP",
    "SPE Expert 1k5 COM port": "Puerto COM SPE Expert 1k5",
    "Filter": "Filtro",
    "NAME": "NOMBRE",
    "Level": "Nivel",
    "Type": "Tipo",
    "Depth": "Profundidad",
    "Width": "Anchura",
    "TX Monitor": "Monitor TX",
    "Input": "Entrada",
    "Output": "Salida",
    "Mode": "Modo",
    "Soft": "Suave",
    "Hard": "Duro",
    "TS890 VoIP reset": "Reinicio VoIP TS890",
    "Browser Mic Gain": "Ganancia mic navegador",
    "TX Mic Limiter": "Limitador mic TX",
    "Opus-Decode": "Decodificación Opus"
    },
  };
  // Texts with values in them: [regex on the German text, builder of the translation].
  const PATTERNS = {
    en: [
      [/^Klick oben\/unten oder Mausrad: ±(.+) Hz$/, (m, a) => `Click top/bottom or mouse wheel: ±${a} Hz`],
      [/^Klick oben\/unten: ±(.+) Hz$/, (m, a) => `Click top/bottom: ±${a} Hz`],
      [/^PA Leistungsstufe = (.+)$/, (m, a) => `PA power level = ${a}`],
      [/^Benutzer (.+) löschen\?$/, (m, a) => `Delete user ${a}?`],
      [/^(.+) gelöscht$/, (m, a) => `${a} deleted`],
      [/^Fehler (\d+)$/, (m, a) => `Error ${a}`],
      [/^(.+) – bitte (\d+) s warten$/, (m, a, b) => `${a} – please wait ${b} s`],
      [/^(.*\S)\s+\(Du\)$/, (m, a) => `${tr(a)}  (you)`],
      [/^Mikrofonzugriff fehlgeschlagen: (.*)$/, (m, a) => `Microphone access failed: ${a}`],
      [/^Aufnahme konnte nicht gestartet werden: (.*)$/, (m, a) => `Recording could not be started: ${a}`],
      [/^Mikrofon (\d+)$/, (m, a) => `Microphone ${a}`],
    ],
    it: [
      [/^Klick oben\/unten oder Mausrad: ±(.+) Hz$/, (m, a) => `Clic sopra/sotto o rotella del mouse: ±${a} Hz`],
      [/^Klick oben\/unten: ±(.+) Hz$/, (m, a) => `Clic sopra/sotto: ±${a} Hz`],
      [/^PA Leistungsstufe = (.+)$/, (m, a) => `Livello di potenza PA = ${a}`],
      [/^Benutzer (.+) löschen\?$/, (m, a) => `Eliminare l'utente ${a}?`],
      [/^(.+) gelöscht$/, (m, a) => `${a} eliminato`],
      [/^Fehler (\d+)$/, (m, a) => `Errore ${a}`],
      [/^(.+) – bitte (\d+) s warten$/, (m, a, b) => `${a} – attendere ${b} s`],
      [/^(.*\S)\s+\(Du\)$/, (m, a) => `${tr(a)}  (tu)`],
      [/^Mikrofonzugriff fehlgeschlagen: (.*)$/, (m, a) => `Accesso al microfono non riuscito: ${a}`],
      [/^Aufnahme konnte nicht gestartet werden: (.*)$/, (m, a) => `Impossibile avviare la registrazione: ${a}`],
      [/^Mikrofon (\d+)$/, (m, a) => `Microfono ${a}`],
    ],
    es: [
      [/^Klick oben\/unten oder Mausrad: ±(.+) Hz$/, (m, a) => `Clic arriba/abajo o rueda del ratón: ±${a} Hz`],
      [/^Klick oben\/unten: ±(.+) Hz$/, (m, a) => `Clic arriba/abajo: ±${a} Hz`],
      [/^PA Leistungsstufe = (.+)$/, (m, a) => `Nivel de potencia PA = ${a}`],
      [/^Benutzer (.+) löschen\?$/, (m, a) => `¿Eliminar al usuario ${a}?`],
      [/^(.+) gelöscht$/, (m, a) => `${a} eliminado`],
      [/^Fehler (\d+)$/, (m, a) => `Error ${a}`],
      [/^(.+) – bitte (\d+) s warten$/, (m, a, b) => `${a} – espere ${b} s`],
      [/^(.*\S)\s+\(Du\)$/, (m, a) => `${tr(a)}  (tú)`],
      [/^Mikrofonzugriff fehlgeschlagen: (.*)$/, (m, a) => `Falló el acceso al micrófono: ${a}`],
      [/^Aufnahme konnte nicht gestartet werden: (.*)$/, (m, a) => `No se pudo iniciar la grabación: ${a}`],
      [/^Mikrofon (\d+)$/, (m, a) => `Micrófono ${a}`],
    ],
  };

  // English by default; only an explicit choice (German, Italian) is remembered.
  let lang = "en";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "de" || saved === "it" || saved === "es") lang = saved;
  } catch (e) {}

  // Text in the current language for a German one (keeps leading/trailing
  // white space), or the input when there is no translation.
  function tr(de) {
    const key = de.trim();
    if (!key) return de;
    let out = DICT[lang][key];
    if (out === undefined) {
      for (const [re, fn] of PATTERNS[lang]) {
        const m = key.match(re);
        if (m) {
          out = fn(...m);
          break;
        }
      }
    }
    if (out === undefined) return de;
    return de.replace(key, () => out);
  }
  function t(de) {
    return lang === "de" ? de : tr(de);
  }

  const nodeRec = new WeakMap(); // Text node -> { de, en }: what we replaced
  const attrRec = new WeakMap(); // Element -> { attr: { de, en } }
  const ATTRS = ["title", "placeholder", "aria-label"];

  function doText(n) {
    const rec = nodeRec.get(n);
    if (rec && n.data === rec.en) {
      if (lang === "de") {
        n.data = rec.de;
        nodeRec.delete(n);
      }
      return;
    }
    nodeRec.delete(n); // changed by a script: a new German original
    if (lang === "de") return;
    const e = tr(n.data);
    if (e !== n.data) {
      nodeRec.set(n, { de: n.data, en: e });
      n.data = e;
    }
  }
  function doAttr(el, a) {
    const cur = el.getAttribute(a);
    if (cur === null) return;
    const recs = attrRec.get(el) || {};
    const rec = recs[a];
    if (rec && cur === rec.en) {
      if (lang === "de") {
        el.setAttribute(a, rec.de);
        delete recs[a];
      }
      return;
    }
    delete recs[a];
    if (lang === "de") return;
    const e = tr(cur);
    if (e !== cur) {
      recs[a] = { de: cur, en: e };
      attrRec.set(el, recs);
      el.setAttribute(a, e);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) {
      doText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) for (const a of ATTRS) doAttr(root, a);
    const tw = document.createTreeWalker(root, 5 /* text + element */);
    let n;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) {
        if (n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) continue;
        doText(n);
      } else for (const a of ATTRS) doAttr(n, a);
    }
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") doText(m.target);
      else if (m.type === "attributes") doAttr(m.target, m.attributeName);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  function observe(on) {
    observer.disconnect();
    if (on)
      observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS,
      });
  }

  function apply() {
    observer.disconnect();
    walk(document);
    document.documentElement.lang = lang;
    observe(lang !== "de");
  }
  function setLanguage(l) {
    // Back to the German originals first, so a switch between two translations
    // never starts from the other one's text.
    observer.disconnect();
    lang = "de";
    walk(document);
    lang = l === "en" || l === "it" || l === "es" ? l : "de";
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {}
    apply();
  }

  window.t = t;
  window.hamrcApplyI18n = apply;
  window.hamrcSetLanguage = setLanguage;
  window.hamrcGetLanguage = () => lang;
  // Translate right away (this script sits at the end of <body>, the markup is
  // already there, so English shows without a flash of German), and once more
  // when parsing is done.
  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
})();
