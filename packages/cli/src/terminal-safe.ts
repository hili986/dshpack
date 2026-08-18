/**
 * Keep human CLI output single-line and non-executable when persisted metadata contains control
 * characters. JSON reports retain their original structured values; this is presentation-only.
 */
export function terminalSafeText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined || !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(character))
        return character;
      // JSON already supplies familiar escapes for C0/C1 controls (`\n`, `\u001b`).  It does
      // not escape Unicode line/bidi format characters, so encode every remaining unsafe code
      // point explicitly to keep one physical terminal line and stable visual order.
      const encoded = JSON.stringify(character).slice(1, -1);
      if (encoded !== character) return encoded;
      return codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : `\\u{${codePoint.toString(16)}}`;
    })
    .join('');
}
