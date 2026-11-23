import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from
    'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';

const UUID = 'undecorate-with-whitelist@4fort';
const RETRY_INTERVAL_MS = 100;
const RETRY_COUNT = 20;

function isX11Window(window) {
    if (!window)
        return false;

    // Mutter 51 exposes the client type explicitly. Keep a fallback for
    // earlier Shell releases where the GI method/enum may not be available.
    try {
        if (typeof window.get_client_type === 'function' &&
            Meta.WindowClientType !== undefined) {
            return window.get_client_type() === Meta.WindowClientType.X11;
        }
    } catch (error) {
        console.debug(`[${UUID}] Could not read window client type: ${error}`);
    }

    // X11 MetaWindow descriptions are XIDs (0x...). Native Wayland windows
    // do not expose an XID, so they are deliberately ignored.
    try {
        return /^0x[0-9a-f]+$/i.test(window.get_description() ?? '');
    } catch (error) {
        return false;
    }
}

function getXid(window) {
    if (!isX11Window(window))
        return null;

    try {
        const description = window.get_description();
        const id = Number.parseInt(description, 16);

        if (Number.isSafeInteger(id) && id > 0)
            return `0x${id.toString(16)}`;
    } catch (error) {
        console.debug(`[${UUID}] Could not obtain X11 window ID: ${error}`);
    }

    return null;
}

function runXprop(window, decorations) {
    const xid = getXid(window);
    if (!xid)
        return false;

    try {
        const motifHints = decorations
            ? '0x2, 0x0, 0x1, 0x0, 0x0'
            : '0x2, 0x0, 0x0, 0x0, 0x0';

        const numericXid = Number.parseInt(xid, 16);
        const command = `xprop -id ${numericXid} -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "${motifHints}"`;

        const [success, stdout, stderr, status] =
            GLib.spawn_command_line_sync(command);

        console.log(`[${UUID}] xprop: xid=${xid}, success=${success}, status=${status}`);

        if (!success)
            console.error(`[${UUID}] xprop error: ${new TextDecoder().decode(stderr)}`);

        return success && status === 0;
    } catch (error) {
        console.error(`[${UUID}] xprop failed: ${error}`);
        return false;
    }
}

function getApplicationKey(window) {
    try {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        if (app) {
            const appId = app.get_id();
            if (appId)
                return appId.replace(/\.desktop$/i, '');
        }
    } catch (error) {
        console.debug(`[${UUID}] Could not identify application: ${error}`);
    }

    // Retain the original extension's app-ID matching behaviour. WM_CLASS is
    // a fallback for legacy X11 apps which have no matching Shell app.
    try {
        return window.get_wm_class() || null;
    } catch (error) {
        return null;
    }
}

function activateWindow(window) {
    try {
        window.activate(global.get_current_time());
    } catch (error) {
        console.debug(`[${UUID}] Could not activate window: ${error}`);
    }
}

export default class UndecorateExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._whitelist = this._settings.get_strv('window-whitelist');
        this._retrySources = new Set();
        this._undecoratedByExtension = new Map();

        this._originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;
        if (typeof this._originalBuildMenu !== 'function') {
            throw new Error('GNOME Shell window menu API is unavailable');
        }

        const extension = this;
        this._patchedBuildMenu = function (window) {
            extension._originalBuildMenu.call(this, window);

            if (!isX11Window(window))
                return;

            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (window.decorated) {
                this.addAction(_('Undecorate'), () => {
                    extension._undecorate(window);
                    activateWindow(window);
                });
                this.addAction(_('Always Undecorate App'), () => {
                    const appKey = getApplicationKey(window);
                    if (appKey)
                        extension.addToWhitelist(appKey);
                    extension._undecorate(window);
                    activateWindow(window);
                });
            } else {
                this.addAction(_('Decorate'), () => {
                    extension._decorate(window);
                    activateWindow(window);
                });

                const appKey = getApplicationKey(window);
                if (appKey && extension.isInWhitelist(appKey)) {
                    this.addAction(_('Remove from Whitelist'), () => {
                        extension.removeFromWhitelist(appKey);
                        extension._decorate(window);
                        activateWindow(window);
                    });
                }
            }
        };
        WindowMenu.WindowMenu.prototype._buildMenu = this._patchedBuildMenu;

        this._windowCreatedId = global.display.connect(
            'window-created', this._onWindowCreated.bind(this));
        this._settingsChangedId = this._settings.connect(
            'changed::window-whitelist', this._onWhitelistChanged.bind(this));

        this._applyWhitelistToExistingWindows();
    }

    disable() {
        if (this._originalBuildMenu &&
            WindowMenu.WindowMenu.prototype._buildMenu === this._patchedBuildMenu) {
            // Restore only if our patch is still installed. Avoid overwriting
            // another extension which may have patched the method afterwards.
            WindowMenu.WindowMenu.prototype._buildMenu = this._originalBuildMenu;
        }

        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        for (const sourceId of this._retrySources)
            GLib.source_remove(sourceId);
        this._retrySources.clear();

        // Re-enable decorations only for windows that this extension changed
        // from a decorated state during this session.
        for (const window of this._undecoratedByExtension.values()) {
            try {
                if (window && window.get_compositor_private())
                    runXprop(window, true);
            } catch (error) {
                console.debug(`[${UUID}] Could not restore window decorations: ${error}`);
            }
        }
        this._undecoratedByExtension.clear();

        this._settings = null;
        this._whitelist = [];
    }

    _onWhitelistChanged(settings) {
        this._whitelist = settings.get_strv('window-whitelist');
        this._applyWhitelistToExistingWindows();
    }

    _applyWhitelistToExistingWindows() {
        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window();
            if (!window || !isX11Window(window))
                continue;

            const appKey = getApplicationKey(window);
            if (appKey && this._whitelist.includes(appKey))
                this._undecorate(window);
        }
    }

    _onWindowCreated(_display, window) {
        if (!window)
            return;

        // App association and X11 properties may not be ready at the
        // window-created signal. Retry briefly instead of relying on one
        // arbitrary 100 ms delay.
        let attempts = 0;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            RETRY_INTERVAL_MS, () => {
                attempts++;
                if (!this._settings) {
                    this._retrySources.delete(sourceId);
                    return GLib.SOURCE_REMOVE;
                }

                if (isX11Window(window)) {
                    const appKey = getApplicationKey(window);
                    if (appKey) {
                        if (this._whitelist.includes(appKey))
                            this._undecorate(window);
                        this._retrySources.delete(sourceId);
                        return GLib.SOURCE_REMOVE;
                    }
                }

                if (attempts >= RETRY_COUNT) {
                    this._retrySources.delete(sourceId);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        this._retrySources.add(sourceId);
    }

    _undecorate(window) {
        if (!isX11Window(window))
            return;

        if (window.decorated)
            this._undecoratedByExtension.set(window.get_stable_sequence(), window);
        runXprop(window, false);
    }

    _decorate(window) {
        if (!isX11Window(window))
            return;

        this._undecoratedByExtension.delete(window.get_stable_sequence());
        runXprop(window, true);
    }

    addToWhitelist(appKey) {
        if (!this._whitelist.includes(appKey)) {
            this._whitelist = [...this._whitelist, appKey];
            this._settings.set_strv('window-whitelist', this._whitelist);
        }
    }

    removeFromWhitelist(appKey) {
        this._whitelist = this._whitelist.filter(item => item !== appKey);
        this._settings.set_strv('window-whitelist', this._whitelist);
    }

    isInWhitelist(appKey) {
        return this._whitelist.includes(appKey);
    }
}
