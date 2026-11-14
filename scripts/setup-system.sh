#!/usr/bin/env bash
#
# Einmalige Systemvorbereitung für pcctl.
#
# Richtet ein:
#   - ddcutil   (Monitorsteuerung über DDC/CI)
#   - OpenRGB   (Beleuchtung des Mainboards)
#   - i2c-Zugriff ohne root
#   - ydotoold  (Tastatureingaben unter Wayland)
#   - Firewall-Freigabe für das lokale Subnetz
#   - JDK 21    (für den Android-Build; System-Java bleibt unangetastet)
#
# Nach dem Lauf ist ein Neustart nötig, weil der Kernel-Parameter
# acpi_enforce_resources=lax erst beim Booten greift.

set -euo pipefail

BLUE=$'\e[34m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'

step()  { echo "${BLUE}▸${RESET} $*"; }
ok()    { echo "  ${GREEN}✓${RESET} $*"; }
warn()  { echo "  ${YELLOW}!${RESET} $*"; }
fail()  { echo "  ${RED}✗${RESET} $*"; }

if [[ $EUID -eq 0 ]]; then
  fail "Bitte ohne sudo starten – das Skript fragt selbst nach Rechten."
  exit 1
fi

TARGET_USER="$USER"
NEEDS_REBOOT=0

echo
echo "pcctl – Systemvorbereitung"
echo "=========================="
echo

# ---------------------------------------------------------------- Pakete

step "Pakete installieren"
PACKAGES=(ddcutil i2c-tools ydotool java-21-openjdk-devel)

# OpenRGB liegt bei Fedora in den Standard-Quellen; falls nicht, wird es übersprungen.
if dnf list --available openrgb &>/dev/null || dnf list --installed openrgb &>/dev/null; then
  PACKAGES+=(openrgb)
else
  warn "openrgb nicht in den Paketquellen – RGB-Steuerung bitte per Flatpak nachrüsten"
fi

sudo dnf install -y "${PACKAGES[@]}"
ok "Pakete installiert: ${PACKAGES[*]}"

# ---------------------------------------------------------------- SMBus für RGB

step "SMBus-Zugriff für die Mainboard-Beleuchtung"

# Ohne diesen Parameter blendet ACPI den SMBus-Adapter aus. Auf diesem System
# wurde geprüft: /sys/bus/i2c/devices/ zeigt ausschließlich AMDGPU-Busse,
# der Adapter des Chipsatzes fehlt vollständig.
if grep -q "acpi_enforce_resources=lax" /proc/cmdline; then
  ok "acpi_enforce_resources=lax ist bereits aktiv"
else
  warn "Setze acpi_enforce_resources=lax – lockert eine ACPI-Schutzsperre für den SMBus."
  warn "Rückgängig mit: sudo grubby --update-kernel=ALL --remove-args=acpi_enforce_resources"
  sudo grubby --update-kernel=ALL --args="acpi_enforce_resources=lax"
  NEEDS_REBOOT=1
  ok "Kernel-Parameter gesetzt (wirkt nach dem Neustart)"
fi

# i2c-dev dauerhaft laden
if [[ ! -f /etc/modules-load.d/pcctl-i2c.conf ]]; then
  echo "i2c-dev" | sudo tee /etc/modules-load.d/pcctl-i2c.conf >/dev/null
  ok "i2c-dev wird künftig automatisch geladen"
else
  ok "i2c-dev ist bereits eingetragen"
fi
sudo modprobe i2c-dev 2>/dev/null || true

# ---------------------------------------------------------------- i2c-Rechte

step "Zugriff auf die I2C-Busse ohne root"

if ! getent group i2c >/dev/null; then
  sudo groupadd --system i2c
  ok "Gruppe i2c angelegt"
fi

if id -nG "$TARGET_USER" | grep -qw i2c; then
  ok "$TARGET_USER ist bereits in der Gruppe i2c"
else
  sudo usermod -aG i2c "$TARGET_USER"
  ok "$TARGET_USER zur Gruppe i2c hinzugefügt (wirkt nach erneuter Anmeldung)"
  NEEDS_REBOOT=1
fi

sudo tee /etc/udev/rules.d/60-pcctl-i2c.rules >/dev/null <<'EOF'
# I2C-Geräte für die Gruppe i2c beschreibbar machen (ddcutil, OpenRGB)
KERNEL=="i2c-[0-9]*", GROUP="i2c", MODE="0660"
EOF
ok "udev-Regel für I2C geschrieben"

# ---------------------------------------------------------------- ydotool

step "ydotoold einrichten"

# ydotool erzeugt Eingaben über /dev/uinput. Der Dienst läuft als Benutzer,
# braucht dafür aber Schreibrechte auf das Gerät.
sudo tee /etc/udev/rules.d/60-pcctl-uinput.rules >/dev/null <<'EOF'
# uinput für die Gruppe input beschreibbar machen (ydotool)
KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
EOF
ok "udev-Regel für uinput geschrieben"

if ! getent group input >/dev/null; then
  sudo groupadd --system input
fi

if id -nG "$TARGET_USER" | grep -qw input; then
  ok "$TARGET_USER ist bereits in der Gruppe input"
else
  sudo usermod -aG input "$TARGET_USER"
  ok "$TARGET_USER zur Gruppe input hinzugefügt"
  NEEDS_REBOOT=1
fi

# ---------------------------------------------------------------- Firewall

step "Firewall-Freigabe"

SUBNET="$(ip -4 -o addr show scope global | awk '{print $4}' | head -1)"
if [[ -z "$SUBNET" ]]; then
  warn "Kein Subnetz erkannt – Freigabe bitte von Hand einrichten"
else
  # Auf das eigene Netz einschränken statt den Port allgemein zu öffnen.
  NETWORK="$(python3 -c "import ipaddress,sys; print(ipaddress.ip_network('$SUBNET', strict=False))")"
  ZONE="$(sudo firewall-cmd --get-default-zone)"
  RULE="rule family=ipv4 source address=$NETWORK port port=8765 protocol=tcp accept"

  if sudo firewall-cmd --zone="$ZONE" --query-rich-rule="$RULE" &>/dev/null; then
    ok "Freigabe für $NETWORK besteht bereits"
  else
    sudo firewall-cmd --permanent --zone="$ZONE" --add-rich-rule="$RULE" >/dev/null
    sudo firewall-cmd --reload >/dev/null
    ok "Port 8765 für $NETWORK in Zone $ZONE freigegeben"
  fi
fi

# ---------------------------------------------------------------- udev neu laden

sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=i2c-dev 2>/dev/null || true
ok "udev-Regeln neu geladen"

# ---------------------------------------------------------------- Abschluss

echo
echo "=========================="
if [[ $NEEDS_REBOOT -eq 1 ]]; then
  echo "${YELLOW}Ein Neustart ist nötig${RESET}, damit Kernel-Parameter und"
  echo "Gruppenmitgliedschaften wirksam werden."
  echo
  echo "Danach prüfen:"
  echo "  ls /sys/bus/i2c/devices/ | grep -i smbus   # SMBus muss auftauchen"
  echo "  ddcutil detect                             # Monitore, ohne sudo"
  echo "  openrgb --list-devices                     # Mainboard-Controller"
else
  echo "${GREEN}Systemvorbereitung abgeschlossen.${RESET}"
fi
echo
