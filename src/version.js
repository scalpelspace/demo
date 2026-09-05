/**
 * The one line every ScalpelSpace board can be counted on to print.
 *
 * `version` (or `ver`) answers with the short name compiled into the firmware
 * followed by `MAJOR.MINOR.PATCH.IDENTIFIER`, for example:
 *
 *     momentum 0.6.0.p
 *
 * That name is what selects the demo, so this parser is the contract between
 * the page and every product on the shelf. It lives on its own so both the
 * connect handshake and a product's own line parsing can use it without
 * either importing the other.
 */

export const VERSION_RE = /^([a-z][a-z0-9_]*) (\d+)\.(\d+)\.(\d+)\.(\S)$/i;

/** @returns {{product: string, version: string} | null} */
export function parseVersion(line) {
  const match = VERSION_RE.exec(line);
  if (!match) return null;
  return {
    product: match[1].toLowerCase(),
    version: `${match[2]}.${match[3]}.${match[4]}.${match[5]}`,
  };
}
