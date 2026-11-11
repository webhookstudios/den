// Finds pictures to offer as lock screen wallpapers.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const TYPES = /\.(jpe?g|png|webp)$/i;
const LIMIT = 90;

function scan(dir, depth, out) {
    let children;
    try {
        children = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return;
    }
    const names = [];
    let info;
    while ((info = children.next_file(null)))
        names.push([info.get_name(), info.get_file_type()]);
    names.sort(([a], [b]) => a.localeCompare(b));
    for (const [name, type] of names) {
        if (out.length >= LIMIT)
            return;
        const path = GLib.build_filenamev([dir, name]);
        if (type === Gio.FileType.DIRECTORY) {
            if (depth > 0 && !name.startsWith('.'))
                scan(path, depth - 1, out);
        } else if (TYPES.test(name) && !out.includes(path)) {
            out.push(path);
        }
    }
}

// Picture files from the usual wallpaper folders, yours first.
export function findWallpapers() {
    const home = GLib.get_home_dir();
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    const out = [];
    scan(GLib.build_filenamev([GLib.get_user_data_dir(), 'backgrounds']), 1, out);
    if (pictures) {
        scan(GLib.build_filenamev([pictures, 'Wallpapers']), 1, out);
        scan(GLib.build_filenamev([pictures, 'Backgrounds']), 1, out);
    }
    scan(GLib.build_filenamev([home, '.local', 'share', 'wallpapers']), 1, out);
    scan('/usr/share/backgrounds', 2, out);
    return out;
}
