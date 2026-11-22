// Text that came from an adapter or a server goes to a terminal. Printed as
// it is, an escape sequence in it clears the screen, and a carriage return
// or a line break draws a line that nothing produced. Control and format
// characters are shown as escapes instead.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}
