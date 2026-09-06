/**
 * Which demo belongs to which board.
 *
 * Nothing on the page picks a product. The board is asked `version`, it
 * answers with its own short name - the one compiled into it as
 * `SCALPELSPACE_SHORT_NAME` - and that name selects the demo. A new product
 * is one module and one line here; no page, no menu and no link needs to know
 * about it.
 */

import {momentum} from "./products/momentum.js";
import {mcStepper} from "./products/mc_stepper.js";

export const PRODUCTS = [momentum, mcStepper];

/** @param {string} name the short name reported by `version` */
export function findProduct(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return PRODUCTS.find((product) => product.matches(normalized)) || null;
}
