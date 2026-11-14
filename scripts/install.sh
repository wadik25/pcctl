#!/usr/bin/env bash
#
# Installiert den pcctl-Agent als Benutzerdienst.
# Braucht keine root-Rechte – die Systemvorbereitung erledigt setup-system.sh.

set -euo pipefail

BLUE=$'\e[34m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
step() { echo "${BLUE}▸${RESET} $*"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo
echo "pcctl – Installation"
echo "===================="
echo

# ---------------------------------------------------------------- Abhängigkeiten

step "Node-Pakete"
(cd "$ROOT/agent" && npm install --silent)
ok "Agent-Pakete aktuell"

if [[ ! -f "$HOME/.config/pcctl/whitelist.json" ]]; then
  mkdir -p "$HOME/.config/pcctl"
  cp "$ROOT/agent/config/whitelist.example.json" "$HOME/.config/pcctl/whitelist.json"
  chmod 600 "$HOME/.config/pcctl/whitelist.json"
  ok "Leere WhatsApp-Whitelist angelegt"
fi

# ---------------------------------------------------------------- GNOME-Extension

step "GNOME-Extension"
for uuid in pcctl-bridge@wadik pcctl-taskbar@wadik; do
  EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$uuid"
  mkdir -p "$(dirname "$EXT_DIR")"
  cp -r "$ROOT/gnome-extension/$uuid/." "$EXT_DIR/"
  ok "Nach $EXT_DIR kopiert"

  CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
  if echo "$CURRENT" | grep -q "$uuid"; then
    ok "$uuid bereits in den GNOME-Einstellungen eingetragen"
  else
    UPDATED="$(python3 -c "
import ast
entries = ast.literal_eval('''$CURRENT''')
entries.append('$uuid')
print(str(entries))
")"
    gsettings set org.gnome.shell enabled-extensions "$UPDATED"
    ok "$uuid in den GNOME-Einstellungen eingetragen"
    warn "Wird erst nach dem nächsten Abmelden aktiv"
  fi
done

# ---------------------------------------------------------------- Dienst

step "Benutzerdienst"
mkdir -p "$HOME/.config/systemd/user"
sed "s|%h|$HOME|g" "$ROOT/systemd/pcctl-agent.service" > "$HOME/.config/systemd/user/pcctl-agent.service"
cp "$ROOT/systemd/ydotoold.service" "$HOME/.config/systemd/user/ydotoold.service"
systemctl --user daemon-reload
systemctl --user enable pcctl-agent.service ydotoold.service >/dev/null 2>&1
ok "Dienste eingerichtet"

# Damit der Agent auch ohne offene Sitzung erreichbar bleibt.
if loginctl show-user "$USER" --property=Linger | grep -q "yes"; then
  ok "Linger ist bereits aktiv"
else
  loginctl enable-linger "$USER" 2>/dev/null && ok "Linger aktiviert" || warn "Linger konnte nicht aktiviert werden"
fi

step "Desktop-App"
if command -v cargo >/dev/null && [[ -f "$ROOT/desktop/package.json" ]]; then
  (cd "$ROOT/desktop" && npm install --silent)
  if (cd "$ROOT/desktop" && npx tauri build --bundles deb); then
    BIN="$ROOT/desktop/src-tauri/target/release/pcctl-desktop"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/128x128/apps"
    ln -sfn "$BIN" "$HOME/.local/bin/pcctl-desktop"
    sed "s|^Exec=.*|Exec=$HOME/.local/bin/pcctl-desktop|" "$ROOT/desktop/pcctl-desktop.desktop" \
      > "$HOME/.local/share/applications/pcctl-desktop.desktop"
    cp "$ROOT/desktop/src-tauri/icons/128x128.png" "$HOME/.local/share/icons/hicolor/128x128/apps/pcctl.png"
    ok "pcctl-desktop installiert"
  else
    warn "Desktop-Build fehlgeschlagen – später: cd ~/Projekte/pcctl/desktop && npx tauri build"
  fi
else
  warn "Rust/Cargo fehlt – Desktop-App übersprungen"
fi

systemctl --user restart ydotoold.service pcctl-agent.service
sleep 2

if systemctl --user is-active --quiet pcctl-agent.service; then
  ok "Dienst läuft"
else
  warn "Dienst startet nicht – Protokoll: journalctl --user -u pcctl-agent -n 30"
  exit 1
fi
if systemctl --user is-active --quiet ydotoold.service; then
  ok "ydotoold läuft"
else
  warn "ydotoold startet nicht – Tastatureingabe in den Editor ist dann nicht möglich"
fi

# ---------------------------------------------------------------- Zugangsdaten

CONFIG="$HOME/.config/pcctl/config.json"
TOKEN="$(python3 -c "import json;print(json.load(open('$CONFIG'))['token'])")"
PORT="$(python3 -c "import json;print(json.load(open('$CONFIG')).get('port',8765))")"
LAN_IP="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)"

echo
echo "===================="
echo "${GREEN}Installation abgeschlossen.${RESET}"
echo
echo "  Adresse:  http://$LAN_IP:$PORT"
echo "  Token:    $TOKEN"
echo
echo "Diese beiden Angaben in der Android-App eintragen."
echo
echo "WhatsApp: Desktop-App öffnen oder"
echo "  curl -s -H \"Authorization: Bearer $TOKEN\" http://127.0.0.1:$PORT/api/whatsapp/qr"
echo "Whitelist der Chats: ~/.config/pcctl/whitelist.json"
echo

# QR-Code, falls qrencode vorhanden ist – spart das Abtippen des Tokens.
if command -v qrencode >/dev/null; then
  echo "Oder in der App abscannen:"
  echo "pcctl://$LAN_IP:$PORT?token=$TOKEN" | qrencode -t ANSIUTF8
else
  echo "Tipp: 'sudo dnf install qrencode' zeigt hier einen QR-Code zum Abscannen."
fi
echo
