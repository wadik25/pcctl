import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_PATH = `${GLib.get_user_config_dir()}/pcctl/config.json`;

function readAgentConfig() {
    try {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        const [, contents] = file.load_contents(null);
        const parsed = JSON.parse(new TextDecoder().decode(contents));
        return {
            token: String(parsed.token ?? ''),
            port: Number(parsed.port ?? 8765),
        };
    } catch {
        return { token: '', port: 8765 };
    }
}

function shorten(text, max = 24) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isOpen(task) {
    return task.status === 'inbox' || task.status === 'paused' || task.status === 'active';
}

function isWhatsAppTask(task) {
    return Boolean(task?.messageId) || task?.source === 'whatsapp';
}

const Indicator = GObject.registerClass(
class PcctlTaskIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'pcctl Aufgaben');
        this._extension = extension;

        this._label = new St.Label({
            text: '⚡',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'system-status-label',
        });
        this.add_child(this._label);

        this._inboxSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._inboxSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._workSwitch = new PopupMenu.PopupSwitchMenuItem('Work-Mode', false);
        this._workSwitch.connect('toggled', (_item, state) => {
            this._extension.request('POST', '/api/workmode', { enabled: state });
        });
        this.menu.addMenuItem(this._workSwitch);

        const openItem = new PopupMenu.PopupMenuItem('Desktop-App öffnen');
        openItem.connect('activate', () => this._extension.openDesktop());
        this.menu.addMenuItem(openItem);

        this._inbox = [];
        this._workMode = false;
    }

    setState({ inbox, workMode }) {
        this._inbox = inbox ?? [];
        this._workMode = Boolean(workMode);

        if (this._inbox.length > 0) {
            this.visible = true;
            const newest = this._inbox[0];
            this._label.text = this._inbox.length === 1
                ? `⚡ ${shorten(newest.title)}`
                : `⚡ ${this._inbox.length}`;
        } else {
            this.visible = false;
            this._label.text = '⚡';
        }

        this._rebuildMenu();
    }

    _rebuildMenu() {
        this._inboxSection.removeAll();

        const heading = new PopupMenu.PopupMenuItem('Offen', { reactive: false });
        this._inboxSection.addMenuItem(heading);
        const next = this._inbox.slice(0, 5);
        if (next.length === 0) {
            this._inboxSection.addMenuItem(new PopupMenu.PopupMenuItem('Keine offenen Aufgaben', { reactive: false }));
        }
        for (const task of next) {
            const label = task.senderName ? `${task.title}  ·  ${task.senderName}` : task.title;
            const item = new PopupMenu.PopupMenuItem(shorten(label, 48));
            item.connect('activate', () => this._extension.openDesktop());
            this._inboxSection.addMenuItem(item);
        }

        this._workSwitch.setToggleState(this._workMode);
    }
});

export default class PcctlTaskbarExtension extends Extension {
    enable() {
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
        this._ws = null;
        this._reconnectId = 0;
        this._backoff = 1000;
        this._seenTaskIds = new Set();
        this._source = null;

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea('pcctl-taskbar', this._indicator, 1, 'right');
        this._indicator.visible = false;

        this._refreshFromHttp();
        this._connectSocket();
    }

    disable() {
        if (this._reconnectId) {
            GLib.source_remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._ws) {
            try {
                this._ws.close(1000, 'disable');
            } catch {
                // Verbindung kann bereits tot sein
            }
            this._ws = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._source = null;
        this._session = null;
    }

    openDesktop() {
        try {
            Gio.Subprocess.new(['gtk-launch', 'pcctl-desktop.desktop'], Gio.SubprocessFlags.NONE);
        } catch {
            try {
                Gio.Subprocess.new(['pcctl-desktop'], Gio.SubprocessFlags.NONE);
            } catch (err) {
                logError(err, 'Desktop-App ließ sich nicht starten');
            }
        }
    }

    request(method, path, body = null) {
        const { token, port } = readAgentConfig();
        if (!token) return;

        const message = Soup.Message.new(method, `http://127.0.0.1:${port}${path}`);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        if (body) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
            message.set_request_body_from_bytes('application/json', bytes);
        }
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            try {
                session.send_and_read_finish(result);
                this._refreshFromHttp();
            } catch (err) {
                logError(err, `pcctl ${method} ${path}`);
            }
        });
    }

    _refreshFromHttp() {
        const { token, port } = readAgentConfig();
        if (!token) return;
        this._getJson(port, token, '/api/tasks', (all) => {
            this._getJson(port, token, '/api/workmode', (work) => {
                const inbox = Array.isArray(all) ? all.filter(isOpen) : [];
                this._indicator?.setState({
                    inbox,
                    workMode: Boolean(work?.enabled),
                });
                for (const task of inbox) this._seenTaskIds.add(task.id);
            });
        });
    }

    _getJson(port, token, path, callback) {
        const message = Soup.Message.new('GET', `http://127.0.0.1:${port}${path}`);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                callback(JSON.parse(text));
            } catch {
                // Agent gerade nicht erreichbar
            }
        });
    }

    _connectSocket() {
        const { token, port } = readAgentConfig();
        if (!token) {
            this._scheduleReconnect();
            return;
        }

        const message = Soup.Message.new('GET', `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
        this._session.websocket_connect_async(
            message,
            'http://127.0.0.1',
            null,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    this._ws = session.websocket_connect_finish(result);
                    this._backoff = 1000;
                    this._ws.connect('message', (_conn, _type, bytes) => {
                        const text = new TextDecoder().decode(bytes.get_data());
                        this._onSocketMessage(text);
                    });
                    this._ws.connect('closed', () => {
                        this._ws = null;
                        this._scheduleReconnect();
                    });
                    this._refreshFromHttp();
                } catch {
                    this._scheduleReconnect();
                }
            },
        );
    }

    _scheduleReconnect() {
        if (this._reconnectId) return;
        const delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, 30000);
        this._reconnectId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectId = 0;
            this._connectSocket();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onSocketMessage(text) {
        let message;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }
        const type = message.type;
        const payload = message.payload;

        if (type === 'taskCreated') {
            this._notifyNewTask(payload, false);
            this._refreshFromHttp();
        } else if (type === 'taskEnriched') {
            this._notifyNewTask(payload, true);
            this._refreshFromHttp();
        } else if (type === 'taskUpdated' || type === 'workModeChanged' || type === 'whatsappStatus' || type === 'inboxPending') {
            this._refreshFromHttp();
        }
    }

    _notifyNewTask(task, enriched) {
        if (!task?.id) return;
        if (!enriched) {
            if (this._seenTaskIds.has(task.id)) return;
            this._seenTaskIds.add(task.id);
        }
        if (!isWhatsAppTask(task)) return;

        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'pcctl',
                iconName: 'view-list-bullet-symbolic',
            });
            Main.messageTray.add(this._source);
        }

        const who = task.senderName || 'WhatsApp';
        const bodyParts = [enriched ? 'Neue Infos' : null, task.context, who].filter(Boolean);
        const notification = new MessageTray.Notification({
            source: this._source,
            title: task.title,
            body: bodyParts.join('\n') || who,
        });
        notification.addAction('Öffnen', () => this.openDesktop());
        try {
            notification.connect('activated', () => this.openDesktop());
        } catch {
            // Manche Shell-Versionen haben kein activated-Signal
        }
        this._source.addNotification(notification);
    }
}
