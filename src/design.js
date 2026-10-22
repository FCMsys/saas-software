/* FC M:sys — Msys_Farben-2021-09.pdf, Corporate Design Manual, 02.09.2021.
 * Only unambiguous published colours are included. Signal blue 20% uses the
 * printed RGB 212/237/252 and swatch; the PDF's #0cedfc is a typographical error.
 * Keep this shared palette as the source for browser and server-rendered UI.
 */
(function (root) {
    // Weighting: white surfaces, signal-blue accents, small yellow/gray details.
    // Green/red communicate confirmation/refusal; they are not decorative colours.
    const colors = Object.freeze({
        white: '#ffffff', black: '#000000',
        blue: '#00a0e4', blue80: '#3ea7e0', blue60: '#5bc5f2', blue40: '#a1daf8', blue20: '#d4edfc',
        darkBlue: '#204a97', blueBlack: '#283278', yellow: '#ffd200',
        grayDark: '#585858', gray: '#666666', gray40: '#b1b1b1', gray20: '#d9d9d9',
        red: '#dd2e42', darkGreen: '#0a642d',
    });
    const scale = values => Object.fromEntries(
        [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((shade, i) => [shade, values[i]])
    );
    const neutral = scale([colors.white, colors.white, colors.gray20, colors.gray20,
        colors.gray40, colors.gray, colors.gray, colors.grayDark, colors.grayDark, colors.black, colors.black]);
    const blue = scale([colors.white, colors.blue20, colors.blue40, colors.blue60,
        colors.blue80, colors.blue, colors.blue, colors.blue, colors.darkBlue, colors.darkBlue, colors.blueBlack]);
    const green = scale([colors.white, colors.white, colors.gray20, colors.darkGreen,
        colors.darkGreen, colors.darkGreen, colors.darkGreen, colors.darkGreen, colors.darkGreen, colors.darkGreen, colors.darkGreen]);
    const red = scale([colors.white, colors.white, colors.gray20, colors.red,
        colors.red, colors.red, colors.red, colors.red, colors.red, colors.red, colors.red]);
    const yellow = scale([colors.white, colors.white, colors.gray20, colors.yellow,
        colors.yellow, colors.yellow, colors.yellow, colors.yellow, colors.grayDark, colors.grayDark, colors.black]);
    const tailwindColors = {
        inherit: 'inherit', current: 'currentColor', transparent: 'transparent', white: colors.white, black: colors.black,
        slate: neutral, gray: neutral, zinc: neutral, neutral, stone: neutral,
        blue, sky: blue, indigo: blue, cyan: blue, teal: blue,
        green, emerald: green, lime: neutral, red, rose: red, pink: neutral,
        amber: yellow, yellow, orange: yellow, violet: blue, purple: blue, fuchsia: blue,
    };
    // Ordinary text is black regardless of the old utility colour name.
    const blackText = Object.fromEntries(Object.keys(neutral).map(shade => [shade, colors.black]));
    const textColors = Object.fromEntries(Object.keys(tailwindColors).map(name =>
        [name, typeof tailwindColors[name] === 'object' ? blackText : tailwindColors[name]]
    ));
    Object.assign(textColors, { green, emerald: green, red, rose: red });
    const rgb = Object.freeze(Object.fromEntries(Object.entries(colors).map(([name, hex]) =>
        [name, hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(',')]
    )));
    const cssVariables = ':root{' + Object.entries(colors).map(([name, hex]) => {
        return `--cd-${name}:${hex};--cd-${name}-rgb:${rgb[name]};`;
    }).join('') + '}';
    const design = Object.freeze({ colors, rgb, tailwindColors, textColors, cssVariables });
    if (typeof module !== 'undefined' && module.exports) module.exports = design;
    else root.FC_MSYS_DESIGN = design;
})(globalThis);
