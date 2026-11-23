// Text that came from an adapter or a server goes to a terminal. Printed as
// it is, an escape sequence in it clears the screen, and a carriage return
// or a line break draws a line that nothing produced. Control and format
// characters are shown as escapes instead.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// The same for JSON that is already made: what is left unescaped inside its
// strings is written as \uXXXX, which a JSON reader turns back. The line
// breaks between its lines stay.
export function printableJson(json: string): string {
  return json.replace(UNPRINTABLE, (char) => {
    if (char === "\n") return char;
    let escaped = "";
    for (let index = 0; index < char.length; index += 1) {
      escaped += `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}

export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const hex = code.toString(16);
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}
