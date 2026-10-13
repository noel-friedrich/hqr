import { renderTomThumbLine, validateTomThumbText } from "./tom-thumb-font.js";
import { PIXIIE_FONTS } from "./pixiie-fonts.js";

export const DEFAULT_FONT_ID = "tom-thumb";
export const FONTS = [
    {
        id: DEFAULT_FONT_ID,
        label: "Tom Thumb (original)",
        advance: 4,
        renderLine: renderTomThumbLine,
        validateText: validateTomThumbText,
    },
    ...Object.entries(PIXIIE_FONTS).map(([id, data]) => ({
        id,
        label: data.label,
        advance: data.advance,
        validateText(text) {
            const unsupported = [...text].find(
                (character) =>
                    !Object.hasOwn(data.glyphs, character.codePointAt(0)),
            );
            if (unsupported) {
                throw new Error(
                    `${data.label} cannot render ${JSON.stringify(unsupported)}. Use printable ASCII characters.`,
                );
            }
        },
        renderLine(text) {
            this.validateText(text);
            const width = Math.max(
                1,
                text.length * data.advance - (data.advance - data.width),
            );
            const pixels = Array.from({ length: data.height }, () =>
                Array(width).fill(false),
            );
            [...text].forEach((character, index) => {
                data.glyphs[character.codePointAt(0)].forEach((bits, row) => {
                    for (let column = 0; column < data.width; column += 1) {
                        pixels[row][index * data.advance + column] =
                            (bits & (1 << (data.width - column - 1))) !== 0;
                    }
                });
            });
            return pixels;
        },
    })),
];

export function getFont(id = DEFAULT_FONT_ID) {
    const font = FONTS.find((font) => font.id === id);
    if (!font) throw new Error(`Unknown font: ${id}`);
    return font;
}
