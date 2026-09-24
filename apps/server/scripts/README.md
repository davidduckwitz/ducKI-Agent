# Chatterbox TTS Server (lokaler Standard-Sprachausgabe-Provider)

`chatterbox_server.py` lädt Chatterbox' **Multilingual-V3-Modell** (Resemble AI, MIT-Lizenz,
[github.com/resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox)) einmalig und
stellt es über eine kleine lokale HTTP-Schnittstelle bereit, die
`packages/providers/src/chatterbox-text-to-speech-provider.ts` anspricht. Chatterbox ist der
neue Standard-TTS-Provider (siehe Settings → Speech → `DEFAULT_TEXT_TO_SPEECH_PROVIDER`).

**Wichtig:** es wird bewusst `ChatterboxMultilingualTTS` genutzt statt des Englisch-only-
Basismodells - letzteres produziert für nicht-englischen Text (z. B. Deutsch) hörbar schlechte
Prosodie/Aussprache, weil es nie darauf trainiert wurde. Das multilinguale Modell unterstützt 23
Sprachen explizit (siehe unten) und deckt Englisch weiterhin ab, es gibt also keinen Grund für
zwei Modell-Varianten. Der Node-Provider schickt die aktuelle Voice-Tab-Sprache (`ttsLanguage`,
z. B. "de-DE" → "de") automatisch mit; ohne Angabe nutzt der Server `CHATTERBOX_LANGUAGE`
(Default "en").

## Einrichtung

```bash
cd apps/server/scripts
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/Mac:
source .venv/bin/activate

python -m pip install -r requirements-chatterbox.txt
python chatterbox_server.py
```

`waitress` ist optional aber empfohlen (production-taugliche, mehrfädige WSGI-Serving statt
Flasks Entwicklungsserver) - ohne installiertes `waitress` fällt der Server automatisch auf
Flasks Dev-Server zurück (funktioniert, aber `/health` blockiert dann, während gerade eine
Sprachausgabe generiert wird).

Der Server läuft standardmäßig auf `http://127.0.0.1:8890` (konfigurierbar über
`CHATTERBOX_HOST`/`CHATTERBOX_PORT`, oder in den App-Settings über `CHATTERBOX_SERVER_URL`).

### Bekannter Stolperstein: `setuptools` zu neu

Chatterbox hängt (über `resemble-perth`, die Audio-Watermarking-Bibliothek) am veralteten
`pkg_resources`-Modul. Neuere `setuptools`-Versionen (ab ~81) haben `pkg_resources` entfernt -
Symptom ist ein Absturz beim Modell-Laden mit `TypeError: 'NoneType' object is not callable`
in `perth_watermarker.py`, weil `PerthImplicitWatermarker` dann stillschweigend `None` ist. Fix:

```bash
pip install "setuptools<81"
```

## Eigene Stimme(n) hinzufügen

Chatterbox hat keine benannten Presets ("männlich"/"weiblich"/etc.) - es klont per Zero-Shot
Voice-Cloning die Stimme aus einer kurzen Referenzaufnahme. So richtest du eine eigene Stimme ein:

1. Besorge dir eine **saubere WAV-Aufnahme einer einzelnen Stimme, 5-20 Sekunden**, möglichst
   ohne Hintergrundgeräusche/Musik (z. B. eine eigene Aufnahme, oder eine Aufnahme mit passenden
   Nutzungsrechten - Chatterbox selbst liefert keine Beispielstimmen mit).
2. Lege die Datei unter `apps/server/scripts/voices/<name>.wav` ab, z. B. `voices/emma.wav` für
   eine weibliche Stimme namens "emma".
3. Server neu starten (oder `python chatterbox_server.py` läuft bereits mit File-Discovery bei
   jedem `/voices`-Aufruf - kein Neustart nötig für neue Dateien).
4. In der App unter **Settings → Speech → Chatterbox** oder im Voice-Tab bei "Stimme" `emma`
   eintragen (die Dropdown-Vorschläge zeigen automatisch alle `.wav`-Dateien aus `voices/`).
   Leer lassen bzw. `default` = eingebaute Standardstimme.

`GET /voices` listet alle gefundenen Dateien; `POST /synthesize`/`/synthesize_stream` nehmen ein
`voice`-Feld mit dem Dateinamen (ohne `.wav`) entgegen.

## GPU vs. CPU

Chatterbox läuft spürbar schneller auf einer CUDA-fähigen GPU. Ohne GPU (`CHATTERBOX_DEVICE=cpu`)
funktioniert es weiterhin, ist aber langsamer - für reine CPU-Umgebungen kann stattdessen Piper
(lokal, leichtgewichtig, aber ohne Emotion-Regler) oder Breeze (Cloud, siehe Settings) als
Alternative gewählt werden.

## Stabilität & Geschwindigkeit

Der Server ist inzwischen auf Dauerbetrieb ausgelegt statt nur auf den Erstversuch:

- **Modell wird beim Start geladen**, nicht erst bei der ersten Anfrage - ein kaputtes Setup
  (fehlende Abhängigkeit, `pkg_resources`-Problem, o.ä.) schlägt sofort sichtbar im Terminal fehl,
  statt als verwirrendes Timeout beim ersten echten Request.
- **Warmup-Durchlauf** direkt nach dem Laden (ein kurzer Dummy-Satz) - die erste echte Anfrage
  eines Nutzers zahlt sonst zusätzlich den einmaligen JIT-/Allocator-Warmup-Preis und wäre
  spürbar langsamer als jede folgende. Abschaltbar über `CHATTERBOX_SKIP_WARMUP=1`.
- **Serialisierter Modellzugriff** (ein `threading.Lock` um jeden `generate()`-Aufruf) - parallele
  Anfragen (z. B. zwei offene Tabs) werden nacheinander abgearbeitet statt das Modell gleichzeitig
  von zwei Threads aus anzufassen (nicht als thread-sicher dokumentiert).
- **Saubere Fehlerantworten**: jeder Fehler bei der Synthese (z. B. Out-of-Memory, defekte
  Referenz-WAV) kommt als JSON-Fehler mit Statuscode zurück statt den Prozess hängen zu lassen
  oder eine unlesbare HTML-Fehlerseite zu liefern.
- **Echte Token-basierte Längenprüfung** statt einer geratenen Zeichen-Obergrenze: Chatterbox'
  T3-Modell unterstützt intern nur `hp.max_text_tokens` (2048) Text-Tokens - wird das
  überschritten, gibt es **keinen** sauberen Python-Fehler, sondern einen CUDA-Absturz
  ("device-side assertion", der den CUDA-Kontext des ganzen Prozesses beschädigen kann, nicht
  nur die eine Anfrage). Token-Dichte variiert stark je Sprache (gemessen ~1,4 Zeichen/Token für
  Deutsch, andere Sprachen z. B. CJK deutlich dichter), daher reicht ein fester
  Zeichen-Grenzwert nicht aus - der Server tokenisiert jetzt den tatsächlichen Text mit der
  echten Sprache und lehnt sauber mit HTTP 400 ab, bevor `generate()` überhaupt aufgerufen wird.
  `CHATTERBOX_MAX_TEXT_LEN` (Default 20000 Zeichen) ist nur noch ein billiger Vorfilter gegen
  pathologisch große Anfragen, nicht der eigentliche Schutzmechanismus.
- **`waitress` statt Flask-Dev-Server** (siehe oben) - `/health` und `/voices` bleiben responsiv,
  während gerade eine Sprachausgabe generiert wird.

### Automatischer Neustart bei Absturz

Der Server selbst startet sich nach einem Absturz (z. B. Out-of-Memory) nicht neu - das braucht
einen Prozess-Supervisor. Optionen für Dauerbetrieb statt eines manuellen Terminals:

- **pm2** (bereits im Node-Ökosystem verbreitet, funktioniert auch für Python-Prozesse):
  `pm2 start chatterbox_server.py --interpreter python --name chatterbox --restart-delay 3000`
- **Windows Service** über [NSSM](https://nssm.cc/) - registriert das Skript als Dienst mit
  automatischem Neustart und Start beim Booten.
- **systemd** (Linux) mit `Restart=on-failure`.

### Geschwindigkeit und Messwerte

Der Server hält bis zu zwei vorbereitete Referenzstimmen im Cache. Wiederholte Ausgaben mit
derselben Stimme sparen dadurch die Audio-Vorverarbeitung. Änderungen an der Referenzdatei
werden über Änderungszeit und Dateigröße erkannt. `CHATTERBOX_VOICE_CACHE_SIZE=0` deaktiviert
den Cache. Die Standardstimme profitiert davon nicht; ihr Zustand wird beim Zurückwechseln
von einer geklonten Stimme wiederhergestellt.

Der Browser übergibt Chatterbox vollständige Sätze oder Wortgruppen statt starrer
40-Zeichen-Fragmente. Die erste Gruppe bleibt kürzer als nachfolgende Gruppen. Das reduziert
unnötige Modellaufrufe, ersetzt aber kein echtes inkrementelles Generieren: Auch
`/synthesize_stream` beginnt erst nach der Synthese der jeweiligen Textgruppe.

`GET /health` liefert zusätzlich `busy`, `voiceCacheEntries` und `metrics`: Wartezeit vor dem
Modell, Synthesezeit, Audiolänge, Cache-Treffer und Echtzeitfaktor. Ein Echtzeitfaktor über 1
bedeutet, dass die Erzeugung länger dauert als das erzeugte Audio. Codeänderungen am
Python-Server werden erst nach dessen Neustart aktiv.

Ohne CUDA-GPU bleibt die reine Modell-Inferenzzeit bei mehreren Sekunden pro Satz - das ist
Eigenschaft des Modells, keine Server-Optimierung kann das wegoptimieren. Mit einer NVIDIA-GPU:
CUDA-Build von PyTorch installieren, passend zur Treiber-Version, z. B.:

```bash
pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu124
```

(`--force-reinstall` nötig, falls bereits eine CPU-only-`torch`-Version installiert ist - pip
erkennt sonst nicht, dass ein anderer Build gebraucht wird.) `CHATTERBOX_DEVICE=cuda` erzwingt
GPU-Nutzung explizit; ohne die Variable wird CUDA automatisch genutzt, falls verfügbar.

**Gemessener VRAM-Bedarf** (RTX 3060, fp32): ca. 3,2 GB nach dem Laden, ca. 3,5 GB Peak während
der Generierung. Für Setups, die die GPU auch für ein lokales LLM brauchen, ist das ein kleiner
Anteil des Kartenspeichers. Entscheidend ist jedoch die Gesamtbelegung durch alle Prozesse;
ein gleichzeitig laufendes LLM kann den verbleibenden Speicher stark reduzieren. Ein Test mit
`torch.autocast(..., dtype=torch.float16)` um `generate()` herum hat den Speicherbedarf sogar
**erhöht** (zusätzliche Cast-Buffer statt kleinerer Gewichte, da Chatterbox keinen offiziellen
Halbpräzisions-Gewichtspfad hat) - nicht empfohlen. Wenn die GPU wirklich komplett dem LLM
gehören soll, `CHATTERBOX_DEVICE=cpu` setzen (bleibt dann bei mehreren Sekunden pro Satz) oder
auf Piper/Breeze ausweichen (siehe unten).

Ist Chatterbox' Latenz für Echtzeit-Gespräche trotz GPU zu hoch, können die bereits integrierten
Provider Piper oder Breeze in Settings → Speech vergleichend getestet werden. Deren tatsächliche
Latenz hängt ebenfalls von Hardware, Modell und gegebenenfalls Netzwerk ab.

## Unterstützte Sprachen

Arabisch, Chinesisch, Dänisch, Deutsch, Englisch, Finnisch, Französisch, Griechisch, Hebräisch,
Hindi, Italienisch, Japanisch, Koreanisch, Malaiisch, Niederländisch, Norwegisch, Polnisch,
Portugiesisch, Russisch, Schwedisch, Spanisch, Suaheli, Türkisch (Codes: siehe
`chatterbox.mtl_tts.SUPPORTED_LANGUAGES`). Ein unbekannter Sprachcode liefert einen 400-Fehler
mit der vollständigen Liste.

## Endpunkte

- `GET /health` - Health-Check mit Gerät, Modellzustand, Auslastung und Synthesemesswerten
- `GET /voices` - verfügbare Stimmen
- `POST /synthesize` - `{text, voice?, language?, emotion_exaggeration?}` → WAV-Audio
- `POST /synthesize_stream` - wie oben, aber gechunkte PCM-Antwort (siehe Docstring im Skript)


## Versionsprüfung und Verwaltung (23.09.2026)

Ducki verwendet verbindlich **Chatterbox Multilingual V3** aus dem offiziellen
[Upstream-Repository](https://github.com/resemble-ai/chatterbox), gepinnt auf
Commit `5de7a54aa4e5e2baadb0182dde554908b48b85c2` in
`requirements-chatterbox.txt`. Die Paketnummer lautet weiterhin `0.1.7`;
die gleichnamige PyPI-Veröffentlichung enthält noch keine V3-Auswahl.
Der Server übergibt deshalb ausdrücklich `t3_model="v3"` und verweigert
alte Installationen sowie `CHATTERBOX_MODEL=v2` oder `auto`.

Die lokale Laufzeit liegt in `apps/server/scripts/.venv`. Sie wurde mit
`--system-site-packages` angelegt, um das vorhandene CUDA-Torch `2.6.0+cu124`
und die passenden Abhängigkeiten weiterzuverwenden. Der Chatterbox-Quellstand
ist direkt in dieser Umgebung installiert; die globale Installation bleibt
unverändert. Paketrevision und Modellvariante stehen getrennt in `/health`
und der Settings UI. `python -m pip check` prüft die Abhängigkeiten.

Für eine neue Installation die Einrichtung oben verwenden. Bei einer Umgebung,
die bereits die PyPI-Version 0.1.7 enthält, den gepinnten Quellstand ausdrücklich
erneuern (gleiche Versionsnummer):

```powershell
# Aus apps/server/scripts; bestehende kompatible Abhängigkeiten werden behalten.
.venv/Scripts/python.exe -m pip install --force-reinstall --no-deps "chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@5de7a54aa4e5e2baadb0182dde554908b48b85c2"
.venv/Scripts/python.exe -m pip check
```

Die V3-Gewichte werden beim ersten Laden von `ResembleAI/chatterbox` auf
Hugging Face heruntergeladen und anschließend im Hugging-Face-Cache wiederverwendet.

Unter **Settings → Speech** und **Settings → Voice** gibt es Server starten/stoppen,
Modell laden/entladen und den persistenten Schalter `CHATTERBOX_AUTO_START`
(Standard: an). Beim Backend-Start und beim Aktivieren wird automatisch gestartet,
wenn der serverseitige TTS-Provider Chatterbox ist. Manuelles Entladen bleibt erhalten:
Synthese liefert dann HTTP 409, bis das Modell erneut geladen wird. Das Entladen
löscht auch Referenzstimmen-Caches und gibt ungenutzten CUDA-Cache frei.

Der Prozessmanager verwendet `CHATTERBOX_PYTHON`, andernfalls die `.venv` neben
dem Skript, andernfalls `python` aus PATH. Er startet ohne sichtbares Konsolenfenster
und beendet eigene Prozesse beim Backend-Shutdown. Extern gestartete Prozesse
werden nicht beendet: einmal im ursprünglichen Terminal stoppen, danach aus der
UI starten. Bereits laufende alte Python-Server müssen für die neuen Endpunkte
neu gestartet werden. Lokale Steuerung unterstützt HTTP auf `localhost` oder
`127.0.0.1`; entfernte TTS-Server bleiben über den Provider verwendbar.

Zusätzliche Python-Endpunkte: `POST /model/load`, `POST /model/unload`.
Konkurrierende Modelloperationen werden mit HTTP 409 abgelehnt; Health-Abfragen
bleiben während des Ladens erreichbar. Der verwaltete Start nutzt
`CHATTERBOX_LAZY_LOAD=1`, startet zuerst HTTP und lädt anschließend über die API.

### Leistung

Bei der Prüfung waren auf der RTX 3060 **11548 von 12288 MiB VRAM belegt**.
Die bestehenden Logs zeigen unter anderem RTF 7,21 und 13,99 sowie einen extremen
Ausreißer. GPU-Speicherdruck durch gleichzeitig geladene Modelle ist deshalb ein
plausibler Engpass, aber noch kein durch einen Vergleichstest bewiesener Befund.
Für einen belastbaren Vergleich dasselbe deutsche Beispiel nach Warmup mehrmals
mit freiem VRAM und mit gleichzeitig geladenem LLM messen. Die UI zeigt die letzte
RTF (Rechenzeit / Audiodauer; kleiner ist besser). Es wird kein gemessener Speedup
für diese Änderung behauptet.

CUDA-Erkennung, persistente Gewichte und Referenzstimmen-Cache waren bereits
vorhanden. Warmup nutzt jetzt ebenfalls `torch.inference_mode()`. Turbo (350M) und
Nano (110M) sind laut Upstream schneller beziehungsweise kleiner, unterstützen
aber Englisch; sie ersetzen das deutsche Multilingual-Modell nicht. V3 ist eine
Qualitätsaktualisierung, keine belegte Beschleunigung dieses Setups.


### Verifizierter V3-Betrieb

Der echte GPU-Test am 23.09.2026 erzeugte für
„Hallo! Ducki spricht jetzt mit Chatterbox Version drei.“ eine WAV-Datei mit
24 kHz, einem Kanal und 3,68 Sekunden Dauer. Die Generierung benötigte
5,765 Sekunden (RTF 1,57). Das ist ein einzelner Funktionstest, kein kontrollierter
Geschwindigkeitsvergleich mit V2. Die Testdatei liegt lokal unter
`verification/chatterbox-v3-de.wav` (nicht versioniert).

Entladen senkte die gesamte GPU-Belegung in diesem Test von 5071 auf 1761 MiB.
Die Serververwaltung beendet unter Windows auch den Interpreter-Unterprozess
des venv-Launchers. Der Lebenszyklus wurde über die Ducki-API geprüft:
Modell entladen → Server stoppen (HTTP-Port geschlossen) → Server starten → V3 laden.
