#!/bin/bash
# Checks run against the nested shell. Sourced by headless-inner.sh, which
# provides eval_js, $UUID, $ROOT and $WORK.
SHOTS="${SHOTS:-$WORK/shots}"
mkdir -p "$SHOTS"
export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
LM="org.gnome.shell.extensions.den"

preset() { gjs -m "$ROOT/test/preset.mjs" "$@"; sleep 1; }
set_() { gsettings set "$LM" "$@"; sleep 0.4; }
show() { echo "== $1"; eval_js "$2"; }
# The screenshot service refuses while locked, so ask the shell directly.
shot() {
    eval_js "(() => { const s = new imports.gi.Shell.Screenshot(); const f = imports.gi.Gio.File.new_for_path('$SHOTS/$1.png'); const st = f.replace(null, false, 0, null); s.screenshot(false, st, (o, r) => { try { o.screenshot_finish(r); } catch (e) { log('shot failed ' + e); } st.close(null); }); return 'shot $1'; })()" >/dev/null
    sleep 0.6
}
DIALOG="Main.screenShield._dialog"

show "extension state (1 = enabled)" "Main.extensionManager.lookup('$UUID').state"
show "extension error" "Main.extensionManager.lookup('$UUID').error"
echo "##### prefs"
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland
IMG=$(ls /usr/share/backgrounds/*.{jpg,png,webp} 2>/dev/null | head -1)
uishot() {
    gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" >/dev/null 2>&1
}
(timeout 60 gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 &)
sleep 7
uishot prefs-presets
# Click through the pages with a virtual pointer.
click() {
    eval_js "(() => { const C = imports.gi.Clutter; globalThis.__dev ??= C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const d = globalThis.__dev; const t = imports.gi.GLib.get_monotonic_time(); d.notify_absolute_motion(t, $1, $2); d.notify_button(t + 1000, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(t + 60000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); return 1; })()" >/dev/null
    sleep 1.2
}
scroll() {
    eval_js "(() => { const C = imports.gi.Clutter; const d = globalThis.__dev; const t = imports.gi.GLib.get_monotonic_time(); d.notify_absolute_motion(t, 672, 600); for (let i = 0; i < $1; i++) d.notify_discrete_scroll(t + i * 1000, C.ScrollDirection.DOWN, C.ScrollSource.WHEEL); return 1; })()" >/dev/null
    sleep 1
}
click 776 242; click 776 242; uishot prefs-password-view
click 548 55; sleep 2; uishot prefs-wallpaper; scroll 6; uishot prefs-wallpaper-2
click 672 55; uishot prefs-clock; scroll 8; uishot prefs-clock-2
click 795 55; uishot prefs-password
click 918 55; uishot prefs-locking
head -30 "$WORK/prefs.log"
[ "${PREFS_ONLY:-}" = 1 ] && return 0

show "lock" "(() => { Main.screenShield.lock(false); return [Main.screenShield.locked, Main.sessionMode.currentMode]; })()"
sleep 2
# Locking fades the screen to black until there is activity; wake it up.
wake() { eval_js "(() => { const s = Main.screenShield; s._longLightbox.lightOff(); s._shortLightbox.lightOff(); return 1; })()" >/dev/null; sleep 0.6; }
wake
show "still enabled while locked" "Main.extensionManager.lookup('$UUID').state"
show "dialog" "(() => { const d=$DIALOG; return [d.style_class, d.get_children().map(c=>c.name||c.constructor.name).join(','), d._clock._time.visible]; })()"
[ -n "${PRESETS:-}" ] && { for p in $PRESETS; do preset "$p"; shot "$p"; done; return 0; }
show "clock text" "(() => { const l=$DIALOG.get_children().find(c=>c.name==='lm-layer'); const walk=a=>[a.text, ...a.get_children().flatMap(walk)].filter(Boolean); return walk(l); })()"
shot default

for p in ${PRESETS:-headline corner stacked frosted minimal terminal poster sunrise}; do
    preset "$p"
    shot "$p"
done

echo "##### wallpaper"
preset default
IMG=$(ls /usr/share/backgrounds/*.{jpg,png,webp} 2>/dev/null | head -1)
echo "image: $IMG"
set_ wallpaper-path "$IMG"; set_ wallpaper-source image; set_ blur 0; set_ brightness 0.9; set_ message-text "If found, please call 555 0100"
sleep 1.5
show "extras per background" "$DIALOG._backgroundGroup.get_children().map(w=>w.get_n_children())"
shot wallpaper
set_ wallpaper-source color; set_ wallpaper-color '#20304a'; sleep 1; shot color
gsettings reset "$LM" wallpaper-source; gsettings reset "$LM" message-text

echo "##### prompt"
preset frosted
eval_js "$DIALOG._showPrompt()" >/dev/null; sleep 1.5
show "progress, clock opacity" "[$DIALOG._adjustment.value, $DIALOG.get_children().find(c=>c.name==='lm-layer').get_first_child().opacity]"
shot prompt
preset headline; sleep 1; shot prompt-keep
set_ show-avatar false; set_ show-username false; sleep 1; shot prompt-bare
eval_js "$DIALOG._showClock()" >/dev/null; sleep 1

. "$ROOT/test/space-checks.sh"

echo "##### off and on"
set_ enabled false; sleep 1
show "off: class, stock clock visible, layer visible" "[$DIALOG.style_class, $DIALOG._clock._time.visible, $DIALOG.get_children().find(c=>c.name==='lm-layer').visible]"
shot off
set_ enabled true; sleep 1
gnome-extensions disable "$UUID"; sleep 1.5
show "disabled: class, layer gone, stock visible" "[$DIALOG.style_class, !$DIALOG.get_children().find(c=>c.name==='lm-layer'), $DIALOG._clock._time.visible]"
gnome-extensions enable "$UUID"; sleep 2
show "re-enabled: layer back" "!!$DIALOG.get_children().find(c=>c.name==='lm-layer')"

echo "##### unlock and lock again"
set_ hide-panel true; sleep 1
show "panel hidden while locked" "Main.layoutManager.panelBox.visible"
show "unlock" "(() => { Main.screenShield.deactivate(false); return Main.screenShield.locked; })()"
sleep 2
show "panel back after unlock (expect true)" "Main.layoutManager.panelBox.visible"
show "lock again" "(() => { Main.screenShield.lock(false); return Main.screenShield.locked; })()"
sleep 2.5
wake
show "decorated again" "!!$DIALOG.get_children().find(c=>c.name==='lm-layer')"
show "unlock" "(() => { Main.screenShield.deactivate(false); return Main.screenShield.locked; })()"
sleep 1.5
