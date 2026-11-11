// A drawing of the lock screen for the settings window: the live preview
// and the picture on every preset card. It follows the same layout rules as
// the extension, so what you see is close to what you get. The blur is an
// approximation.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {anchor, clockText, wallpaperFile} from './model.js';

// The pretend screen everything is laid out on, in pixels.
const SCREEN_W = 1920;
const SCREEN_H = 1200;
const PANEL = 32;

function rgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex ?? '');
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

function color(cr, hex, alpha = 1) {
    const [r, g, b] = rgb(hex);
    cr.setSourceRGBA(r, g, b, alpha);
}

function roundRect(cr, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Small copies of wallpapers, kept so redraws while dragging a slider are
// instant. Keyed by file; blurred versions by file and blur step.
const small = new Map();
const blurred = new Map();

function smallPixbuf(path) {
    if (!small.has(path)) {
        let pixbuf = null;
        try {
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 480, 300, true);
        } catch {
            // Not an image we can read: fall back to a plain background.
        }
        if (small.size > 40)
            small.clear();
        small.set(path, pixbuf);
    }
    return small.get(path);
}

// Shrinking a picture and stretching it back is a cheap, soft blur.
function blurredPixbuf(path, blur) {
    const base = smallPixbuf(path);
    if (!base)
        return null;
    const step = Math.round(blur / 10);
    if (step === 0)
        return base;
    const key = `${path}|${step}`;
    if (!blurred.has(key)) {
        const factor = 1 + step * 1.6;
        const w = Math.max(4, Math.round(base.get_width() / factor));
        const h = Math.max(3, Math.round(base.get_height() / factor));
        if (blurred.size > 60)
            blurred.clear();
        blurred.set(key, base.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR));
    }
    return blurred.get(key);
}

function textLayout(cr, text, {family, size, weight, spacing = 1, align = 'center'}) {
    const layout = PangoCairo.create_layout(cr);
    const desc = new Pango.FontDescription();
    desc.set_family(family || 'Ubuntu Sans, Ubuntu, Cantarell, Sans');
    desc.set_absolute_size(size * Pango.SCALE);
    desc.set_weight(weight);
    layout.set_font_description(desc);
    layout.set_alignment({start: Pango.Alignment.LEFT, center: Pango.Alignment.CENTER, end: Pango.Alignment.RIGHT}[align]);
    if (spacing !== 1)
        layout.set_line_spacing(spacing);
    layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    return {layout, width: logical.width, height: logical.height};
}

// Options: `prompt` draws the password prompt instead of the resting clock.
export function drawLock(cr, width, height, get, {prompt = false} = {}) {
    const scale = Math.min(width / SCREEN_W, height / SCREEN_H);
    const W = SCREEN_W;
    const H = SCREEN_H;
    cr.save();
    cr.translate((width - W * scale) / 2, (height - H * scale) / 2);
    cr.scale(scale, scale);
    roundRect(cr, 0, 0, W, H, 36);
    cr.clip();

    // Background: picture or color, then brightness, tint and shade.
    const source = get('wallpaper-source');
    const file = wallpaperFile(get);
    const pixbuf = file ? blurredPixbuf(file, get('blur')) : null;
    if (pixbuf) {
        const k = Math.max(W / pixbuf.get_width(), H / pixbuf.get_height());
        cr.save();
        cr.translate((W - pixbuf.get_width() * k) / 2, (H - pixbuf.get_height() * k) / 2);
        cr.scale(k, k);
        Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
        cr.paint();
        cr.restore();
    } else {
        color(cr, source === 'color' ? get('wallpaper-color') : '#3a2140');
        cr.paint();
    }
    cr.setSourceRGBA(0, 0, 0, 1 - get('brightness'));
    cr.paint();
    if (get('tint-opacity') > 0) {
        color(cr, get('tint-color'), get('tint-opacity'));
        cr.paint();
    }
    if (get('shade') > 0) {
        const gradient = new Cairo.LinearGradient(0, 0, 0, H);
        gradient.addColorStopRGBA(0, 0, 0, 0, 0);
        gradient.addColorStopRGBA(1, 0, 0, 0, get('shade'));
        cr.setSource(gradient);
        cr.paint();
    }

    // Top bar: a few status dots on the right.
    if (!get('hide-panel')) {
        cr.setSourceRGBA(1, 1, 1, 0.85);
        for (let i = 0; i < 3; i++) {
            cr.arc(W - 40 - i * 34, PANEL / 2 + 4, 8, 0, 2 * Math.PI);
            cr.fill();
        }
    }

    // Clock, date and message.
    const [horizontal, vertical] = anchor(get('clock-position'));
    const margin = get('clock-margin');
    const {lines, date, message} = clockText(get);
    const family = get('clock-font').trim();
    const parts = [];
    if (get('show-clock')) {
        parts.push(['time', textLayout(cr, lines.join('\n'), {
            family, size: get('clock-size'), weight: get('clock-weight'),
            align: horizontal,
        })]);
    }
    if (date) {
        const entry = ['date', textLayout(cr, date, {
            family, size: get('date-size'), weight: get('date-weight'), align: horizontal,
        })];
        if (get('date-above'))
            parts.unshift(entry);
        else
            parts.push(entry);
    }
    if (message)
        parts.push(['message', textLayout(cr, message, {family, size: get('message-size'), weight: 400, align: horizontal})]);

    const gap = 6;
    const boxW = Math.max(0, ...parts.map(([, p]) => p.width));
    const boxH = parts.reduce((sum, [, p]) => sum + p.height, 0) + gap * Math.max(0, parts.length - 1);
    const boxX = horizontal === 'start' ? margin : horizontal === 'end' ? W - margin - boxW : (W - boxW) / 2;
    const boxY = vertical === 'center' ? H / 3
        : vertical === 'start' ? margin + PANEL : H - margin - boxH;

    // The prompt sits a third of the way down, in the middle.
    const avatar = get('show-avatar') ? get('avatar-size') : 0;
    const promptH = avatar + (get('show-username') ? 70 : 0) + 60;
    const promptW = 370;
    const promptX = (W - promptW) / 2;
    const promptY = H / 3;
    const overlaps = boxX < promptX + promptW + 24 && boxX + boxW > promptX - 24 &&
        boxY < promptY + promptH + 24 && boxY + boxH > promptY - 24;
    const clockAlpha = !prompt || (get('keep-clock') && !overlaps) ? get('clock-opacity') : 0;

    if (clockAlpha > 0) {
        let y = boxY;
        for (const [, part] of parts) {
            const x = horizontal === 'start' ? boxX : horizontal === 'end' ? boxX + boxW - part.width
                : boxX + (boxW - part.width) / 2;
            if (get('clock-shadow')) {
                cr.setSourceRGBA(0, 0, 0, 0.35 * clockAlpha);
                cr.moveTo(x, y + 4);
                PangoCairo.show_layout(cr, part.layout);
            }
            color(cr, get('clock-color'), clockAlpha);
            cr.moveTo(x, y);
            PangoCairo.show_layout(cr, part.layout);
            y += part.height + gap;
        }
    }

    if (prompt) {
        const cx = W / 2;
        let y = promptY;
        if (avatar) {
            cr.setSourceRGBA(1, 1, 1, 0.16);
            cr.arc(cx, y + avatar / 2, avatar / 2, 0, 2 * Math.PI);
            cr.fill();
            color(cr, get('entry-text-color'), 0.9);
            cr.arc(cx, y + avatar * 0.4, avatar * 0.16, 0, 2 * Math.PI);
            cr.fill();
            cr.arc(cx, y + avatar * 0.86, avatar * 0.3, Math.PI, 2 * Math.PI);
            cr.fill();
            y += avatar + 24;
        }
        if (get('show-username')) {
            const name = textLayout(cr, GLib.get_real_name() || GLib.get_user_name(), {size: 27, weight: 400});
            color(cr, get('entry-text-color'));
            cr.moveTo(cx - name.width / 2, y);
            PangoCairo.show_layout(cr, name.layout);
            y += name.height + 16;
        }
        roundRect(cr, promptX, y, promptW, 44, get('entry-radius'));
        color(cr, get('entry-color'), get('entry-opacity'));
        cr.fill();
        const hint = textLayout(cr, 'Password', {size: 16, weight: 400});
        color(cr, get('entry-text-color'), 0.7);
        cr.moveTo(promptX + 14, y + (44 - hint.height) / 2);
        PangoCairo.show_layout(cr, hint.layout);
    } else if (get('show-hint')) {
        const hint = textLayout(cr, get('space-to-unlock') ? 'Press Space to unlock' : 'Click or press a key to unlock', {size: 16, weight: 500});
        color(cr, get('clock-color'), 0.8);
        cr.moveTo((W - hint.width) / 2, H * 0.86 - hint.height);
        PangoCairo.show_layout(cr, hint.layout);
    }

    if (!get('enabled')) {
        cr.setSourceRGBA(0, 0, 0, 0.6);
        cr.paint();
        const off = textLayout(cr, 'Den is off', {size: 60, weight: 600});
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.moveTo((W - off.width) / 2, (H - off.height) / 2);
        PangoCairo.show_layout(cr, off.layout);
    }
    cr.restore();
}

// A drawing area showing the lock screen described by `get(key)`.
// `options` is read again on every draw, so callers can change it and
// call queue_draw().
export function makePreview(get, options = {}, props = {}) {
    const area = new Gtk.DrawingArea(props);
    area.set_draw_func((_area, cr, w, h) => {
        try {
            drawLock(cr, w, h, get, options);
        } catch (e) {
            console.error(`Stoop preview: ${e.message}`);
        }
        cr.$dispose();
    });
    return area;
}
