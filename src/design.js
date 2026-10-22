/* FC M:sys — Msys_Farben-2021-09.pdf, Corporate Design Manual, 02.09.2021.
 * Only unambiguous published colours are included. Signal blue 20% uses the
 * printed RGB 212/237/252 and swatch; the PDF's #0cedfc is a typographical error.
 * Keep this shared palette as the source for browser and server-rendered UI.
 */
(function (root) {
    const colors = Object.freeze({
        white: '#ffffff', black: '#000000',
        blue: '#00a0e4', blue80: '#3ea7e0', blue60: '#5bc5f2',
        blue40: '#a1daf8', blue20: '#d4edfc',
        darkBlue: '#204a97', blueBlack: '#283278',
        yellow: '#ffd200', lightYellow: '#ffe48b', paleYellow: '#fff0cd',
        red: '#dd2e42', orange: '#f39313',
        grayDark: '#585858', gray: '#666666', gray40: '#b1b1b1', gray20: '#d9d9d9',
        blueGray: '#558398', blueGray80: '#7199ac', blueGray60: '#93b1c2',
        blueGray40: '#b6cbd7', blueGray20: '#d9e4ec',
        green: '#0aa537', darkGreen: '#0a642d', greenBlack: '#003c1e',
        paleGreen: '#a0dcaf', lightGreen: '#78b964',
        petrol: '#0a9696', lightPetrol: '#5abec8', petrolBlack: '#1e4146',
        brown: '#915014', lightBrown: '#c8a07d', paleBrown: '#dcbea0', brownBlack: '#460f14',
        violet: '#64418c', lightViolet: '#be6eaa', paleViolet: '#e1afe1',
    });
    const scale = values => Object.fromEntries(
        [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((shade, i) => [shade, values[i]])
    );
    const neutral = scale([colors.white, colors.blueGray20, colors.gray20, colors.blueGray40,
        colors.gray, colors.gray, colors.grayDark, colors.grayDark, colors.blueBlack, colors.blueBlack, colors.black]);
    const blue = scale([colors.blue20, colors.blue40, colors.blue60, colors.blue80,
        colors.blue, colors.darkBlue, colors.darkBlue, colors.blueBlack, colors.blueBlack, colors.blueBlack, colors.black]);
    const green = scale([colors.white, colors.paleGreen, colors.paleGreen, colors.lightGreen,
        colors.green, colors.darkGreen, colors.darkGreen, colors.darkGreen, colors.greenBlack, colors.greenBlack, colors.black]);
    const red = scale([colors.white, colors.paleYellow, colors.lightBrown, colors.orange,
        colors.red, colors.red, colors.red, colors.brownBlack, colors.brownBlack, colors.brownBlack, colors.black]);
    const yellow = scale([colors.paleYellow, colors.paleYellow, colors.lightYellow, colors.yellow,
        colors.yellow, colors.brown, colors.brown, colors.brown, colors.brownBlack, colors.brownBlack, colors.black]);
    const violet = scale([colors.white, colors.paleViolet, colors.paleViolet, colors.lightViolet,
        colors.lightViolet, colors.violet, colors.violet, colors.violet, colors.blueBlack, colors.blueBlack, colors.black]);
    const tailwindColors = {
        inherit: 'inherit', current: 'currentColor', transparent: 'transparent',
        white: colors.white, black: colors.black,
        slate: neutral, gray: neutral, zinc: neutral, neutral, stone: neutral,
        blue, sky: blue, indigo: blue,
        green, emerald: green, lime: green,
        teal: green, cyan: blue,
        red, rose: red, pink: red,
        amber: yellow, yellow, orange: yellow,
        violet, purple: violet, fuchsia: violet,
    };
    const rgb = Object.freeze(Object.fromEntries(Object.entries(colors).map(([name, hex]) =>
        [name, hex.slice(1).match(/../g).map(value => parseInt(value, 16)).join(',')]
    )));
    const cssVariables = ':root{' + Object.entries(colors).map(([name, hex]) => {
        return `--cd-${name}:${hex};--cd-${name}-rgb:${rgb[name]};`;
    }).join('') + '}';
    const design = Object.freeze({ colors, rgb, tailwindColors, cssVariables });
    if (typeof module !== 'undefined' && module.exports) module.exports = design;
    else root.FC_MSYS_DESIGN = design;
})(globalThis);
