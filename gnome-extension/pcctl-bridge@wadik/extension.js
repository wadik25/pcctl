import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * pcctl Bridge
 *
 * Unter Wayland kann kein Hintergrundprozess das fokussierte Fenster oder die
 * Fensterliste abfragen – org.gnome.Shell.Eval ist seit GNOME 41 gesperrt.
 * Diese Extension stellt genau die dafür nötigen Informationen über ein
 * eigenes D-Bus-Interface bereit.
 *
 * Bewusst eng gehalten: lesen, schließen, aktivieren. Kein Ausführen von Code,
 * keine Tastatureingaben, keine Rückgabe von Fensterinhalten.
 */

const DBUS_INTERFACE = `
<node>
  <interface name="org.pcctl.Bridge">
    <method name="Ping">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="ListWindows">
      <arg type="s" direction="out" name="windows"/>
    </method>
    <method name="GetFocusedWindow">
      <arg type="s" direction="out" name="window"/>
    </method>
    <method name="CloseWindow">
      <arg type="u" direction="in" name="id"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="ActivateWindow">
      <arg type="u" direction="in" name="id"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

/** Wandelt ein Meta.Window in eine schlanke, serialisierbare Form um. */
function describeWindow(window) {
  return {
    id: window.get_id(),
    pid: window.get_pid(),
    wmClass: window.get_wm_class() || '',
    title: window.get_title() || '',
    focused: window.has_focus(),
    minimized: window.minimized,
    workspace: window.get_workspace()?.index() ?? -1,
  };
}

/** Nur normale Anwendungsfenster – keine Docks, Menüs oder Overlays. */
function isApplicationWindow(window) {
  return window.get_window_type() === Meta.WindowType.NORMAL;
}

function findWindowById(id) {
  const actors = global.get_window_actors();
  for (const actor of actors) {
    const window = actor.meta_window;
    if (window && window.get_id() === id) return window;
  }
  return null;
}

class BridgeService {
  constructor() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this);
  }

  export() {
    this._dbus.export(Gio.DBus.session, '/org/pcctl/Bridge');
  }

  unexport() {
    this._dbus.unexport();
  }

  Ping() {
    return JSON.stringify({ ok: true, version: 1 });
  }

  ListWindows() {
    const windows = global
      .get_window_actors()
      .map((actor) => actor.meta_window)
      .filter((window) => window && isApplicationWindow(window))
      .map(describeWindow);
    return JSON.stringify(windows);
  }

  GetFocusedWindow() {
    const window = global.display.focus_window;
    if (!window) return JSON.stringify(null);
    return JSON.stringify(describeWindow(window));
  }

  CloseWindow(id) {
    const window = findWindowById(id);
    if (!window) return JSON.stringify(false);
    // Reguläres Schließen – die Anwendung darf noch nachfragen (Speichern-Dialog).
    window.delete(global.get_current_time());
    return JSON.stringify(true);
  }

  ActivateWindow(id) {
    const window = findWindowById(id);
    if (!window) return JSON.stringify(false);
    window.activate(global.get_current_time());
    return JSON.stringify(true);
  }
}

export default class PcctlBridgeExtension extends Extension {
  enable() {
    this._service = new BridgeService();
    this._service.export();
  }

  disable() {
    this._service?.unexport();
    this._service = null;
  }
}
