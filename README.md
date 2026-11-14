# pcctl

Fernsteuerung für den Fedora-Desktop vom Android-Handy: Kennzahlen ablesen,
Monitore verdunkeln, Beleuchtung schalten, Mikrofon stummschalten, Programme
beenden, Szenen ausführen, Claude-Code-Sitzungen bedienen — und WhatsApp-
Nachrichten (Text und Sprache) in knappe Aufgaben verwandeln.

```
Android-App + Glance-Widgets        PC: pcctl-agent (systemd --user)
┌───────────────────────┐  HTTP     ┌──────────────────────────────┐
│ Aufgaben, Work-Mode   │◄─────────►│ Fastify + WebSocket :8765    │
│ Fernsteuerung         │  WS       │ Baileys · Whisper · Kimi-K3  │
└───────────────────────┘           └───────┬──────────────────────┘
                                            │
                 ┌──────────────────────────┼──────────────────────┐
                 │ D-Bus                    │ HTTP/WS 127.0.0.1    │
         ┌───────▼────────┐         ┌───────▼────────┐   ┌─────────▼────────┐
         │ pcctl-bridge   │         │ pcctl-taskbar  │   │ Tauri-Desktop    │
         │ Fensterliste   │         │ Timer + Inbox  │   │ Aufgaben-Inbox   │
         └────────────────┘         └────────────────┘   └──────────────────┘
```

## Über das Projekt

pcctl ist mein privates Projekt: Ich wollte meinen Linux-PC (Fedora, GNOME unter
Wayland) vom Handy aus steuern und eingehende Nachrichten automatisch in Aufgaben
verwandeln. Entwickelt habe ich es KI-gestützt. Ich plane Architektur und
Funktionen, steuere KI-Agenten wie Claude Code, prüfe den Code und teste alles auf
dem echten System.

| Teil | Technik |
|---|---|
| Agent auf dem PC | Node.js 24, TypeScript, Fastify, WebSocket, systemd-Benutzerdienst |
| KI | Whisper über Groq (Sprache zu Text), Kimi-K3 über NVIDIA (Nachricht zu Aufgabe) |
| Handy | Android, Kotlin, Jetpack Compose, Glance-Widgets |
| Desktop | Tauri v2 (Rust), Svelte 5 |
| GNOME | zwei Shell-Erweiterungen: Fensterliste über D-Bus, Timer und Inbox in der Leiste |
| System | ddcutil (Monitore über DDC/CI), OpenRGB, ydotool, Wake-on-LAN |

**Spannende Stellen**

- **Tippen unter Wayland:** Der Agent tippt nur, wenn die GNOME-Erweiterung meldet,
  dass ein Editor den Fokus hat. Sonst bricht er ab.
- **Monitore verdunkeln über DDC/CI:** Die Helligkeit wird je Monitor gemerkt und
  zuverlässig wiederhergestellt.
- **KI-Aufgaben-Inbox:** Text- und Sprachnachrichten freigegebener Chats werden zu
  knappen Aufgaben. Smalltalk erzeugt keine Aufgabe, verpasste Nachrichten werden
  nachgeholt.
- **Claude Code vom Handy:** Aufgaben starten, Sitzungen mitlesen und
  Genehmigungen beantworten.
- **Zugriffsschutz:** Bearer-Token, nur erlaubte Netze, geschützte Prozesse,
  Bestätigung vor dem Herunterfahren.

## Einrichtung

### 1. System vorbereiten (einmalig, mit sudo)

```bash
bash ~/Projekte/pcctl/scripts/setup-system.sh
sudo reboot
```

Installiert `ddcutil`, `openrgb`, `ydotool`, richtet die I2C- und uinput-Rechte
ein, gibt Port 8765 für das lokale Subnetz frei und setzt den Kernel-Parameter
`acpi_enforce_resources=lax`.

**Warum der Kernel-Parameter:** Ohne ihn blendet ACPI den SMBus-Adapter des
Chipsatzes aus — auf diesem Rechner zeigt `/sys/bus/i2c/devices/` ausschließlich
AMDGPU-Busse. OpenRGB findet das Mainboard dann schlicht nicht. Bei
Gigabyte-Boards ist das der übliche Weg; rückgängig mit
`sudo grubby --update-kernel=ALL --remove-args=acpi_enforce_resources`.

### 2. Agent installieren

```bash
bash ~/Projekte/pcctl/scripts/install.sh
```

Richtet den Benutzerdienst ein, kopiert die GNOME-Extension und zeigt am Ende
**Adresse und Token** für die App an.

Danach einmal **abmelden und wieder anmelden** — unter Wayland lädt GNOME neue
Extensions erst beim Start der Shell.

### 3. App aufs Handy

```bash
cd ~/Projekte/pcctl/android
ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

In der App unter *Einstellungen* Adresse und Token eintragen. Widgets werden
wie gewohnt über langes Drücken auf den Startbildschirm gelegt.

### 4. Genehmigungen aufs Handy (optional)

In `~/.claude/settings.json` ergänzen:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          { "type": "command", "command": "node $HOME/Projekte/pcctl/scripts/approval-hook.mjs" }
        ]
      }
    ]
  }
}
```

Fragt Claude Code nach einer Erlaubnis, erscheint sie in der App mit
Ja/Nein-Knöpfen. Antwortet niemand, wird nach 90 Sekunden ganz normal im
Terminal gefragt — der Hook kann nie etwas ungefragt zulassen.

## Bedienung

| Bereich | Funktionen |
|---|---|
| Übersicht | CPU/GPU-Temperatur und -Last, Arbeitsspeicher, Laufzeit; Szenen; Schnellzugriff; Medientasten |
| Aufgaben | KI-Inbox aus WhatsApp, Swipe erledigen/verschieben, Work-Mode (DND am Handy) |
| Programme | Offene Fenster bzw. Prozesse, einzeln beendbar; geschützte Prozesse sind gesperrt |
| Claude | Aufgabe starten, Sitzung mitlesen, Genehmigungen beantworten, in den Editor tippen |
| Einstellungen | Verbindung, Funktionsübersicht |

### Monitore verdunkeln

Zwei Betriebsarten, umstellbar über `displayBlankMode` in
`~/.config/pcctl/config.json`:

- **`brightness`** (Standard) — Helligkeit auf 0. Der Monitor bleibt elektrisch
  an und über I2C erreichbar, das Zurückschalten ist damit garantiert. Die
  vorherige Helligkeit wird je Monitor gespeichert und wiederhergestellt.
- **`standby`** — echter DDC-Standby (VCP D6). Spart mehr Strom, aber manche
  Monitore schalten dabei den I2C-Kanal ab und nehmen den Einschaltbefehl nicht
  mehr an. Vor dem Umstellen mit `ddcutil capabilities` prüfen.

In beiden Fällen wird weder gesperrt noch der Ruhezustand ausgelöst — der
Rechner arbeitet normal weiter. „Monitore an" ist eine eigene Aktion mit
eigenem Widget-Knopf.

### Szenen

Frei anpassbar in `~/.config/pcctl/scenes.json`. Ein fehlgeschlagener Schritt
bricht die Kette nicht ab; jeder Schritt wird einzeln zurückgemeldet.

Verfügbare Schritte: `mic`, `micToggle`, `outputMute`, `volume`, `display`,
`brightness`, `rgb`, `media`, `lock`, `schedule`, `wait`.

### Wake-on-LAN

Der Sendeweg ist eingebaut, aber **auf diesem Rechner derzeit wirkungslos**:
`eno1` hat kein Kabel (`carrier=0`), die Verbindung läuft über WLAN. Über WLAN
funktioniert WoL praktisch nicht. Mit gestecktem Kabel zusätzlich nötig: WoL im
BIOS aktivieren und `ethtool -s eno1 wol g` dauerhaft setzen.

### In den Editor tippen

Der fragilste Teil, bewusst als letzter Ausweg gebaut. Unter Wayland lässt sich
Text nicht gezielt an ein Fenster schicken — `ydotool` erzeugt Eingaben auf
Kernel-Ebene, die immer im fokussierten Fenster landen. Deshalb fragt der Agent
zuerst die GNOME-Extension, welches Fenster den Fokus hat, und tippt **nur**,
wenn es ein Editor ist. Sonst bricht er ab und meldet das zurück.

Für neue Aufgaben ist der Weg über *Aufgabe starten* (`claude -p` als eigener
Prozess) deutlich zuverlässiger.

## WhatsApp-Aufgaben

Der Agent liest nur Chats aus `~/.config/pcctl/whitelist.json`. Nach dem ersten
Start erscheint ein QR-Code in der Desktop-App (Seite *WhatsApp*) bzw. unter
`GET /api/whatsapp/qr`. Mit dem Handy scannen: WhatsApp → Verknüpfte Geräte.
Nachrichten, die ankommen während der PC aus oder der Agent offline ist, werden
beim nächsten Verbinden nachgeholt (letzte 14 Tage) und dann ganz normal durch
den Aufgaben-Flow geschickt.

Sprachnachrichten werden lokal nach WAV gewandelt und an Groq Whisper
(`whisper-large-v3-turbo`) geschickt. Die Auswertung macht Kimi-K3 über NVIDIA.
Smalltalk erzeugt **keine** Aufgabe und **keine** Benachrichtigung.

API-Keys liegen ausschließlich in `~/.config/pcctl/config.json` (Modus 0600):
`nvidiaApiKey`, `groqApiKey`. `llmReasoningEffort` steht auf `low`,
`llmTimeoutMs` auf 45000.

Work-Mode schaltet GNOME-Banner aus (`show-banners false`) und am Handy
„Nicht stören“, sobald die App die entsprechende Berechtigung hat.

## Sicherheit

- Bearer-Token, beim ersten Start erzeugt, in `~/.config/pcctl/config.json` (0600)
- Zugriff nur aus den Netzen in `allowedNetworks` — greift auch, wenn die
  Firewall umgangen wurde
- Firewall-Freigabe nur für das eigene Subnetz, nicht für die ganze Zone
- Geschützte Prozesse (`protectedProcesses`) lassen sich nicht beenden, damit
  sich der Desktop nicht selbst abschießt
- Herunterfahren und Neustart verlangen in der App eine Bestätigung

Der Agent ist **nicht** für den Betrieb im offenen Internet gedacht. Für Zugriff
von unterwegs ist Tailscale der richtige Weg, keine Portweiterleitung.

## Aufbau

```
agent/                 Node 24 + TypeScript (läuft ohne Übersetzungsschritt)
  src/server.ts        HTTP + WebSocket, Zugriffsschutz
  src/modules/         power display rgb audio apps stats scenes wol gnome
  src/modules/claude/  sessions (Mitlesen) · runner (Aufgaben) · input · approvals
  src/modules/tasks/   WhatsApp, Whisper, Kimi-K3, Inbox, Timer, Work-Mode
desktop/               Tauri v2 + Svelte 5
gnome-extension/       pcctl-bridge@wadik · pcctl-taskbar@wadik
android/               Kotlin, Compose, Glance-Widgets
scripts/               setup-system.sh · install.sh · approval-hook.mjs
```

## Fehlersuche

```bash
systemctl --user status pcctl-agent
journalctl --user -u pcctl-agent -f

# Voraussetzungen prüfen
ls /sys/bus/i2c/devices/ | grep -i smbus   # muss nach dem Neustart erscheinen
ddcutil detect                              # Monitore, ohne sudo
openrgb --list-devices                      # Mainboard-Controller
gdbus call --session --dest org.gnome.Shell \
  --object-path /org/pcctl/Bridge --method org.pcctl.Bridge.Ping
```

Zeigt die App „nicht erreichbar“: gleiches WLAN? Dienst aktiv? Firewall-Regel
gesetzt (`setup-system.sh`)?
