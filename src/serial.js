/**
 * Web Serial transport: an open port, a byte sink, and the modem control
 * lines.
 *
 * Deliberately the same shape as the transport in `blasher`, so the two tools
 * behave identically against the same hardware. The difference is which way
 * the bytes flow. Blasher drives a strict request/response protocol and needs
 * timed reads of exact byte counts; a demo consumes a free-running stream of
 * text, so everything arriving is pushed straight to `onData` and the framing
 * is somebody else's problem (see lines.js).
 */

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** The USB-to-UART bridge on every ScalpelSpace board with a USB-C port. */
const CP2102N = {usbVendorId: 0x10c4, usbProductId: 0xea60};

export function isSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Prompt the user for a port, optionally beyond the CP2102N. */
export async function requestPort({anyDevice = false} = {}) {
  const filters = anyDevice ? [] : [CP2102N];
  return navigator.serial.requestPort({filters});
}

export function describePort(port) {
  const info = port.getInfo ? port.getInfo() : {};
  if (info.usbVendorId === undefined) return "Serial port";
  const vid = info.usbVendorId.toString(16).padStart(4, "0");
  const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
  const known = info.usbVendorId === CP2102N.usbVendorId && info.usbProductId === CP2102N.usbProductId ? "CP2102N" : "USB serial device";
  return `${known} - ${vid}:${pid}`;
}

export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._draining = false;
    /** Called with every Uint8Array the device sends. */
    this.onData = null;
    /** Called once if the read pump dies, typically an unplug. */
    this.onError = null;
  }

  get isOpen() {
    return this.writer !== null;
  }

  async open({baudRate = 115200, parity = "none"} = {}) {
    await this.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity,
      flowControl: "none",
      bufferSize: 8192,
    });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this._draining = false;
    this._pump();
  }

  async close() {
    this._draining = true;
    try {
      if (this.reader) await this.reader.cancel().catch(() => {
      });
      if (this.reader) this.reader.releaseLock();
    } catch {
      /* already released */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* port may already be gone (unplugged) */
    }
  }

  async _pump() {
    try {
      while (this.reader) {
        const {value, done} = await this.reader.read();
        if (done) break;
        if (value && value.length && this.onData) this.onData(value);
      }
    } catch (err) {
      if (!this._draining && this.onError) this.onError(err);
    }
  }

  async write(bytes) {
    if (!this.writer) throw new Error("Port is not open");
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /**
   * Drive the modem control lines. `dataTerminalReady` / `requestToSend` are
   * asserted-true; on a CP2102N an asserted line reads low at the TTL pin.
   */
  async setSignals(signals) {
    await this.port.setSignals(signals);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
