import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {SessionStatus, SessionWithStatus} from './types.js';
import {getTimeRemainingString, isFutureDate, openUrl} from './utils.js';
import {NO_SESSIONS_MESSAGE, readSessions, spawnLoginProcess} from './providers/aws.js';

type DisplayState = 'active' | 'warning' | 'inactive';

const REFRESH_INTERVAL_SECONDS = 30;
const LOGIN_ICON = 'dialog-password-symbolic';
const PROFILES_ICON = 'system-users-symbolic';

const ICON_STATE_CLASSES: Partial<Record<DisplayState, string>> = {
    active: 'auth-monitor-icon-active',
    warning: 'auth-monitor-icon-warning',
};

// How recently a refresh token must have expired for us to notify the user.
// We notify *after* expiry rather than before because logging in again does
// not extend a still-active token – only a fresh login past expiry helps.
const EXPIRY_NOTIFY_MS = 15 * 60 * 1000; // 15 minutes

const NORMAL_OPACITY = 200; // ~0.78
const MUTED_OPACITY = 180; // ~0.71

const createExpiryLabel = (expiresAt: Date, extraStyle = ''): St.Label => {
    const expired = expiresAt.getTime() <= Date.now();
    const label = new St.Label({
        text: getTimeRemainingString(expiresAt),
        y_align: Clutter.ActorAlign.CENTER,
        style_class: expired
            ? 'auth-monitor-expiry auth-monitor-expiry-expired'
            : 'auth-monitor-expiry',
    });
    if (extraStyle) label.style = extraStyle;
    // A still-valid countdown has no semantic color, so it inherits the theme
    // foreground; dim it so it reads as secondary text without hardcoding a
    // color that only works on a dark background.
    if (!expired) label.opacity = NORMAL_OPACITY;
    return label;
};

/**
 * Status-circle color for a session. Green when the SSO session (refresh
 * token) or the access token is still valid; yellow when both of those have
 * expired but a cached profile credential is still valid; red otherwise.
 *
 * @param {SessionStatus} status
 */
const getSessionDisplayState = (status: SessionStatus): DisplayState => {
    if (status.active || isFutureDate(status.accessTokenExpiresAt)) return 'active';
    if (status.profileCredentials.some(cred => isFutureDate(cred.expiresAt)))
        return 'warning';
    return 'inactive';
};

const createStatusCircle = (state: DisplayState): St.Widget => {
    const OUTER_LENGTH = 18;
    const INNER_LENGTH = 10;

    const outer = new St.Widget({
        width: OUTER_LENGTH,
        height: OUTER_LENGTH,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false,
        layout_manager: new Clutter.BinLayout(),
        style_class: `auth-monitor-status-halo auth-monitor-status-halo-${state}`,
    });

    const inner = new St.Widget({
        width: INNER_LENGTH,
        height: INNER_LENGTH,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false,
        y_expand: false,
        style_class: `auth-monitor-status-dot auth-monitor-status-dot-${state}`,
    });

    outer.add_child(inner);
    return outer;
};

const Indicator = GObject.registerClass(
    class IndicatorInner extends PanelMenu.Button {
        declare _icon: St.Icon;
        declare _sessions: Map<string, SessionWithStatus>;
        declare _refreshTimeoutId: number;
        // Refresh-token deadline (ms) we've already warned about, per session,
        // so a given token triggers at most one expiry notification.
        declare _expiryWarned: Map<string, number>;
        declare _notificationSource: MessageTray.Source | null;
        declare _menuOpenStateId: number;
        declare _sourceDestroyId: number;
        declare _notification: MessageTray.Notification | null;
        declare _notificationActivatedId: number;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _init(...args: any[]) {
            super._init(...args);

            this.set_style('-natural-hpadding: 2px; -minimum-hpadding: 2px;');
            this._icon = new St.Icon({
                style_class: 'system-status-icon',
            });
            this.add_child(this._icon);

            this._sessions = new Map();
            this._expiryWarned = new Map();
            this._notificationSource = null;
            this._sourceDestroyId = 0;
            this._notification = null;
            this._notificationActivatedId = 0;

            // Refresh on a fixed cadence regardless of whether the menu is
            // open, so the top-bar icon color stays current in the background.
            // The periodic tick also drives proactive expiry notifications.
            this._refreshTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                REFRESH_INTERVAL_SECONDS,
                () => {
                    this._refresh()
                        .then(() => this._checkExpiryNotifications())
                        .catch(logError);
                    return GLib.SOURCE_CONTINUE;
                }
            );

            // Also refresh the instant the menu opens, so its countdowns and
            // dots are current rather than up to one interval stale.
            this._menuOpenStateId = (this.menu as PopupMenu.PopupMenu).connect(
                'open-state-changed',
                (_menu, open) => {
                    if (open) void this._refresh();
                }
            );
        }

        setIconPath(extensionPath: string) {
            this._icon.gicon = Gio.icon_new_for_string(
                `${extensionPath}/resources/icon-symbolic.svg`
            );
        }

        async _refresh() {
            const next = new Map<string, SessionWithStatus>();
            for (const ui of await readSessions()) next.set(ui.session.name, ui);
            this._sessions = next;
            // Always rebuild: PopupMenu.open() refuses to open an empty menu,
            // so the menu must stay populated even while closed.
            this._rebuildMenu();
            this._updateTopBarIconTint();
        }

        _updateTopBarIconTint() {
            let anyGreen = false;
            let anyYellow = false;
            for (const ui of this._sessions.values()) {
                const state = getSessionDisplayState(ui.status);
                if (state === 'active') anyGreen = true;
                else if (state === 'warning') anyYellow = true;
            }
            // Green wins over yellow; no tint when nothing is valid. The icon is
            // reused across refreshes, so clear the previous tint first.
            let state: DisplayState = 'inactive';
            if (anyGreen) state = 'active';
            else if (anyYellow) state = 'warning';
            for (const cls of Object.values(ICON_STATE_CLASSES))
                this._icon.remove_style_class_name(cls);
            const tint = ICON_STATE_CLASSES[state];
            if (tint) this._icon.add_style_class_name(tint);
        }

        _rebuildMenu() {
            const menu = this.menu as PopupMenu.PopupMenu;
            menu.removeAll();

            if (this._sessions.size === 0) {
                const empty = new PopupMenu.PopupMenuItem(NO_SESSIONS_MESSAGE, {
                    reactive: false,
                });
                menu.addMenuItem(empty);
                return;
            }

            const uis = [...this._sessions.values()];
            uis.forEach((ui, i) => {
                if (i > 0) menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._addSessionItem(menu, ui);
            });
        }

        _addSessionItem(menu: PopupMenu.PopupMenu, ui: SessionWithStatus) {
            const sessionItem = new PopupMenu.PopupBaseMenuItem({reactive: false});

            const displayState = getSessionDisplayState(ui.status);
            sessionItem.add_child(createStatusCircle(displayState));

            // The name doubles as a link: clicking it opens the session's
            // start URL in the default browser. Kept as a bare reactive
            // label – not wrapped in a button – so its position in the row
            // matches the original layout exactly.
            const nameLabel = new St.Label({
                text: ui.session.name,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                reactive: ui.status.active,
                style_class: 'auth-monitor-session-name',
            });
            if (ui.status.active) {
                nameLabel.connect('button-release-event', (_actor, event) => {
                    if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                        return Clutter.EVENT_PROPAGATE;
                    this._openStartUrl(ui);
                    return Clutter.EVENT_STOP;
                });
            }
            sessionItem.add_child(nameLabel);

            const loginButton = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                child: new St.Icon({
                    icon_name: LOGIN_ICON,
                    style_class: 'popup-menu-icon',
                }),
                // Padding and the :hover highlight live in stylesheet.css;
                // track_hover drives St's :hover pseudo-class.
                style_class: 'system-menu-action auth-monitor-login-button',
            });
            loginButton.connect('clicked', () => this._startLogin(ui, loginButton));
            sessionItem.add_child(loginButton);

            menu.addMenuItem(sessionItem);

            // Show only profiles whose cached credential is still valid, and
            // omit the group entirely when none are.
            const activeProfiles = ui.status.profileCredentials.filter(cred =>
                isFutureDate(cred.expiresAt)
            );

            this._addTokenExpiryRow(
                menu,
                ui.status.refreshDeadline,
                ui.status.accessTokenExpiresAt,
                activeProfiles.length > 0
            );

            if (activeProfiles.length > 0) {
                const profilesItem = new PopupMenu.PopupSubMenuMenuItem(
                    `Active profiles (${activeProfiles.length})`,
                    true
                );
                if (profilesItem.icon) {
                    profilesItem.icon.icon_name = PROFILES_ICON;
                    profilesItem.icon.style = 'margin-left: 4px;';
                    profilesItem.icon.opacity = MUTED_OPACITY;
                }
                profilesItem.label.style = 'font-size: 0.9em;';
                profilesItem.label.opacity = NORMAL_OPACITY;

                for (const cred of activeProfiles) {
                    this._addExpiryRow(
                        profilesItem.menu,
                        cred.profileName,
                        cred.expiresAt
                    );
                }

                menu.addMenuItem(profilesItem);
            }
        }

        _addExpiryRow(menu: PopupMenu.PopupMenuBase, label: string, expiresAt: Date) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const name = new St.Label({
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                style_class: 'auth-monitor-caption',
            });
            name.opacity = NORMAL_OPACITY;
            item.add_child(name);

            item.add_child(createExpiryLabel(expiresAt, 'margin-right: 10px; '));
            menu.addMenuItem(item);
        }

        /**
         * A compact "Label 42m left" pair: a muted caption next to its
         * expiry-colored countdown. Used to pack the SSO-session and access-token
         * expiries onto one row.
         *
         * @param {string} label
         * @param {Date} expiresAt
         */
        _makeExpiryChunk(label: string, expiresAt: Date): St.BoxLayout {
            const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});

            const name = new St.Label({
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'auth-monitor-caption',
            });
            name.opacity = MUTED_OPACITY;
            box.add_child(name);

            box.add_child(createExpiryLabel(expiresAt, 'margin-left: 6px; '));
            return box;
        }

        /**
         * Single indented row showing the SSO-session and access-token expiries
         * side by side, separated by a dot. Renders only the chunks that exist.
         *
         * When neither token is still valid the row is normally hidden – a pair
         * of "expired" countdowns is noise the red status dot already conveys.
         * The exception is when a cached profile credential is still active: the
         * expired token state then explains why the session can't refresh even
         * though credentials remain usable, so it's worth showing.
         *
         * @param {PopupMenu.PopupMenuBase} menu
         * @param {Date | null} refreshDeadline
         * @param {Date | null} accessTokenExpiresAt
         * @param {boolean} hasActiveProfile
         */
        _addTokenExpiryRow(
            menu: PopupMenu.PopupMenuBase,
            refreshDeadline: Date | null,
            accessTokenExpiresAt: Date | null,
            hasActiveProfile: boolean
        ) {
            // Hide the row when both tokens have expired (see the rationale in
            // this method's doc comment), unless a cached profile credential is
            // still active.
            if (
                !hasActiveProfile &&
                !isFutureDate(refreshDeadline) &&
                !isFutureDate(accessTokenExpiresAt)
            )
                return;

            const chunks: St.BoxLayout[] = [];
            if (refreshDeadline)
                chunks.push(this._makeExpiryChunk('Refresh token', refreshDeadline));
            if (accessTokenExpiresAt)
                chunks.push(this._makeExpiryChunk('Access token', accessTokenExpiresAt));

            // Nothing to render if neither deadline exists (e.g. an active
            // profile with no associated SSO token information).
            if (chunks.length === 0) return;

            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            chunks[0].add_style_class_name('auth-monitor-token-row');
            item.add_child(chunks[0]);

            if (chunks.length > 1) {
                const sep = new St.Label({
                    text: '·',
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'auth-monitor-caption auth-monitor-token-separator',
                });
                sep.opacity = MUTED_OPACITY;
                item.add_child(sep);
                item.add_child(chunks[1]);
            }

            // Absorb the remaining width so the chunks stay grouped at the left.
            item.add_child(new St.Widget({x_expand: true}));

            menu.addMenuItem(item);
        }

        _spawnLogin(sessionName: string): boolean {
            const failure = spawnLoginProcess(sessionName);
            if (failure) {
                Main.notifyError(failure.title, failure.body);
                return false;
            }
            return true;
        }

        _openStartUrl(ui: SessionWithStatus) {
            if (!openUrl(ui.session.startUrl)) return;

            (this.menu as PopupMenu.PopupMenu).close(BoxPointer.PopupAnimation.FULL);
        }

        /**
         * Notify the user about every session whose refresh token expired
         * within the last EXPIRY_NOTIFY_MS. Deduplicated per refresh-token
         * deadline so a given expired token warns at most once; a later token
         * (new deadline) that expires re-arms the warning for its own expiry.
         */
        _checkExpiryNotifications() {
            const now = Date.now();
            const stillWarned = new Map<string, number>();
            for (const [name, ui] of this._sessions) {
                const deadline = ui.status.refreshDeadline;
                if (!deadline) continue;
                const msSinceExpiry = now - deadline.getTime();
                if (msSinceExpiry < 0 || msSinceExpiry >= EXPIRY_NOTIFY_MS) continue;

                const deadlineMs = deadline.getTime();
                stillWarned.set(name, deadlineMs);
                if (this._expiryWarned.get(name) !== deadlineMs)
                    this._notifyExpired(name);
            }
            this._expiryWarned = stillWarned;
        }

        _ensureNotificationSource(): MessageTray.Source {
            if (!this._notificationSource) {
                this._notificationSource = new MessageTray.Source({
                    title: 'Auth Monitor',
                    iconName: LOGIN_ICON,
                });
                this._sourceDestroyId = this._notificationSource.connect(
                    'destroy',
                    () => {
                        this._notificationSource = null;
                        this._sourceDestroyId = 0;
                    }
                );
                Main.messageTray.add(this._notificationSource);
            }
            return this._notificationSource;
        }

        _notifyExpired(sessionName: string) {
            const source = this._ensureNotificationSource();
            this._notification = new MessageTray.Notification({
                source,
                title: `Session ${sessionName} has expired`,
                body: 'Click here to renew.',
                iconName: LOGIN_ICON,
                urgency: MessageTray.Urgency.HIGH,
            });
            this._notificationActivatedId = this._notification.connect('activated', () =>
                this._spawnLogin(sessionName)
            );
            source.addNotification(this._notification);
        }

        _startLogin(ui: SessionWithStatus, button: St.Button) {
            if (!this._spawnLogin(ui.session.name)) return;

            const menu = this.menu as PopupMenu.PopupMenu;
            button.set_pivot_point(0.5, 0.5);
            button.ease({
                scaleX: 1.3,
                scaleY: 1.3,
                opacity: 0,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            menu.actor.ease({
                opacity: 0,
                delay: 120,
                duration: 480,
                mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => menu.close(),
            });
        }

        destroy() {
            if (this._refreshTimeoutId) {
                GLib.source_remove(this._refreshTimeoutId);
                this._refreshTimeoutId = 0;
            }
            if (this._menuOpenStateId) {
                (this.menu as PopupMenu.PopupMenu).disconnect(this._menuOpenStateId);
                this._menuOpenStateId = 0;
            }
            if (this._notification && this._notificationActivatedId) {
                this._notification.disconnect(this._notificationActivatedId);
                this._notificationActivatedId = 0;
            }
            this._notification = null;
            if (this._notificationSource && this._sourceDestroyId) {
                this._notificationSource.disconnect(this._sourceDestroyId);
                this._sourceDestroyId = 0;
            }
            this._notificationSource?.destroy(
                MessageTray.NotificationDestroyedReason.SOURCE_CLOSED
            );
            this._notificationSource = null;
            super.destroy();
        }
    }
);

export default class GnomeAuthMonitorExtension extends Extension {
    _indicator: InstanceType<typeof Indicator> | null = null;

    enable() {
        this._indicator = new Indicator(0.0, 'Auth Monitor');
        this._indicator.setIconPath(this.path);
        void this._indicator._refresh();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
