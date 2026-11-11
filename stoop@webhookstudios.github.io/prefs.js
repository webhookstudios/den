import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {applyToWindow as applySedge} from './sedge/sedge.js';

import {applyValues, readTyped, sanitize, snapshot, wallpaperFile} from './model.js';
import {BUILTIN_PRESETS} from './presets.js';
import {drawLock, makePreview} from './preview.js';
import {findWallpapers} from './wallpapers.js';

let toastOverlay = null;
function toast(text) {
    toastOverlay?.add_toast(new Adw.Toast({title: text, timeout: 3}));
}

// Disconnects a settings handler when the widget using it goes away.
function watch(widget, settings, signal, callback) {
    const id = settings.connect(signal, callback);
    widget.connect('destroy', () => settings.disconnect(id));
}

// ---- Row helpers -------------------------------------------------------------

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function range(settings, key) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
    return [lower, upper];
}

function spinRow(settings, key, title, subtitle = '', step = 1) {
    const [lower, upper] = range(settings, key);
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function sliderRow(settings, key, title, subtitle = '', digits = 2) {
    const [lower, upper] = range(settings, key);
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL, width_request: 240, valign: Gtk.Align.CENTER,
        draw_value: true, value_pos: Gtk.PositionType.RIGHT, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: (upper - lower) / 100}),
    });
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.ActionRow({title, subtitle, activatable_widget: scale});
    row.add_suffix(scale);
    return row;
}

// A combo row over [value, label] pairs. `read` and `write` default to a
// string key of our own settings.
function comboRow(settings, key, title, subtitle, options,
    read = () => settings.get_string(key), write = value => settings.set_string(key, value)) {
    const row = new Adw.ComboRow({
        title, subtitle: subtitle ?? '', model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const show = () => {
        const index = options.findIndex(([value]) => value === read());
        if (index >= 0 && row.selected !== index)
            row.selected = index;
    };
    show();
    watch(row, settings, `changed::${key}`, show);
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value !== undefined && value !== read())
            write(value);
    });
    return row;
}

function toHex(rgba) {
    const part = value => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${part(rgba.red)}${part(rgba.green)}${part(rgba.blue)}`;
}

function colorRow(settings, key, title, subtitle = '') {
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER,
    });
    const show = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && toHex(rgba) !== toHex(button.rgba))
            button.rgba = rgba;
    };
    show();
    watch(button, settings, `changed::${key}`, show);
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });
    const row = new Adw.ActionRow({title, subtitle, activatable_widget: button});
    row.add_suffix(button);
    return row;
}

function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function actionRow(title, subtitle, icon, callback) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: icon}));
    row.connect('activated', callback);
    return row;
}

// Greys a row out while `predicate()` is false; re-checked on any change.
function dependsOn(settings, row, predicate) {
    const update = () => (row.sensitive = predicate());
    update();
    watch(row, settings, 'changed', update);
    return row;
}

function lockNow() {
    Gio.DBus.session.call('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver',
        'Lock', null, null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                connection.call_finish(result);
            } catch (e) {
                toast(`Could not lock the screen: ${e.message}`);
            }
        });
}

// ---- The preview that stays at the top -----------------------------------------

function previewPanel(settings) {
    const get = key => readTyped(settings, key);
    const options = {prompt: false};
    const area = makePreview(get, options, {content_width: 352, content_height: 220});

    const side = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 10, valign: Gtk.Align.CENTER, hexpand: true,
    });
    const title = new Gtk.Label({xalign: 0, css_classes: ['title-2']});
    const subtitle = new Gtk.Label({
        xalign: 0, wrap: true, css_classes: ['dim-label'],
        label: 'This is how your lock screen will look. Changes apply straight away.',
    });
    const showName = () => {
        const id = settings.get_string('current-preset');
        const builtin = BUILTIN_PRESETS.find(p => p.id === id);
        title.label = builtin ? builtin.name : id.startsWith('user:') ? id.slice(5) : 'Custom';
    };
    showName();
    side.append(title);
    side.append(subtitle);

    const clock = new Gtk.ToggleButton({label: 'Clock', active: true});
    const password = new Gtk.ToggleButton({label: 'Password', group: clock});
    const views = new Gtk.Box({css_classes: ['linked'], halign: Gtk.Align.START});
    views.append(clock);
    views.append(password);
    password.connect('toggled', () => {
        options.prompt = password.active;
        area.queue_draw();
    });
    const lock = new Gtk.Button({
        label: 'Lock now', css_classes: ['suggested-action'], halign: Gtk.Align.START,
        tooltip_text: 'Lock the screen to see the real thing',
    });
    lock.connect('clicked', lockNow);
    const buttons = new Gtk.Box({spacing: 10});
    buttons.append(views);
    buttons.append(lock);
    side.append(buttons);

    const box = new Gtk.Box({
        spacing: 20, margin_top: 14, margin_bottom: 14, margin_start: 20, margin_end: 20,
    });
    box.append(area);
    box.append(side);

    watch(box, settings, 'changed', () => {
        showName();
        area.queue_draw();
    });
    // Keep the clock in the preview current.
    const tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        area.queue_draw();
        return GLib.SOURCE_CONTINUE;
    });
    box.connect('destroy', () => GLib.source_remove(tick));
    return box;
}

// ---- Presets ----------------------------------------------------------------------

function loadUserPresets(settings) {
    try {
        const data = JSON.parse(settings.get_string('user-presets'));
        return typeof data === 'object' && data ? data : {};
    } catch {
        return {};
    }
}

function saveUserPreset(settings, name, values) {
    const all = loadUserPresets(settings);
    all[name] = {name, values};
    settings.set_string('user-presets', JSON.stringify(all));
}

// Reads a preset's value for a key, the schema default for anything it
// leaves out, and your own wallpaper and text for the rest.
function presetGetter(settings, values) {
    const schema = settings.settings_schema;
    return key => {
        if (key in values)
            return values[key];
        if (['wallpaper-source', 'wallpaper-path', 'wallpaper-color'].includes(key))
            return readTyped(settings, key);
        if (key === 'message-text')
            return '';
        return schema.get_key(key).get_default_value().recursiveUnpack();
    };
}

function exportFile(window, name, values) {
    const dialog = new Gtk.FileDialog({
        title: 'Export preset', initial_name: `${name.replace(/[^\w.-]+/g, '-')}.lockpreset.json`,
    });
    dialog.save(window, null, (_d, result) => {
        try {
            const file = dialog.save_finish(result);
            const text = JSON.stringify({format: 'stoop-preset', version: 1, name, values}, null, 2);
            file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.NONE, null);
            toast(`Exported “${name}”`);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                toast(`Could not export: ${e.message}`);
        }
    });
}

function importFile(window, settings) {
    const dialog = new Gtk.FileDialog({title: 'Import preset'});
    dialog.open(window, null, (_d, result) => {
        try {
            const file = dialog.open_finish(result);
            const [, bytes] = file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (data?.format !== 'stoop-preset' || typeof data.values !== 'object')
                throw new Error('this is not a Den preset');
            const values = sanitize(settings, data.values);
            if (Object.keys(values).length === 0)
                throw new Error('the preset has no usable settings');
            const base = String(data.name ?? 'Imported').trim().slice(0, 40) || 'Imported';
            const existing = loadUserPresets(settings);
            let name = base;
            for (let n = 2; name in existing; n++)
                name = `${base} ${n}`;
            saveUserPreset(settings, name, values);
            toast(`Imported “${name}”`);
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                toast(`Could not import: ${e.message}`);
        }
    });
}

function presetCard(window, settings, preset, user) {
    const marker = user ? `user:${preset.name}` : preset.id;
    const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['card']});

    const get = presetGetter(settings, preset.values);
    const area = makePreview(get, {}, {content_width: 168, content_height: 105, halign: Gtk.Align.CENTER});
    watch(area, settings, 'changed', (_s, key) => {
        if (key.startsWith('wallpaper-'))
            area.queue_draw();
    });

    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 6, margin_bottom: 2});
    body.append(area);
    const title = new Gtk.Label({label: preset.name, xalign: 0, css_classes: ['heading'], ellipsize: Pango.EllipsizeMode.END});
    body.append(title);
    if (preset.description) {
        body.append(new Gtk.Label({
            label: preset.description, xalign: 0, yalign: 0, wrap: true, lines: 4,
            ellipsize: Pango.EllipsizeMode.END, width_chars: 20, max_width_chars: 20,
            css_classes: ['dim-label', 'caption'], vexpand: true,
        }));
    }
    const main = new Gtk.Button({css_classes: ['flat'], child: body, vexpand: true});
    main.connect('clicked', () => {
        applyValues(settings, preset.values);
        settings.set_string('current-preset', marker);
        toast(`Applied “${preset.name}”`);
    });
    card.append(main);

    const tools = new Gtk.Box({spacing: 2, margin_start: 8, margin_end: 4, margin_bottom: 4});
    const active = new Gtk.Label({label: 'In use', css_classes: ['caption', 'accent'], hexpand: true, xalign: 0});
    tools.append(active);
    const exportButton = new Gtk.Button({
        icon_name: 'document-save-symbolic', css_classes: ['flat'], tooltip_text: 'Export to a file',
    });
    exportButton.connect('clicked', () => exportFile(window, preset.name, {...preset.values}));
    tools.append(exportButton);
    if (user) {
        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic', css_classes: ['flat'], tooltip_text: 'Delete this preset',
        });
        remove.connect('clicked', () => {
            const all = loadUserPresets(settings);
            delete all[preset.name];
            settings.set_string('user-presets', JSON.stringify(all));
        });
        tools.append(remove);
    }
    card.append(tools);

    const mark = () => (active.opacity = settings.get_string('current-preset') === marker ? 1 : 0);
    mark();
    watch(card, settings, 'changed::current-preset', mark);
    return card;
}

function presetsPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Presets', icon_name: 'view-grid-symbolic'});

    const main = new Adw.PreferencesGroup();
    main.add(switchRow(settings, 'enabled', 'Restyle the lock screen',
        'Turn off to get the standard lock screen back'));
    page.add(main);

    const cards = new Adw.PreferencesGroup({
        title: 'Presets',
        description: 'Pick a look, then change anything you like on the other pages. Presets keep your wallpaper.',
    });
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, row_spacing: 12, column_spacing: 12,
        min_children_per_line: 2, max_children_per_line: 3,
    });
    cards.add(flow);
    page.add(cards);
    const rebuild = () => {
        flow.remove_all();
        for (const preset of BUILTIN_PRESETS)
            flow.append(presetCard(window, settings, preset, false));
        for (const preset of Object.values(loadUserPresets(settings)))
            flow.append(presetCard(window, settings, preset, true));
    };
    rebuild();
    watch(flow, settings, 'changed::user-presets', rebuild);

    const yours = new Adw.PreferencesGroup({
        title: 'Your presets', description: 'Save the current look, or share presets as files.',
    });
    const name = new Adw.EntryRow({title: 'Save the current look as…', show_apply_button: true});
    name.connect('apply', () => {
        const text = name.text.trim();
        if (!text)
            return;
        saveUserPreset(settings, text, snapshot(settings));
        settings.set_string('current-preset', `user:${text}`);
        name.text = '';
        toast(`Saved “${text}”`);
    });
    yours.add(name);
    yours.add(actionRow('Import a preset file', '', 'document-open-symbolic', () => importFile(window, settings)));
    yours.add(actionRow('Export the current look to a file', '', 'document-save-symbolic',
        () => exportFile(window, 'My lock screen', snapshot(settings))));
    yours.add(actionRow('Reset the look', 'Resets every look setting; your wallpaper stays',
        'edit-undo-symbolic', () => {
            applyValues(settings, {});
            settings.set_string('current-preset', 'default');
            toast('The look is reset');
        }));
    page.add(yours);
    return page;
}

// ---- Wallpaper ----------------------------------------------------------------------

function wallpaperGallery(settings) {
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, row_spacing: 8, column_spacing: 8,
        min_children_per_line: 3, max_children_per_line: 4,
    });
    const buttons = new Map();
    const mark = () => {
        const current = settings.get_string('wallpaper-source') === 'image'
            ? settings.get_string('wallpaper-path') : null;
        for (const [path, button] of buttons)
            button.active = path === current;
    };

    const paths = findWallpapers();
    // One thumbnail per idle turn, so the window stays responsive.
    let index = 0;
    const loader = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        if (index >= paths.length)
            return GLib.SOURCE_REMOVE;
        const path = paths[index++];
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 300, 190, true);
            const picture = new Gtk.Picture({
                paintable: Gdk.Texture.new_for_pixbuf(pixbuf), content_fit: Gtk.ContentFit.COVER,
                width_request: 128, height_request: 80, can_shrink: true,
            });
            const frame = new Gtk.Frame({child: picture, overflow: Gtk.Overflow.HIDDEN});
            const button = new Gtk.ToggleButton({
                child: frame, css_classes: ['flat'], tooltip_text: GLib.path_get_basename(path),
            });
            button.connect('clicked', () => {
                settings.set_string('wallpaper-path', path);
                settings.set_string('wallpaper-source', 'image');
                mark();
            });
            buttons.set(path, button);
            flow.append(button);
            mark();
        } catch {
            // Not a readable picture; leave it out.
        }
        return GLib.SOURCE_CONTINUE;
    });
    flow.connect('destroy', () => {
        if (index < paths.length)
            GLib.source_remove(loader);
    });
    watch(flow, settings, 'changed', (_s, key) => {
        if (key.startsWith('wallpaper-'))
            mark();
    });
    return [flow, paths.length];
}

function wallpaperPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Wallpaper', icon_name: 'image-x-generic-symbolic'});

    const source = new Adw.PreferencesGroup({title: 'Lock screen wallpaper'});
    source.add(comboRow(settings, 'wallpaper-source', 'Show', '', [
        ['desktop', 'The desktop wallpaper'], ['image', 'A picture of its own'], ['color', 'A plain color']]));
    const fileRow = new Adw.ActionRow({title: 'Picture', activatable: true});
    const fileLabel = new Gtk.Label({css_classes: ['dim-label'], ellipsize: Pango.EllipsizeMode.MIDDLE, max_width_chars: 32});
    const showFile = () => (fileLabel.label = GLib.path_get_basename(settings.get_string('wallpaper-path')) || 'Choose…');
    showFile();
    watch(fileLabel, settings, 'changed::wallpaper-path', showFile);
    fileRow.add_suffix(fileLabel);
    fileRow.add_suffix(new Gtk.Image({icon_name: 'document-open-symbolic'}));
    fileRow.connect('activated', () => {
        const dialog = new Gtk.FileDialog({title: 'Choose a lock screen picture'});
        const filter = new Gtk.FileFilter({name: 'Pictures'});
        for (const type of ['image/jpeg', 'image/png', 'image/webp'])
            filter.add_mime_type(type);
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        dialog.filters = filters;
        dialog.open(window, null, (_d, result) => {
            try {
                settings.set_string('wallpaper-path', dialog.open_finish(result).get_path());
                settings.set_string('wallpaper-source', 'image');
            } catch { /* cancelled */ }
        });
    });
    source.add(dependsOn(settings, fileRow, () => settings.get_string('wallpaper-source') === 'image'));
    source.add(dependsOn(settings, colorRow(settings, 'wallpaper-color', 'Color'),
        () => settings.get_string('wallpaper-source') === 'color'));
    source.add(actionRow('Use this picture on the desktop too',
        'Sets the desktop wallpaper to the lock screen picture', 'preferences-desktop-wallpaper-symbolic', () => {
            const path = settings.get_string('wallpaper-source') === 'image'
                ? wallpaperFile(key => readTyped(settings, key)) : null;
            if (!path) {
                toast('Choose a picture of its own first');
                return;
            }
            const uri = Gio.File.new_for_path(path).get_uri();
            const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            desktop.set_string('picture-uri', uri);
            desktop.set_string('picture-uri-dark', uri);
            toast('Desktop wallpaper changed');
        }));
    page.add(source);

    const [gallery, count] = wallpaperGallery(settings);
    const pictures = new Adw.PreferencesGroup({
        title: 'Pictures',
        description: count
            ? 'From your wallpaper folders and the ones that came with the system. Click one to use it.'
            : 'No pictures were found in the usual wallpaper folders. Use “Picture” above to choose a file.',
    });
    pictures.add(gallery);
    page.add(pictures);

    const effects = new Adw.PreferencesGroup({title: 'Blur and color'});
    effects.add(spinRow(settings, 'blur', 'Blur', '0 keeps the picture sharp', 5));
    effects.add(sliderRow(settings, 'brightness', 'Brightness', 'Lower is darker'));
    effects.add(colorRow(settings, 'tint-color', 'Tint color', 'A wash of color over the picture'));
    effects.add(sliderRow(settings, 'tint-opacity', 'Tint strength'));
    effects.add(sliderRow(settings, 'shade', 'Darken the bottom', 'Helps text near the bottom edge stand out'));
    page.add(effects);
    return page;
}

// ---- Clock ---------------------------------------------------------------------------

const POSITIONS = [
    ['top-left', 'Top left'], ['top', 'Top'], ['top-right', 'Top right'],
    ['left', 'Left'], ['center', 'Middle'], ['right', 'Right'],
    ['bottom-left', 'Bottom left'], ['bottom', 'Bottom'], ['bottom-right', 'Bottom right'],
];

// A three-by-three grid standing for the screen; click where the clock goes.
function positionPicker(settings) {
    const grid = new Gtk.Grid({
        row_spacing: 4, column_spacing: 4, valign: Gtk.Align.CENTER, margin_top: 8, margin_bottom: 8,
    });
    const buttons = new Map();
    let first = null;
    POSITIONS.forEach(([value, label], i) => {
        const button = new Gtk.ToggleButton({
            tooltip_text: label, width_request: 44, height_request: 28, group: first,
        });
        first ??= button;
        button.connect('toggled', () => {
            if (button.active && settings.get_string('clock-position') !== value)
                settings.set_string('clock-position', value);
        });
        buttons.set(value, button);
        grid.attach(button, i % 3, Math.floor(i / 3), 1, 1);
    });
    const show = () => {
        const button = buttons.get(settings.get_string('clock-position'));
        if (button)
            button.active = true;
    };
    show();
    watch(grid, settings, 'changed::clock-position', show);

    const row = new Adw.ActionRow({title: 'Position', subtitle: 'Click where the clock should sit on the screen'});
    row.add_suffix(grid);
    return row;
}

const WEIGHTS = [
    ['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'],
    ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Heavy'],
];

function weightRow(settings, key, title) {
    return comboRow(settings, key, title, '', WEIGHTS,
        () => String(Math.round(settings.get_int(key) / 100) * 100),
        value => settings.set_int(key, Number(value)));
}

function fontRow(settings) {
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog(), level: Gtk.FontLevel.FAMILY, valign: Gtk.Align.CENTER,
    });
    const show = () => {
        const family = settings.get_string('clock-font');
        if (family && button.font_desc?.get_family() !== family)
            button.font_desc = Pango.FontDescription.from_string(family);
    };
    show();
    watch(button, settings, 'changed::clock-font', show);
    button.connect('notify::font-desc', () => {
        const family = button.font_desc?.get_family() ?? '';
        if (family && family !== settings.get_string('clock-font'))
            settings.set_string('clock-font', family);
    });
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
        tooltip_text: 'Use the system font',
    });
    reset.connect('clicked', () => settings.reset('clock-font'));
    const row = new Adw.ActionRow({title: 'Font'});
    const sub = () => (row.subtitle = settings.get_string('clock-font') || 'System font');
    sub();
    watch(row, settings, 'changed::clock-font', sub);
    row.add_suffix(button);
    row.add_suffix(reset);
    return row;
}

function clockPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Clock', icon_name: 'preferences-system-time-symbolic'});

    const place = new Adw.PreferencesGroup({title: 'Clock'});
    place.add(switchRow(settings, 'show-clock', 'Show the time'));
    place.add(positionPicker(settings));
    place.add(spinRow(settings, 'clock-margin', 'Distance from the edges', 'Pixels', 4));
    place.add(comboRow(settings, 'clock-style', 'Layout', '',
        [['inline', 'Hours and minutes side by side'], ['stacked', 'Hours above minutes']]));
    place.add(comboRow(settings, 'clock-format', 'Time format', '',
        [['system', 'Same as the system'], ['24h', '24-hour'], ['12h', '12-hour']]));
    place.add(switchRow(settings, 'clock-seconds', 'Show seconds'));
    place.add(switchRow(settings, 'keep-clock', 'Keep visible while typing the password',
        'Only when the clock is clear of the password prompt'));
    page.add(place);

    const type = new Adw.PreferencesGroup({title: 'Lettering'});
    type.add(spinRow(settings, 'clock-size', 'Clock size', 'Pixels', 4));
    type.add(weightRow(settings, 'clock-weight', 'Clock weight'));
    type.add(fontRow(settings));
    type.add(colorRow(settings, 'clock-color', 'Color', 'For the clock, the date and your text'));
    type.add(sliderRow(settings, 'clock-opacity', 'Opacity'));
    type.add(switchRow(settings, 'clock-shadow', 'Soft shadow', 'Helps on bright or busy pictures'));
    page.add(type);

    const date = new Adw.PreferencesGroup({title: 'Date'});
    date.add(switchRow(settings, 'show-date', 'Show the date'));
    const now = GLib.DateTime.new_now_local();
    date.add(comboRow(settings, 'date-format', 'Format', '', [
        ['long', now.format('%A, %B %-d')], ['short', now.format('%a %-d %b')],
        ['full', now.format('%A %-d %B %Y')], ['numeric', now.format('%x')], ['custom', 'Custom']]));
    const custom = entryRow(settings, 'date-custom', 'Custom format, such as %A, %-d %B');
    date.add(dependsOn(settings, custom, () => settings.get_string('date-format') === 'custom'));
    date.add(spinRow(settings, 'date-size', 'Size', 'Pixels', 1));
    date.add(weightRow(settings, 'date-weight', 'Weight'));
    date.add(switchRow(settings, 'date-above', 'Above the time'));
    date.add(switchRow(settings, 'date-uppercase', 'In capitals'));
    page.add(date);

    const text = new Adw.PreferencesGroup({
        title: 'Your own text', description: 'A line under the date, such as a name or a number to call if found.',
    });
    text.add(entryRow(settings, 'message-text', 'Text'));
    text.add(spinRow(settings, 'message-size', 'Size', 'Pixels', 1));
    text.add(switchRow(settings, 'show-hint', 'Show the unlock hint', '“Click or press a key to unlock”'));
    page.add(text);
    return page;
}

// ---- Password prompt -----------------------------------------------------------------

function promptPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Password', icon_name: 'dialog-password-symbolic'});

    const reach = new Adw.PreferencesGroup({title: 'Getting to the password'});
    reach.add(switchRow(settings, 'space-to-unlock', 'Press Space to continue',
        'The lock screen stays on the clock until Space or Enter is pressed. Off: any key or a click works'));
    page.add(reach);

    const you = new Adw.PreferencesGroup({
        title: 'You', description: 'Use the Password button next to the preview to see these.',
    });
    you.add(switchRow(settings, 'show-avatar', 'Show your picture'));
    you.add(dependsOn(settings, spinRow(settings, 'avatar-size', 'Picture size', 'Pixels', 8),
        () => settings.get_boolean('show-avatar')));
    you.add(switchRow(settings, 'show-username', 'Show your name'));
    page.add(you);

    const field = new Adw.PreferencesGroup({title: 'Password field'});
    field.add(spinRow(settings, 'entry-radius', 'Corner radius', 'Pixels', 1));
    field.add(colorRow(settings, 'entry-color', 'Field color'));
    field.add(sliderRow(settings, 'entry-opacity', 'Field opacity'));
    field.add(colorRow(settings, 'entry-text-color', 'Text color', 'Also used for your name'));
    page.add(field);

    const bar = new Adw.PreferencesGroup({title: 'Top bar'});
    bar.add(switchRow(settings, 'hide-panel', 'Hide the top bar',
        'Also hides its accessibility, keyboard and power menus while locked'));
    page.add(bar);
    return page;
}

// ---- Locking (system settings) ------------------------------------------------------------

// A Gio.Settings for a schema, or null if this system does not have it.
function systemSettings(schemaId, key) {
    const schema = Gio.SettingsSchemaSource.get_default().lookup(schemaId, true);
    return schema?.has_key(key) ? new Gio.Settings({schema_id: schemaId}) : null;
}

function delayRow(settings, key, title, subtitle, options) {
    const read = () => {
        const value = settings.get_uint(key);
        // Show the nearest choice for values set elsewhere.
        return String(options.reduce((best, [v]) =>
            Math.abs(Number(v) - value) < Math.abs(Number(best) - value) ? v : best, options[0][0]));
    };
    return comboRow(settings, key, title, subtitle, options, read, value => settings.set_uint(key, Number(value)));
}

function lockingPage() {
    const page = new Adw.PreferencesPage({title: 'Locking', icon_name: 'system-lock-screen-symbolic'});

    const now = new Adw.PreferencesGroup({title: 'Try it'});
    now.add(actionRow('Lock the screen now', 'See your lock screen for real', 'system-lock-screen-symbolic', lockNow));
    page.add(now);

    const when = new Adw.PreferencesGroup({
        title: 'When the screen locks',
        description: 'These are the system’s own settings, the same ones as in Settings.',
    });
    const session = systemSettings('org.gnome.desktop.session', 'idle-delay');
    if (session) {
        when.add(delayRow(session, 'idle-delay', 'Blank the screen after', 'Of not using the computer', [
            ['60', '1 minute'], ['120', '2 minutes'], ['180', '3 minutes'], ['300', '5 minutes'],
            ['600', '10 minutes'], ['900', '15 minutes'], ['1800', '30 minutes'], ['0', 'Never']]));
    }
    const saver = systemSettings('org.gnome.desktop.screensaver', 'lock-enabled');
    if (saver) {
        when.add(switchRow(saver, 'lock-enabled', 'Lock automatically', 'When the screen blanks'));
        when.add(delayRow(saver, 'lock-delay', 'Lock after the screen blanks', '', [
            ['0', 'Straight away'], ['30', '30 seconds'], ['60', '1 minute'], ['120', '2 minutes'],
            ['300', '5 minutes'], ['1800', '30 minutes'], ['3600', '1 hour']]));
    }
    const suspend = systemSettings('org.gnome.desktop.screensaver', 'ubuntu-lock-on-suspend');
    if (suspend)
        when.add(switchRow(suspend, 'ubuntu-lock-on-suspend', 'Lock when the computer sleeps'));
    page.add(when);

    const notes = systemSettings('org.gnome.desktop.notifications', 'show-in-lock-screen');
    if (notes) {
        const privacy = new Adw.PreferencesGroup({title: 'Privacy'});
        privacy.add(switchRow(notes, 'show-in-lock-screen', 'Notifications on the lock screen',
            'Off keeps messages from showing while locked'));
        page.add(privacy);
    }

    const about = new Adw.PreferencesGroup({title: 'Good to know'});
    about.add(new Adw.ActionRow({
        title: 'The sign-in screen stays as it is',
        subtitle: 'Den changes the screen you see after locking. The screen shown when the ' +
            'computer starts belongs to the system and is not changed.',
    }));
    page.add(about);
    return page;
}

export default class StoopPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        applySedge(window, `${this.path}/sedge`);
        window.set_title('Den');
        const settings = this.getSettings();
        window.set_default_size(820, 940);

        // One view for the whole window, so the preview stays in place above
        // the pages while they scroll.
        const stack = new Adw.ViewStack({vexpand: true});
        const pages = [
            ['presets', presetsPage(window, settings)],
            ['wallpaper', wallpaperPage(window, settings)],
            ['clock', clockPage(settings)],
            ['password', promptPage(settings)],
            ['locking', lockingPage()],
        ];
        for (const [id, page] of pages)
            stack.add_titled_with_icon(page, id, page.title, page.icon_name);

        const header = new Adw.HeaderBar({
            title_widget: new Adw.ViewSwitcher({stack, policy: Adw.ViewSwitcherPolicy.WIDE}),
        });
        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(previewPanel(settings));
        content.append(new Gtk.Separator());
        content.append(stack);

        const view = new Adw.ToolbarView({content});
        view.add_top_bar(header);
        toastOverlay = new Adw.ToastOverlay({child: view});
        window.connect('close-request', () => {
            toastOverlay = null;
            return false;
        });
        // The dialog insists on at least one page of its own, even though
        // our view takes its place.
        window.add(new Adw.PreferencesPage());
        window.set_content(toastOverlay);
    }
}
