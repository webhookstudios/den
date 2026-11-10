// Shared by the extension and the settings window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Settings that are yours rather than part of a look; presets leave them alone.
export const GENERAL_KEYS = [
    'enabled', 'current-preset', 'user-presets',
    'wallpaper-source', 'wallpaper-path', 'wallpaper-color', 'message-text', 'space-to-unlock',
];

export function readTyped(settings, key) {
    const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
    switch (type) {
    case 'b': return settings.get_boolean(key);
    case 'i': return settings.get_int(key);
    case 'd': return settings.get_double(key);
    case 's': return settings.get_string(key);
    default: return null;
    }
}

function writeTyped(settings, key, value) {
    const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
    if (type === 'b')
        settings.set_boolean(key, value);
    else if (type === 'i')
        settings.set_int(key, Math.round(value));
    else if (type === 'd')
        settings.set_double(key, value);
    else if (type === 's')
        settings.set_string(key, value);
}

export function designKeys(settings) {
    return settings.settings_schema.list_keys().filter(k => !GENERAL_KEYS.includes(k));
}

// Every key of the look, as a plain object.
export function snapshot(settings) {
    const out = {};
    for (const key of designKeys(settings))
        out[key] = readTyped(settings, key);
    return out;
}

// Makes the settings match a preset. Keys the preset does not name go back
// to their defaults, so a preset always means the same look.
export function applyValues(settings, values) {
    for (const key of designKeys(settings)) {
        if (key in values)
            writeTyped(settings, key, values[key]);
        else
            settings.reset(key);
    }
}

// Checks an imported preset against the schema; returns only the values
// with the right type, inside the allowed range or choices.
export function sanitize(settings, values) {
    const clean = {};
    if (typeof values !== 'object' || values === null)
        return clean;
    const schema = settings.settings_schema;
    for (const key of designKeys(settings)) {
        if (!(key in values))
            continue;
        const info = schema.get_key(key);
        const type = info.get_value_type().dup_string();
        const value = values[key];
        let variant = null;
        if (type === 'b' && typeof value === 'boolean')
            variant = GLib.Variant.new_boolean(value);
        else if (type === 'i' && Number.isFinite(value))
            variant = GLib.Variant.new_int32(Math.round(value));
        else if (type === 'd' && Number.isFinite(value))
            variant = GLib.Variant.new_double(value);
        else if (type === 's' && typeof value === 'string')
            variant = GLib.Variant.new_string(value);
        if (variant && info.range_check(variant))
            clean[key] = type === 'i' ? Math.round(value) : value;
    }
    return clean;
}

// ---- Time and date text ------------------------------------------------------

const DATE_FORMATS = {
    long: '%A, %B %-d',
    short: '%a %-d %b',
    full: '%A %-d %B %Y',
    numeric: '%x',
};

function use24h(get) {
    const format = get('clock-format');
    if (format !== 'system')
        return format === '24h';
    try {
        return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('clock-format') !== '12h';
    } catch {
        return true;
    }
}

// What the clock shows right now: {lines: [...], date, message}.
// `lines` is one line, or hours and minutes apart for the stacked style.
export function clockText(get, now = GLib.DateTime.new_now_local()) {
    const h24 = use24h(get);
    const hour = now.format(h24 ? '%H' : '%-I');
    const minute = now.format('%M');
    const second = get('clock-seconds') ? now.format('%S') : null;
    let lines;
    if (get('clock-style') === 'stacked') {
        lines = [hour.padStart(2, '0'), minute];
        if (second)
            lines.push(second);
    } else {
        let text = `${hour}:${minute}`;
        if (second)
            text += `:${second}`;
        if (!h24)
            text += now.format(' %p');
        lines = [text.trim()];
    }

    let date = '';
    if (get('show-date')) {
        const key = get('date-format');
        const format = key === 'custom' ? get('date-custom') : DATE_FORMATS[key];
        date = now.format(format || DATE_FORMATS.long) ?? '';
        if (get('date-uppercase'))
            date = date.toUpperCase();
    }
    return {lines, date, message: get('message-text').trim()};
}

// Where a clock position puts things: [horizontal, vertical], each one of
// 'start', 'center', 'end'.
export function anchor(position) {
    const horizontal = position.includes('left') ? 'start' : position.includes('right') ? 'end' : 'center';
    const vertical = position.startsWith('top') ? 'start' : position.startsWith('bottom') ? 'end' : 'center';
    return [horizontal, vertical];
}

// The image file behind the lock screen, or null for none (a plain color).
export function wallpaperFile(get) {
    const source = get('wallpaper-source');
    if (source === 'color')
        return null;
    if (source === 'image') {
        const path = get('wallpaper-path');
        return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }
    try {
        const dark = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('color-scheme') === 'prefer-dark';
        const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        const uri = background.get_string(dark ? 'picture-uri-dark' : 'picture-uri');
        const path = uri.startsWith('file://') ? Gio.File.new_for_uri(uri).get_path() : uri;
        return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    } catch {
        return null;
    }
}
