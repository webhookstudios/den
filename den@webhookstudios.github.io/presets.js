// Built-in presets. Each lists only what differs from the schema defaults,
// because applying a preset resets everything it does not name.

export const BUILTIN_PRESETS = [
    {
        id: 'default',
        name: 'Default',
        description: 'The standard look: a centered clock over a blurred, dimmed background.',
        values: {},
    },
    {
        id: 'headline',
        name: 'Headline',
        description: 'A large bold clock near the top, with the date above it and a sharp background.',
        values: {
            'blur': 0, 'brightness': 0.9, 'shade': 0.45,
            'clock-position': 'top', 'clock-size': 130, 'clock-weight': 700, 'clock-margin': 40,
            'clock-shadow': true, 'keep-clock': true,
            'date-above': true, 'date-size': 26, 'date-weight': 600, 'date-format': 'long',
        },
    },
    {
        id: 'corner',
        name: 'Corner',
        description: 'A light clock and date tucked into the bottom-left corner of a clear picture.',
        values: {
            'blur': 0, 'brightness': 0.85, 'shade': 0.55,
            'clock-position': 'bottom-left', 'clock-size': 120, 'clock-weight': 300, 'clock-margin': 72,
            'clock-shadow': true, 'date-size': 30, 'date-weight': 400, 'date-format': 'long',
            'show-hint': false,
        },
    },
    {
        id: 'stacked',
        name: 'Stacked',
        description: 'Hours over minutes in tall heavy digits on the left side.',
        values: {
            'blur': 30, 'brightness': 0.7,
            'clock-position': 'left', 'clock-style': 'stacked', 'clock-size': 150, 'clock-weight': 800,
            'clock-margin': 110, 'keep-clock': true, 'date-size': 24, 'date-format': 'short',
            'date-uppercase': true,
        },
    },
    {
        id: 'frosted',
        name: 'Frosted',
        description: 'Heavy blur with a pale wash and a thin, airy clock.',
        values: {
            'blur': 160, 'brightness': 0.85, 'tint-color': '#ffffff', 'tint-opacity': 0.12,
            'clock-size': 130, 'clock-weight': 200, 'date-size': 24, 'date-weight': 300,
            'entry-radius': 20, 'entry-opacity': 0.22,
        },
    },
    {
        id: 'minimal',
        name: 'Minimal',
        description: 'Dark and quiet: a small clock, a short date and nothing else.',
        values: {
            'blur': 60, 'brightness': 0.5, 'tint-color': '#000000', 'tint-opacity': 0.55,
            'clock-size': 64, 'clock-weight': 300, 'date-size': 16, 'date-format': 'short',
            'show-hint': false, 'show-avatar': false, 'entry-radius': 20, 'hide-panel': true,
        },
    },
    {
        id: 'terminal',
        name: 'Terminal',
        description: 'Green monospace digits with seconds on a nearly black screen.',
        values: {
            'blur': 40, 'brightness': 0.4, 'tint-color': '#001a08', 'tint-opacity': 0.75,
            'clock-font': 'Monospace', 'clock-color': '#7dfc9a', 'clock-size': 88, 'clock-weight': 700,
            'clock-format': '24h', 'clock-seconds': true, 'clock-position': 'top-left', 'clock-margin': 80,
            'keep-clock': true, 'date-format': 'full', 'date-uppercase': true, 'date-size': 18,
            'entry-radius': 0, 'entry-color': '#7dfc9a', 'entry-opacity': 0.12, 'entry-text-color': '#7dfc9a',
            'show-avatar': false,
        },
    },
    {
        id: 'poster',
        name: 'Poster',
        description: 'An oversized clock across the middle with the date in capitals above it.',
        values: {
            'blur': 10, 'brightness': 0.6,
            'clock-size': 280, 'clock-weight': 900, 'clock-opacity': 0.92,
            'date-above': true, 'date-uppercase': true, 'date-size': 26, 'date-weight': 700,
            'date-format': 'full',
        },
    },
    {
        id: 'sunrise',
        name: 'Warm',
        description: 'A warm amber wash over a soft background, clock at the bottom right.',
        values: {
            'blur': 50, 'brightness': 0.8, 'tint-color': '#ff8a3d', 'tint-opacity': 0.22, 'shade': 0.5,
            'clock-position': 'bottom-right', 'clock-size': 110, 'clock-weight': 500, 'clock-margin': 72,
            'clock-color': '#fff4e6', 'date-size': 24, 'entry-radius': 16,
        },
    },
];
