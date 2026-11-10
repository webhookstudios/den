#!/bin/bash
# The "press Space to continue" checks. Sourced from checks.sh, or run alone
# with  CHECKS=space-checks.sh test/headless.sh
if [ -z "${DIALOG:-}" ]; then
    SHOTS="${SHOTS:-$WORK/shots}"; mkdir -p "$SHOTS"
    export GSETTINGS_SCHEMA_DIR="$ROOT/$UUID/schemas"
    LM="org.gnome.shell.extensions.stoop"
    set_() { gsettings set "$LM" "$@"; sleep 0.4; }
    show() { echo "== $1"; eval_js "$2"; }
    shot() { :; }
    DIALOG="Main.screenShield._dialog"
    eval_js "(() => { Main.screenShield.lock(false); return 1; })()" >/dev/null; sleep 3
    eval_js "(() => { const s = Main.screenShield; s._longLightbox.lightOff(); s._shortLightbox.lightOff(); return 1; })()" >/dev/null; sleep 1
fi
echo "##### space to continue"
key() { eval_js "(() => { const C = imports.gi.Clutter; globalThis.__kb ??= C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = imports.gi.GLib.get_monotonic_time(); globalThis.__kb.notify_keyval(t, C.KEY_$1, C.KeyState.PRESSED); globalThis.__kb.notify_keyval(t + 20000, C.KEY_$1, C.KeyState.RELEASED); return 1; })()" >/dev/null; sleep 1.2; }
set_ space-to-unlock true
eval_js "$DIALOG._showClock()" >/dev/null; sleep 1
key a
show "after a letter (expect 0)" "$DIALOG._adjustment.value"
eval_js "$DIALOG._showPrompt()" >/dev/null; sleep 0.5
show "after a click-style request (expect 0)" "$DIALOG._adjustment.value"
key space
show "after space (expect 1)" "$DIALOG._adjustment.value"
shot space-prompt
eval_js "$DIALOG._showClock()" >/dev/null; sleep 1
set_ space-to-unlock false
key a
show "normal mode, after a letter (expect 1)" "$DIALOG._adjustment.value"
eval_js "$DIALOG._showClock()" >/dev/null; sleep 1

