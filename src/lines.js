/**
 * Turning a byte stream into whole text lines, and typed input back into
 * bytes.
 *
 * Kept free of the DOM so the rules that are easy to get wrong - a UTF-8
 * sequence split across two reads, a CRLF that arrives in two chunks, a
 * prompt that never sends its newline - can be reasoned about and exercised
 * on their own.
 */

/**
 * Accumulates incoming bytes and emits complete lines.
 *
 * Decodes UTF-8 across chunk boundaries and splits on LF, holding an
 * unterminated tail until the rest arrives. `flush()` forces out whatever is
 * pending, which the caller should do on an idle timer so a device that stops
 * mid-line still shows what it sent.
 */
export class LineAssembler {
  constructor() {
    this._decoder = new TextDecoder("utf-8", {fatal: false});
    this._text = "";
  }

  push(chunk) {
    this._text += this._decoder.decode(chunk, {stream: true});
    if (!this._text.includes("\n")) return [];
    const parts = this._text.split("\n");
    this._text = parts.pop();
    // Strip the CR of a CRLF pair; the firmware prints "\r\n".
    return parts.map((line) => line.replace(/\r$/, ""));
  }

  /** Emit any partial line held back waiting for its newline. */
  flush() {
    if (this._text === "") return [];
    const line = this._text;
    this._text = "";
    return [line];
  }

  reset() {
    this._text = "";
    this._decoder = new TextDecoder("utf-8", {fatal: false});
  }
}

/**
 * One hexdump row: offset, hex columns, ASCII gutter. Used by the console's
 * hex view and to echo hex sent by hand.
 */
export function hexdumpRow(bytes, offset, width = 16) {
  const printable = (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".");
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .padEnd(width * 3 - 1, " ");
  const ascii = Array.from(bytes).map(printable).join("");
  return `${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`;
}

/**
 * Make control characters visible before a line reaches the DOM. Firmware
 * prints an uninitialised `char` field as a raw byte - a GNSS direction
 * before the first fix is a NUL - and a NUL in a text node is invisible, so
 * the line silently loses a character rather than showing that the field is
 * empty. Parsing works from the original string; only display goes through
 * here.
 */
export function printableLine(line) {
  return line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "�");
}

/**
 * The device's line editor ignores CR and acts on LF, so a bare LF is the one
 * ending that always works. The others are offered by the console for talking
 * to firmware that wants them.
 */
const LINE_ENDINGS = {
  none: "", lf: "\n", cr: "\r", crlf: "\r\n",
};

export function encodeCommand(text, {lineEnding = "lf"} = {}) {
  return new TextEncoder().encode(text + (LINE_ENDINGS[lineEnding] ?? "\n"));
}

/**
 * Parse loose hex input into bytes. Accepts "01 0A ff", "0x01,0x0A,0xFF" or
 * "010AFF", matching what the console's hex send mode takes.
 */
export function parseHex(text) {
  const cleaned = String(text)
    .replace(/0x/gi, " ")
    .replace(/[,\r\n\t]/g, " ")
    .trim();
  if (cleaned === "") return new Uint8Array(0);

  const parts = cleaned.split(/\s+/);
  // A single unbroken run of hex digits is a byte string, not one number.
  if (parts.length === 1 && /^[0-9a-f]+$/i.test(parts[0])) {
    const run = parts[0];
    if (run.length % 2 !== 0) {
      throw new Error(`Hex needs an even number of digits, got ${run.length}`);
    }
    const out = new Uint8Array(run.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(run.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  const out = new Uint8Array(parts.length);
  parts.forEach((part, i) => {
    if (!/^[0-9a-f]{1,2}$/i.test(part)) {
      throw new Error(`Not a hex byte: ${part}`);
    }
    out[i] = Number.parseInt(part, 16);
  });
  return out;
}
