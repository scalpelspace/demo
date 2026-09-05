/**
 * The link between the page and one connected board.
 *
 * Owns the transport and the line assembler, and hands every complete line to
 * whoever asked for lines. There is exactly one stream and several interested
 * parties - the raw console, the active product demo, the version handshake -
 * so this broadcasts rather than letting any one of them take the reader, the
 * way the flasher and the monitor have to trade the port in `blasher`.
 *
 * `ask()` layers a request/response idiom on top of that broadcast. The
 * firmware has no command echo, no prompt and no reply framing: an answer is
 * simply the next line that looks like an answer. So a caller supplies a
 * matcher, and the first line it accepts wins. Unsolicited telemetry
 * interleaved with the reply is therefore harmless, which matters because a
 * board built with full UART telemetry never stops talking.
 */

import {TimeoutError, sleep} from "./serial.js";
import {LineAssembler, encodeCommand} from "./lines.js";

/**
 * Partial lines are held until more bytes arrive; this forces them out once
 * the device goes quiet, so an unterminated print still reaches the console.
 */
const IDLE_FLUSH_MS = 150;

export class DeviceLink {
  /** @param {import("./serial.js").SerialTransport} transport */
  constructor(transport) {
    this.io = transport;
    this.assembler = new LineAssembler();
    this._lineHandlers = new Set();
    this._sentHandlers = new Set();
    this._idleTimer = null;
    this.rxBytes = 0;
    this.txBytes = 0;

    this.io.onData = (chunk) => {
      this.rxBytes += chunk.length;
      this._emit(this.assembler.push(chunk));
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => this._emit(this.assembler.flush()), IDLE_FLUSH_MS);
    };
  }


  /** @param {(line: string) => void} handler @returns {() => void} unsubscribe */
  onLine(handler) {
    this._lineHandlers.add(handler);
    return () => this._lineHandlers.delete(handler);
  }

  /** Notified of everything written, for the console's local echo. */
  onSent(handler) {
    this._sentHandlers.add(handler);
    return () => this._sentHandlers.delete(handler);
  }

  _emit(lines) {
    for (const line of lines) {
      for (const handler of [...this._lineHandlers]) {
        try {
          handler(line);
        } catch (err) {
          // One misbehaving panel must not stop the console from printing.
          console.error("line handler failed", err);
        }
      }
    }
  }

  async writeBytes(bytes, {echo = null} = {}) {
    await this.io.write(bytes);
    this.txBytes += bytes.length;
    for (const handler of [...this._sentHandlers]) handler(echo ?? bytes);
  }

  /** Send one command line. */
  async send(text, {lineEnding = "lf"} = {}) {
    await this.writeBytes(encodeCommand(text, {lineEnding}), {echo: text});
  }

  /**
   * Send a command and resolve with the first reply the matcher accepts.
   *
   * @param {string} text command to send
   * @param {(line: string) => any} match returns a truthy parse, or null
   * @param {{timeout?: number, attempts?: number}} [options]
   */
  async ask(text, match, {timeout = 1200, attempts = 1} = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this._askOnce(text, match, timeout);
      } catch (err) {
        lastError = err;
        if (!(err instanceof TimeoutError)) throw err;
        // A board still finishing start-up simply was not listening yet.
        await sleep(120);
      }
    }
    throw lastError;
  }

  _askOnce(text, match, timeout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        fn(value);
      };
      const timer = setTimeout(() => {
        finish(reject, new TimeoutError(`No reply to "${text}" within ${timeout} ms`));
      }, timeout);
      const unsubscribe = this.onLine((line) => {
        let parsed = null;
        try {
          parsed = match(line);
        } catch (err) {
          finish(reject, err);
          return;
        }
        if (parsed) finish(resolve, parsed);
      });

      this.send(text).catch((err) => finish(reject, err));
    });
  }

  async close() {
    clearTimeout(this._idleTimer);
    this._emit(this.assembler.flush());
    this.io.onData = null;
    this.io.onError = null;
    this._lineHandlers.clear();
    this._sentHandlers.clear();
    await this.io.close();
  }
}
