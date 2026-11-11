import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {anchor, clockText, readTyped, wallpaperFile} from './model.js';
import {buildCss} from './css.js';

const MARKER = 'lm-on';
const ALIGN = {
    start: Clutter.ActorAlign.START,
    center: Clutter.ActorAlign.CENTER,
    end: Clutter.ActorAlign.END,
};

function rgba(hex, alpha) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

// Everything we add to, or change on, one unlock dialog. The shell makes a
// new dialog each time the screen locks and destroys it on unlock.
//
// Nothing here takes input: every actor we add is non-reactive, so the
// password prompt keeps working exactly as before.
class DialogDecor {
    constructor(dialog, settings) {
        this._dialog = dialog;
        this._settings = settings;
        this._get = key => readTyped(settings, key);
        this._extras = [];          // actors we added to the background widgets
        this._hidden = [];          // stock actors we hid
        this._signals = [];
        this._panelWasVisible = null;

        this._buildLayer();
        this._patchShowPrompt();
        this._connect(dialog, 'key-press-event', (_actor, event) => this._onKey(event));

        this._connect(dialog._backgroundGroup, 'child-added', () => this._queueBackgrounds());
        this._connect(dialog._adjustment, 'notify::value', () => this._syncProgress());
        this._connect(dialog._promptBox, 'child-added', () => this._queuePrompt());
        this._connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor',
            () => this._queueBackgrounds());

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateText();
            return GLib.SOURCE_CONTINUE;
        });
        this.refresh();
    }

    _connect(obj, signal, callback) {
        if (obj)
            this._signals.push([obj, obj.connect(signal, callback)]);
    }

    // Our own clock, date, message and hint, on a layer over the background.
    _buildLayer() {
        this._layer = new St.Widget({
            name: 'lm-layer', layout_manager: new Clutter.BinLayout(), reactive: false,
        });
        this._layer.add_constraint(new Layout.MonitorConstraint({primary: true}));

        this._clockBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, reactive: false,
        });
        this._clockBox.set_pivot_point(0.5, 0.5);
        // One label per line of the time, so stacked digits are separate
        // actors that can never draw over each other.
        this._time = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: false});
        this._timeLabels = [];
        this._date = new St.Label({style_class: 'lm-date'});
        this._message = new St.Label({style_class: 'lm-message'});
        this._layer.add_child(this._clockBox);

        this._hint = new St.Label({
            style_class: 'lm-hint', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
            text: 'Click or press a key to unlock',
        });
        this._layer.add_child(this._hint);

        // Over the background, under the prompt and notifications.
        this._dialog.insert_child_above(this._layer, this._dialog._backgroundGroup);
    }

    refresh() {
        const on = this._get('enabled');
        const dialog = this._dialog;
        if (on)
            dialog.add_style_class_name(MARKER);
        else
            dialog.remove_style_class_name(MARKER);

        // The stock clock gives way to ours.
        const stock = dialog._clock;
        for (const label of [stock?._time, stock?._date, stock?._hint]) {
            if (!label)
                continue;
            if (on && label.visible) {
                label.hide();
                this._hidden.push(label);
            }
        }
        if (!on)
            this._restoreHidden();

        this._hint.text = this._get('space-to-unlock')
            ? 'Press Space to unlock' : stock?._hint?.text || 'Click or press a key to unlock';
        this._layer.visible = on;
        if (on)
            this._layoutClock();
        this._applyBackgrounds();
        this._applyPrompt();
        this._applyPanel(on && this._get('hide-panel'));
        this._syncProgress();
    }

    _restoreHidden() {
        for (const actor of this._hidden)
            actor.show();
        this._hidden = [];
    }

    // Space to continue ----------------------------------------------------------

    _spaceMode() {
        return this._get('enabled') && this._get('space-to-unlock');
    }

    // In this mode the shell's own "show the password prompt" is held back
    // unless we asked for it, which covers clicks and scrolling as well.
    _patchShowPrompt() {
        const dialog = this._dialog;
        const original = dialog._showPrompt.bind(dialog);
        this._allowPrompt = false;
        dialog._showPrompt = () => {
            if (this._spaceMode() && !this._allowPrompt)
                return;
            original();
        };
    }

    _onKey(event) {
        if (!this._spaceMode())
            return Clutter.EVENT_PROPAGATE;
        const dialog = this._dialog;
        // Once the prompt is up, every key goes to the password field.
        if (dialog._activePage === dialog._promptBox || dialog._promptBox?.visible)
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_space || key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._allowPrompt = true;
            try {
                dialog._showPrompt();
            } finally {
                this._allowPrompt = false;
            }
        }
        // Any other key does nothing on the clock screen; the shell would
        // otherwise treat it as the first letter of the password.
        return Clutter.EVENT_STOP;
    }

    // Clock ------------------------------------------------------------------

    _layoutClock() {
        const get = this._get;
        const [horizontal, vertical] = anchor(get('clock-position'));
        const monitor = Main.layoutManager.primaryMonitor;
        const margin = get('clock-margin');
        const panel = Main.layoutManager.panelBox?.height ?? 0;

        const box = this._clockBox;
        box.remove_all_children();
        const parts = get('date-above')
            ? [this._date, this._time, this._message]
            : [this._time, this._date, this._message];
        for (const part of parts)
            box.add_child(part);

        box.x_align = ALIGN[horizontal];
        box.y_align = vertical === 'center' ? ALIGN.start : ALIGN[vertical];
        // Margins go through the style: St resets plain actor margins
        // whenever it restyles a widget.
        const top = vertical === 'center'
            // The middle position matches where the shell puts its own
            // clock: a third of the way down.
            ? Math.round((monitor?.height ?? 900) / 3)
            : vertical === 'start' ? margin + panel : 0;
        box.set_style(
            `margin-left: ${horizontal === 'start' ? margin : 0}px; ` +
            `margin-right: ${horizontal === 'end' ? margin : 0}px; ` +
            `margin-top: ${top}px; ` +
            `margin-bottom: ${vertical === 'end' ? margin : 0}px; ` +
            'spacing: 6px;');
        for (const actor of [this._time, this._date, this._message])
            actor.x_align = ALIGN[horizontal];

        this._time.visible = get('show-clock');
        this._hint.visible = get('show-hint');
        this._hint.set_style(`margin-bottom: ${Math.round((monitor?.height ?? 900) * 0.14)}px;`);
        this._updateText();
    }

    _updateText() {
        const get = this._get;
        if (!get('enabled'))
            return;
        const {lines, date, message} = clockText(get);
        const [horizontal] = anchor(get('clock-position'));

        while (this._timeLabels.length > lines.length)
            this._timeLabels.pop().destroy();
        while (this._timeLabels.length < lines.length) {
            const label = new St.Label({style_class: 'lm-time'});
            this._time.add_child(label);
            this._timeLabels.push(label);
        }
        lines.forEach((text, i) => {
            const label = this._timeLabels[i];
            if (label.text !== text)
                label.text = text;
            label.x_align = ALIGN[horizontal];
        });

        if (this._date.text !== date)
            this._date.text = date;
        this._date.visible = date !== '';
        if (this._message.text !== message)
            this._message.text = message;
        this._message.visible = message !== '';
    }

    // Follows the shell's own fade between the clock and the password prompt.
    _syncProgress() {
        const progress = Math.max(0, Math.min(1, this._dialog._adjustment?.value ?? 0));
        // The clock can stay up while the password is typed, unless it
        // would sit on top of the prompt.
        const keep = this._get('keep-clock') && !this._overlapsPrompt();
        this._clockBox.set({
            opacity: keep ? 255 : Math.round(255 * (1 - progress)),
            translation_y: keep ? 0 : -60 * progress,
        });
        this._hint.opacity = Math.round(255 * (1 - progress));
    }

    _overlapsPrompt() {
        const stack = this._dialog._stack;
        if (!stack || !this._clockBox.has_allocation() || !stack.has_allocation())
            return true;
        const rect = actor => {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            return [x, y, x + w, y + h];
        };
        // Measure the clock where it rests, not where a fade has moved it.
        const [ax1, ay1, ax2, ay2] = rect(this._clockBox);
        const shift = this._clockBox.translation_y;
        const [bx1, by1, bx2, by2] = rect(stack);
        const gap = 24;
        return ax1 < bx2 + gap && ax2 > bx1 - gap && ay1 - shift < by2 + gap && ay2 - shift > by1 - gap;
    }

    // Background -------------------------------------------------------------

    _queueBackgrounds() {
        if (this._backgroundsId)
            return;
        this._backgroundsId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._backgroundsId = 0;
            this._applyBackgrounds();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyBackgrounds() {
        for (const actor of this._extras)
            actor.destroy();
        this._extras = [];

        const get = this._get;
        const on = get('enabled');
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const source = get('wallpaper-source');
        const file = on ? wallpaperFile(get) : null;

        for (const widget of this._dialog._backgroundGroup?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            // Off: the shell's own values (see unlockDialog.js).
            effect?.set(on
                ? {brightness: get('brightness'), radius: get('blur') * scale}
                : {brightness: 0.65, radius: 90 * scale});
            if (!on)
                continue;

            const cover = style => {
                const actor = new St.Widget({
                    width: widget.width, height: widget.height, reactive: false, style,
                });
                widget.add_child(actor);
                this._extras.push(actor);
            };
            // These sit inside the blurred widget, so the picture is blurred
            // and dimmed just like the desktop wallpaper would be.
            if (source === 'color') {
                cover(`background-color: ${rgba(get('wallpaper-color'), 1)};`);
            } else if (source === 'image' && file) {
                const uri = Gio.File.new_for_path(file).get_uri().replace(/"/g, '%22');
                cover(`background-image: url("${uri}"); background-size: cover; background-position: center;`);
            }
            if (get('tint-opacity') > 0)
                cover(`background-color: ${rgba(get('tint-color'), get('tint-opacity'))};`);
            if (get('shade') > 0) {
                cover('background-gradient-direction: vertical; ' +
                    'background-gradient-start: rgba(0, 0, 0, 0); ' +
                    `background-gradient-end: rgba(0, 0, 0, ${get('shade').toFixed(3)});`);
            }
        }
    }

    // Password prompt -------------------------------------------------------------

    _queuePrompt() {
        if (this._promptId)
            return;
        this._promptId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._promptId = 0;
            this._applyPrompt();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The picture and name live deep inside the prompt, which the shell
    // builds only when it is first shown; find them by their style class.
    _applyPrompt() {
        const on = this._get('enabled');
        const visit = actor => {
            const classes = actor.style_class ?? '';
            if (/\buser-icon\b/.test(classes))
                actor.visible = !on || this._get('show-avatar');
            else if (/\buser-widget-label\b/.test(classes))
                actor.visible = !on || this._get('show-username');
            for (const child of actor.get_children())
                visit(child);
        };
        if (this._dialog._promptBox)
            visit(this._dialog._promptBox);
    }

    // Top bar ----------------------------------------------------------------------

    _applyPanel(hide) {
        const panel = Main.layoutManager.panelBox;
        if (!panel)
            return;
        if (hide && this._panelWasVisible === null) {
            this._panelWasVisible = panel.visible;
            panel.visible = false;
        } else if (!hide && this._panelWasVisible !== null) {
            panel.visible = this._panelWasVisible;
            this._panelWasVisible = null;
        }
    }

    // Puts everything back. `dialogGone` is true when the shell is already
    // destroying the dialog, and its actors must not be touched.
    destroy(dialogGone = false) {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        if (this._backgroundsId)
            GLib.source_remove(this._backgroundsId);
        if (this._promptId)
            GLib.source_remove(this._promptId);
        this._tickId = this._backgroundsId = this._promptId = 0;
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._applyPanel(false);
        if (dialogGone)
            return;
        delete this._dialog._showPrompt;

        this._dialog.remove_style_class_name(MARKER);
        this._restoreHidden();
        for (const actor of this._extras)
            actor.destroy();
        this._extras = [];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const widget of this._dialog._backgroundGroup?.get_children() ?? [])
            widget.get_effect('blur')?.set({brightness: 0.65, radius: 90 * scale});
        this._layer.destroy();
    }
}

export default class DenExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._decors = new Map();
        this._pending = new Map();
        this._cssFile = null;
        this._cssSerial = 0;
        this._cssDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'den']);

        this._settingsId = this._settings.connect('changed', () => this._queue());
        // The desktop wallpaper and clock format can change while locked too.
        this._group = Main.screenShield?._lockDialogGroup ?? null;
        if (this._group) {
            this._groupId = this._group.connect('child-added', (_group, child) => this._adopt(child));
            for (const child of this._group.get_children())
                this._adopt(child);
        } else {
            console.warn('Den: this shell has no lock screen to restyle.');
        }
        this._sync();
    }

    disable() {
        if (this._queueId) {
            GLib.source_remove(this._queueId);
            this._queueId = 0;
        }
        for (const id of this._pending.values())
            GLib.source_remove(id);
        this._pending = null;
        if (this._group)
            this._group.disconnect(this._groupId);
        this._group = null;
        this._settings.disconnect(this._settingsId);

        for (const [dialog, entry] of this._decors) {
            dialog.disconnect(entry.destroyId);
            entry.decor.destroy();
        }
        this._decors = null;
        this._unloadCss();
        this._settings = null;
    }

    _queue() {
        if (this._queueId)
            return;
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            this._queueId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (this._settings.get_boolean('enabled'))
            this._loadCss();
        else
            this._unloadCss();
        for (const entry of this._decors.values())
            this._guard(() => entry.decor.refresh());
    }

    // A mistake in here must never get in the way of unlocking.
    _guard(callback) {
        try {
            callback();
        } catch (e) {
            console.error(`Den: ${e.message}\n${e.stack}`);
        }
    }

    _loadCss() {
        const css = buildCss(key => readTyped(this._settings, key));
        GLib.mkdir_with_parents(this._cssDir, 0o755);
        // A new file name each time, because the theme keeps files it has read.
        const file = Gio.File.new_for_path(GLib.build_filenamev(
            [this._cssDir, `style-${GLib.get_monotonic_time()}-${this._cssSerial++}.css`]));
        file.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.NONE, null);

        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const previous = this._cssFile;
        theme.load_stylesheet(file);
        this._cssFile = file;
        if (previous) {
            theme.unload_stylesheet(previous);
            try { previous.delete(null); } catch { /* already gone */ }
        }
    }

    _unloadCss() {
        if (!this._cssFile)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        try { this._cssFile.delete(null); } catch { /* already gone */ }
        this._cssFile = null;
    }

    // The dialog adds itself to the stage before it has built its parts, so
    // adopting waits until the shell is idle and the dialog is complete.
    _adopt(dialog) {
        if (!dialog.has_style_class_name?.('unlock-dialog') ||
            this._decors.has(dialog) || this._pending.has(dialog))
            return;
        const ready = () => dialog._clock && dialog._backgroundGroup && dialog._adjustment && dialog._promptBox;
        if (ready()) {
            this._adoptNow(dialog);
            return;
        }
        const gone = dialog.connect('destroy', () => {
            const id = this._pending?.get(dialog);
            if (id) {
                GLib.source_remove(id);
                this._pending.delete(dialog);
            }
        });
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pending.delete(dialog);
            dialog.disconnect(gone);
            if (ready())
                this._adoptNow(dialog);
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(dialog, id);
    }

    _adoptNow(dialog) {
        this._guard(() => {
            const decor = new DialogDecor(dialog, this._settings);
            const destroyId = dialog.connect('destroy', () => {
                this._decors?.delete(dialog);
                this._guard(() => decor.destroy(true));
            });
            this._decors.set(dialog, {decor, destroyId});
        });
    }
}
