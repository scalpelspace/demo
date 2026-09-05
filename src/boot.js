/**
 * Boot control over the CP2102N modem lines.
 *
 * A ScalpelSpace board wires the USB-to-UART bridge for hands-free flashing:
 * DTR drives BOOT0 and RTS is AC-coupled to NRESET. That is what lets
 * `blasher` flash a board with nothing but a USB-C cable, and it is also why
 * merely opening the port is not enough to talk to the application. Chrome
 * asserts DTR when it opens a port, so BOOT0 goes high, and the RTS edge
 * resets the MCU - straight into the system bootloader, which answers no
 * commands at all.
 *
 * So every session starts by releasing BOOT0 and resetting deliberately. The
 * defaults below match `blasher` and PyBlasher; they are exposed in the UI
 * because a board that buffers or inverts a line needs different ones.
 */

import {sleep} from "./serial.js";

export const DEFAULT_PINS = {
  nrstLine: "rts", // "rts" | "dtr"
  nrstInvert: true, // asserting reset drives the signal false
  boot0Line: "dtr", // "rts" | "dtr"
  boot0Invert: false, // asserting BOOT0 drives the signal true
  resetHoldMs: 20, // how long NRESET is held asserted
  bootDelayMs: 400, // settle time after release, before the first command
};

const signalName = (line) => line === "rts" ? "requestToSend" : "dataTerminalReady";

export class BootControl {
  /**
   * @param {import("./serial.js").SerialTransport} transport
   * @param {Partial<typeof DEFAULT_PINS>} [pins]
   */
  constructor(transport, pins = {}) {
    this.io = transport;
    this.pins = {...DEFAULT_PINS, ...pins};
  }

  /**
   * Drive both control lines. `nrst: true` holds the MCU in reset,
   * `boot0: true` selects the system bootloader at the next reset release.
   */
  async setLines({nrst, boot0}) {
    const {nrstLine, nrstInvert, boot0Line, boot0Invert} = this.pins;
    if (nrstLine === boot0Line) {
      throw new Error("BOOT0 and NRESET cannot share the same control line");
    }
    const signals = {};
    signals[signalName(nrstLine)] = nrstInvert ? !nrst : nrst;
    signals[signalName(boot0Line)] = boot0Invert ? !boot0 : boot0;
    await this.io.setSignals(signals);
  }

  async pulseReset(boot0 = false) {
    await this.setLines({nrst: true, boot0});
    await sleep(this.pins.resetHoldMs);
    await this.setLines({nrst: false, boot0});
  }

  /**
   * Bring the board up running its application: BOOT0 low across the reset,
   * then long enough for the firmware to finish initialising before anything
   * is asked of it. Momentum renegotiates the GNSS module's baud rate during
   * start-up, so the wait is generous by the standards of a bare MCU.
   */
  async runApplication() {
    await this.setLines({nrst: false, boot0: false});
    await sleep(10);
    await this.pulseReset(false);
    await sleep(this.pins.bootDelayMs);
  }
}
