import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

import { ExtensionPreferences, gettext as _ } from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const WhitelistRow = GObject.registerClass(
class WhitelistRow extends Adw.ActionRow {
    _init(appId, removeCallback) {
        super._init({
            title: appId,
            subtitle: _('Application ID / WM_CLASS key'),
        });

        const removeButton = new Gtk.Button({
            icon_name: 'list-remove-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
            tooltip_text: _('Remove from whitelist'),
        });
        removeButton.connect('clicked', () => removeCallback(appId));
        this.add_suffix(removeButton);
    }
});

export default class UndecoratePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Undecorated Applications'),
            description: _('X11/XWayland applications in this list are automatically undecorated.'),
        });
        page.add(group);

        const countRow = new Adw.ActionRow({ title: _('Applications in whitelist') });
        group.add(countRow);

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        group.add(list);

        const refresh = () => {
            list.remove_all();
            const ids = settings.get_strv('window-whitelist');
            countRow.set_subtitle(`${ids.length}`);
            if (ids.length === 0) {
                list.append(new Adw.ActionRow({
                    title: _('No applications in whitelist'),
                    subtitle: _('Add an application ID below.'),
                }));
            }
            for (const id of ids) {
                list.append(new WhitelistRow(id, removeId));
            }
        };

        const removeId = id => {
            settings.set_strv('window-whitelist',
                settings.get_strv('window-whitelist').filter(value => value !== id));
            refresh();
        };

        const addRow = new Adw.ActionRow({ title: _('Add application') });
        const entryBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
            hexpand: true,
        });
        const entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('Application ID or WM_CLASS'),
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add to whitelist'),
        });
        const add = () => {
            const value = entry.get_text().trim();
            if (!value)
                return;
            const ids = settings.get_strv('window-whitelist');
            if (!ids.includes(value))
                settings.set_strv('window-whitelist', [...ids, value]);
            entry.set_text('');
            refresh();
        };
        addButton.connect('clicked', add);
        entry.connect('activate', add);
        entryBox.append(entry);
        entryBox.append(addButton);
        addRow.set_child(entryBox);
        group.add(addRow);

        refresh();
    }
}
