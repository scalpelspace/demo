/**
 * Momentum demo.
 *
 * Momentum is a 9-DOF IMU, a barometer and a multi-constellation GNSS on one
 * board, reachable over the USB-C serial console. This module knows two
 * things: how to read every line that firmware can print, and how to show it.
 *
 * There are two firmware builds in the wild and the demo has to suit both.
 * Stock firmware answers commands and says nothing otherwise, so the demo
 * polls it. A build with `MOMENTUM_FULL_COMM_TELEMETRY` defined instead pushes
 * `key=value` lines as fast as the sensors report, which is far more than the
 * poll would ever ask for - so when those lines appear the demo stops asking
 * and just listens.
 *
 * Firmware reference: https://github.com/scalpelspace/momentum
 */

import {
  StripChart,
  AXIS_COLORS,
  OrientationView,
  TrackPlot,
  facts,
  h,
  num,
  onThemeChange,
  quatToEuler,
} from "../ui.js";
import {VERSION_RE} from "../version.js";

/* --------------------------------------------------------------- parsing - */

/** A C `printf` float, in any of the forms `%f` and `%.3f` can produce. */
const FLOAT = "[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?";

/**
 * Every line the firmware can print, as one dispatch table.
 *
 * Written against the `printf` calls in `Core/Src/comm.c` and
 * `Core/Src/telemetry.c` rather than against a specification, including their
 * quirks: the stray space before the fourth quaternion term, `%u` date parts
 * that are not zero-padded, and a `%c` direction field that is a raw NUL byte
 * until the first fix. Anything unrecognised is left for the console.
 */
const PATTERNS = [// "momentum 0.6.0.p", shared with the connect handshake.
  {
    kind: "version", re: VERSION_RE, map: (m) => ({
      product: m[1], version: `${m[2]}.${m[3]}.${m[4]}.${m[5]}`,
    }),
  }, // "12345 6789 1011" - the 48-bit UID as three 16-bit parts.
  {
    kind: "uid", re: /^(\d{1,5}) (\d{1,5}) (\d{1,5})$/, map: (m) => ({
      uid: [Number(m[1]), Number(m[2]), Number(m[3])],
    }),
  }, // "0.001 i,0.002 j,0.003 k, 1.000 r"
  {
    kind: "quaternion",
    re: new RegExp(`^(${FLOAT}) i,(${FLOAT}) j,(${FLOAT}) k, ?(${FLOAT}) r$`),
    map: (m) => ({
      i: Number(m[1]), j: Number(m[2]), k: Number(m[3]), r: Number(m[4]),
    }),
  }, // "24.312 degC,101325.000 Pa"
  {
    kind: "barometric",
    re: new RegExp(`^(${FLOAT}) degC,(${FLOAT}) Pa$`),
    map: (m) => ({temperature: Number(m[1]), pressure: Number(m[2])}),
  }, // "2026/9/5 12:0:0"
  {
    kind: "gnssTime",
    re: /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/,
    map: (m) => ({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
    }),
  }, // "45.123 (N),-75.456 (W), 100.000 m"
  {
    kind: "gnssFix", // The direction group is `.?`, not `.`: the firmware prints an
    // uninitialised `char` there before the first fix, and a NUL can be lost
    // between the wire and here - by a terminal, a copy-paste, anything that
    // sanitises text - leaving the parentheses empty. A line that says "no
    // fix" is worth parsing.
    re: new RegExp(`^(${FLOAT}) \\((.?)\\),(${FLOAT}) \\((.?)\\), ?(${FLOAT}) m$`),
    map: (m) => ({
      latitude: Number(m[1]),
      latDir: m[2],
      longitude: Number(m[3]),
      lonDir: m[4],
      altitude: Number(m[5]),
    }),
  }, {kind: "error", re: /^Error: (.+)$/, map: (m) => ({message: m[1]})},];

/**
 * Telemetry lines are a comma-separated `key=value` list. Which reading a line
 * carries is decided by its keys, not by any tag in the line itself, so the
 * parse produces a flat bag of fields and the caller sorts them out.
 */
const TELEMETRY_RE = /^[a-z]{1,4}=[^,]*(?:,[a-z]{1,4}=[^,]*)*$/;

function parseLine(line) {
  for (const {kind, re, map} of PATTERNS) {
    const match = re.exec(line);
    if (match) return {kind, ...map(match)};
  }
  if (TELEMETRY_RE.test(line)) {
    const fields = {};
    for (const pair of line.split(",")) {
      const at = pair.indexOf("=");
      const key = pair.slice(0, at);
      const raw = pair.slice(at + 1);
      const value = Number(raw);
      fields[key] = raw !== "" && Number.isFinite(value) ? value : raw;
    }
    return {kind: "telemetry", fields};
  }
  return null;
}

/**
 * Pressure altitude from the ISA sea-level model, the same relation a
 * barometric altimeter uses. Not GNSS altitude and not a height above ground:
 * it is what 101325 Pa at sea level implies, which is why the two altitudes on
 * screen disagree by whatever the weather is doing.
 */
function pressureAltitude(pascals) {
  if (!Number.isFinite(pascals) || pascals <= 0) return null;
  return 44330 * (1 - Math.pow(pascals / 101325, 1 / 5.255));
}

/* ------------------------------------------------------------ freshness -- */

/**
 * The floor on how long a reading stays "live" after it arrives. The real
 * window is derived from how often that reading is asked for (see
 * `freshWindow`): GNSS goes out every tenth sweep by design, and dimming it in
 * between would be reporting the poll schedule as a fault.
 */
const FRESH_MS = 1500;
/** The GNSS module itself only reports once a second. */
const FRESH_GNSS_MS = 4000;

class Reading {
  constructor() {
    this.value = null;
    this.at = 0;
  }

  set(value) {
    this.value = value;
    this.at = performance.now();
  }

  /** Never received at all, as opposed to received and gone quiet. */
  get missing() {
    return this.at === 0;
  }

  fresh(within = FRESH_MS) {
    return !this.missing && performance.now() - this.at < within;
  }
}

/* ------------------------------------------------------------- the demo -- */

/**
 * Milliseconds between poll sweeps. Not adjustable: 5 Hz is fast enough that
 * the orientation view tracks a board turned by hand, and slow enough to stay
 * well clear of the link's real limit. The firmware prints from inside its
 * UART receive interrupt with a blocking transmit, so every reply is time the
 * board spends not reading its sensors.
 */
const POLL_MS = 200;

/**
 * How many sweeps apart the slower commands go out. The barometer updates at
 * 25 Hz on the board and GNSS at 1 Hz, so asking for either as often as the
 * quaternion would spend the link's time for nothing.
 */
const DIVISORS = {imu: 1, baro: 4, gnss: 10};

const LED_PRESETS = [["Off", [0, 0, 0]], ["White", [255, 255, 255]], ["Red", [255, 0, 0]], ["Green", [0, 255, 0]], ["Blue", [0, 0, 255]], ["Violet", [168, 0, 240]],];

class MomentumDemo {
  /**
   * @param {import("../link.js").DeviceLink} link
   * @param {{log: (msg: string, level?: string) => void, version: string,
   *          preview?: boolean}} ctx `preview` mounts the panel with no device
   *          behind it, so nothing is asked of the link.
   */
  constructor(link, ctx) {
    this.link = link;
    this.log = ctx.log;
    this.version = ctx.version;

    this.readings = {
      quaternion: new Reading(),
      baro: new Reading(),
      gnssTime: new Reading(),
      gnssFix: new Reading(),
      gnssQuality: new Reading(),
      accel: new Reading(),
      gyro: new Reading(),
      mag: new Reading(),
      linAccel: new Reading(),
      gravity: new Reading(),
      uid: new Reading(),
    };

    this.polling = false;
    this.streaming = false;
    /** GNSS readings are not taken, let alone shown, until asked for. */
    this.gnssVisible = false;
    this._streamHits = 0;
    this._streamSince = 0;
    this._tick = 0;
    this._timer = null;
    this._frame = null;
    this._unsubscribe = link.onLine((line) => this.handleLine(line));

    this.el = this.build();
    this.render();

    // Canvases hold pixels, not custom properties, so unlike the rest of the
    // page they do not follow the system light/dark switch by themselves.
    this._unthemed = onThemeChange(() => this.reflow());

    // Nothing to switch on: the panel exists because a board answered, so it
    // starts asking straight away. A preview has nothing to ask.
    if (!ctx.preview) this.startPolling();
  }

  /* -------------------------------------------------------------- markup - */

  build() {
    const grid = h("div.demo-grid");

    /* Attitude. */
    this.orientation = new OrientationView(h("canvas.attitude-canvas", {"aria-label": "Board orientation"}));
    this.attitudeFacts = facts([["i", "Quat i"], ["j", "Quat j"], ["k", "Quat k"], ["r", "Quat r"], ["roll", "Roll"], ["pitch", "Pitch"], ["yaw", "Yaw"],]);
    grid.append(this.card({
      title: "Attitude",
      id: "cardAttitude",
      source: "BNO086, game rotation vector",
      body: [h("div.attitude", null, this.orientation.canvas), this.attitudeFacts.el],
    }));

    /* Motion, streaming builds only. Next to Attitude: same sensor. */
    this.motionBlocks = {};
    const motionBody = [h("div.banner.note", {id: "motionNote"}, //
      h("strong", null, "Not reported by this firmware. "), //
      "The accelerometer, gyroscope and magnetometer reach the serial link " + "only in a build with ", h("code", null, "MOMENTUM_FULL_COMM_TELEMETRY"), //
      " defined. Everything else on this page works on stock firmware."),];
    /*
     * Linear acceleration and gravity are listed even though the stock
     * configuration reports neither: a block stays hidden until its first
     * reading arrives, so the only cost of listing them is this line, and a
     * board built with those SH2 reports enabled shows them without needing a
     * change here.
     */
    for (const [key, title, unit, minRange] of [["accel", "Accelerometer", "m/s^2", 2], ["gyro", "Gyroscope", "rad/s", 0.5], ["mag", "Magnetometer", "uT", 20], ["linAccel", "Linear acceleration", "m/s^2", 2], ["gravity", "Gravity", "m/s^2", 2],]) {
      const chart = new StripChart(h("canvas.chart.chart-short", {"aria-label": `${title} history`}), {
        series: [{key: "x", color: AXIS_COLORS.x}, {
          key: "y", color: AXIS_COLORS.y
        }, {
          key: "z", color: AXIS_COLORS.z
        },], symmetric: true, minRange, digits: 1,
      });
      const values = {
        x: h("span.axis-value", null, "-"),
        y: h("span.axis-value", null, "-"),
        z: h("span.axis-value", null, "-"),
      };
      const axis = (name) => h("span.axis", {dataset: {axis: name}}, h("span.axis-name", null, name.toUpperCase()), values[name]);
      const block = h("div.motion-block", {hidden: true}, //
        h("div.motion-head", null, h("span.motion-title", null, title), h("span.motion-unit", null, unit)), //
        h("div.axes", null, ["x", "y", "z"].map(axis)), //
        chart.canvas);
      this.motionBlocks[key] = {block, chart, values};
      motionBody.push(block);
    }
    this.motionNote = motionBody[0];
    grid.append(this.card({
      title: "Motion",
      id: "cardMotion",
      source: "BNO086, calibrated reports",
      body: motionBody,
    }));

    /*
     * GNSS. Everything in this card says where the board - and so the person
     * demonstrating it - physically is, which is the one reading on the page
     * that should not appear on a shared screen by surprise. So it starts
     * closed, and stays genuinely empty while closed: the poll skips the
     * command, incoming fixes are dropped rather than stored, and closing it
     * again discards what was read. Only the raw console can still show a
     * position, and only from a board that streams telemetry unasked.
     */
    this.gnssFacts = facts([["fix", "Fix"], ["satellites", "Satellites"], ["hdop", "HDOP"], ["latitude", "Latitude"], ["longitude", "Longitude"], ["altitude", "Altitude"], ["speed", "Ground speed"], ["course", "Course"], ["drift", "From first fix"], ["utc", "UTC"],]);
    this.trackPlot = new TrackPlot(h("canvas.track-canvas", {"aria-label": "Position relative to the first fix"}));
    this.gnssToggle = h("button", {
      type: "button", onclick: () => this.setGnssVisible(!this.gnssVisible)
    }, "Show location");
    this.gnssBody = h("div", {hidden: true}, //
      this.gnssFacts.el, //
      h("p.chart-label", null, "Track from first fix"), //
      h("div.track", null, this.trackPlot.canvas), //
      h("p.hint.card-note", null, "A cold start needs a clear view of the sky and can take several " + "minutes."));
    this.gnssClosedNote = h("p.hint.card-note", null, "Hidden by default so a shared screen does not give away where the " + "board is. Nothing is asked of the receiver until you open this.");
    grid.append(this.card({
      title: "GNSS",
      id: "cardGnss",
      source: "SAM-M10Q",
      body: [h("div.row", null, this.gnssToggle), this.gnssClosedNote, this.gnssBody],
    }));

    /* Environment. */
    this.envFacts = facts([["pressure", "Pressure"], ["temperature", "Temperature"], ["altitude", "Pressure alt."],]);
    this.pressureChart = new StripChart(h("canvas.chart", {"aria-label": "Pressure history"}), {
      series: [{key: "pressure", color: "--accent"}], minRange: 40, digits: 0,
    });
    this.tempChart = new StripChart(h("canvas.chart.chart-short", {"aria-label": "Temperature history"}), {
      series: [{key: "temperature", color: AXIS_COLORS.x}],
      minRange: 0.5,
      digits: 1,
    });
    grid.append(this.card({
      title: "Environment",
      id: "cardEnvironment",
      source: "BMP390",
      body: [this.envFacts.el, h("p.chart-label", null, "Pressure (Pa)"), this.pressureChart.canvas, h("p.chart-label", null, "Temperature (degC)"), this.tempChart.canvas,],
    }));

    /* LED. */
    this.ledInput = h("input.led-picker", {
      type: "color", value: "#a800f0", "aria-label": "LED colour"
    });
    this.ledSwatches = h("div.swatches", null, LED_PRESETS.map(([label, rgb]) => h("button.swatch", {
      type: "button",
      title: label,
      "aria-label": label,
      style: `--swatch: rgb(${rgb.join(",")})`,
      onclick: () => this.setLed(rgb),
    }, h("span.swatch-dot"), label)));
    grid.append(this.card({
      title: "RGB LED",
      id: "cardLed",
      source: "WS2812B",
      body: [h("p.hint", null, "The only write command Momentum takes over serial. Sends ", h("code", null, "rgb <R>, <G>, <B>"), " to the on-board addressable LED."), h("div.row", null, this.ledInput, h("button.primary", {
        type: "button",
        onclick: () => this.setLed(hexToRgb(this.ledInput.value)),
      }, "Set colour")), this.ledSwatches,],
    }));

    /* One-shot commands. */
    const commands = [["version", "version"], ["uid", "uid"], ["imu", "imu"], ["baro", "baro"], ["gnss", "gnss"], ["report", "report"],];
    this.uidValue = h("span.mono", null, "-");
    grid.append(this.card({
      title: "Commands",
      id: "cardCommands",
      source: "USART1 console",
      body: [h("p.hint", null, "Send one command by hand. Replies land in the panels above and, " + "raw, in the console tab. What ", h("code", null, "gnss"), " and ", h("code", null, "report"), " say about position is shown only once the GNSS card above is " + "open."), h("div.row.command-row", null, commands.map(([label, text]) => h("button", {
        type: "button", onclick: () => this.runCommand(text),
      }, label))), h("dl.facts", null, h("div", null, h("dt", null, "Firmware"), h("dd", null, this.version)), h("div", null, h("dt", null, "Device UID"), h("dd", null, this.uidValue))),],
    }));

    /*
     * A status strip above the grid, with nothing to set. How the numbers are
     * being obtained is worth saying - it explains why a stock board is quiet
     * until this page talks to it - but it is not a decision anyone should
     * have to make before the demo will do anything.
     */
    this.modeBadge = h("span.conn", {dataset: {state: "idle"}}, h("span.dot", {"aria-hidden": "true"}), h("span", {id: "modeText"}, "Idle"));

    const status = h("div.card.control-card", null, //
      h("div.card-head", null, h("h2", null, "Live data"), this.modeBadge), //
      h("p.hint", null, "Stock firmware answers questions but volunteers nothing, so the page " + "asks, five times a second: the quaternion every sweep, the barometer " + "every fourth and, once you open it, GNSS every tenth. A firmware that " + "streams telemetry on its own is detected and takes over."));

    return h("div.product", {id: "productMomentum"}, status, grid);
  }

  card({title, id, source, body}) {
    return h("section.card.demo-card", {id}, h("div.card-head", null, h("h2", null, title), h("span.card-source.push-end", null, source)), ...body);
  }

  /* ------------------------------------------------------------ incoming - */

  handleLine(line) {
    const parsed = parseLine(line);
    if (!parsed) return;

    switch (parsed.kind) {
      case "quaternion":
        this.readings.quaternion.set(parsed);
        break;
      case "barometric":
        this.readings.baro.set(parsed);
        this.pressureChart.push({pressure: parsed.pressure});
        this.tempChart.push({temperature: parsed.temperature});
        break;
      // Dropped outright while the card is closed. A stock board only sends
      // these when asked, but the `gnss` and `report` buttons can ask, and a
      // streaming board sends them whether anyone asked or not.
      case "gnssTime":
        if (this.gnssVisible) this.readings.gnssTime.set(parsed);
        break;
      case "gnssFix":
        if (this.gnssVisible) {
          this.readings.gnssFix.set(parsed);
          if (hasPosition(parsed)) this.trackPlot.push(parsed);
        }
        break;
      case "uid":
        this.readings.uid.set(parsed.uid);
        break;
      case "error":
        this.log(`Momentum: ${parsed.message}`, "warn");
        break;
      case "telemetry":
        this.noteStreaming();
        this.applyTelemetry(parsed.fields);
        break;
      default:
        break;
    }
    this.requestRender();
  }

  applyTelemetry(f) {
    const has = (...keys) => keys.every((key) => Number.isFinite(f[key]));

    if (has("qi", "qj", "qk", "qr")) {
      this.readings.quaternion.set({i: f.qi, j: f.qj, k: f.qk, r: f.qr});
    }
    if (has("pres", "temp")) {
      this.readings.baro.set({pressure: f.pres, temperature: f.temp});
      this.pressureChart.push({pressure: f.pres});
      this.tempChart.push({temperature: f.temp});
    }
    // A streaming board sends position unasked, so the same gate as the
    // command replies applies: nothing is kept while the card is closed.
    if (this.gnssVisible) {
      if (has("lat", "lon")) {
        const previous = this.readings.gnssFix.value || {};
        const fix = {latitude: f.lat, longitude: f.lon};
        this.readings.gnssFix.set({...previous, ...fix});
        if (hasPosition(fix)) this.trackPlot.push(fix);
      }
      if (has("alt")) {
        const previous = this.readings.gnssFix.value || {};
        this.readings.gnssFix.set({
          ...previous, altitude: f.alt, geoidSeparation: f.gid
        });
      }
      if (has("sat", "hdop")) {
        this.readings.gnssQuality.set({
          satellites: f.sat,
          hdop: f.hdop,
          fix: f.pf,
          speed: f.sp,
          course: f.cdeg,
        });
      }
      if (typeof f.d === "string" && typeof f.t === "string") {
        const date = String(f.d).split("-").map(Number);
        const time = String(f.t).split(":").map(Number);
        if (date.length === 3 && time.length === 3) {
          this.readings.gnssTime.set({
            year: date[0],
            month: date[1],
            day: date[2],
            hour: time[0],
            minute: time[1],
            second: time[2],
          });
        }
      }
    }

    for (const [key, axes] of [["accel", ["ax", "ay", "az"]], ["gyro", ["gx", "gy", "gz"]], ["mag", ["mx", "my", "mz"]], ["linAccel", ["lax", "lay", "laz"]], ["gravity", ["gvx", "gvy", "gvz"]],]) {
      if (!has(...axes)) continue;
      const value = {x: f[axes[0]], y: f[axes[1]], z: f[axes[2]]};
      this.readings[key].set(value);
      if (this.motionBlocks[key]) this.motionBlocks[key].chart.push(value);
    }
  }

  /**
   * Four telemetry lines inside two seconds is a firmware that talks on its
   * own; one stray line is not. Once that is established the poll is pointless
   * and actively harmful - every command the page sends is printed from the
   * device's receive interrupt, competing with the stream it is already
   * sending - so polling stops and does not come back on its own.
   */
  noteStreaming() {
    if (this.streaming) return;
    const now = performance.now();
    if (now - this._streamSince > 2000) {
      this._streamSince = now;
      this._streamHits = 0;
    }
    if (++this._streamHits < 4) return;

    this.streaming = true;
    if (this.polling) this.stopPolling();
    this.log("Streaming telemetry detected; polling paused", "ok");
    this.render();
  }

  /* ------------------------------------------------------------ outgoing - */

  async runCommand(text) {
    try {
      await this.link.send(text);
    } catch (err) {
      this.log(`Could not send "${text}": ${err.message}`, "error");
    }
  }

  setLed([r, g, b]) {
    this.ledInput.value = rgbToHex([r, g, b]);
    this.runCommand(`rgb ${r}, ${g}, ${b}`);
  }

  /**
   * Open or close the GNSS card. Closing discards the readings behind it, so
   * reopening shows what the receiver says now rather than where the board
   * was the last time anyone looked; opening asks immediately rather than
   * waiting up to two seconds for the next GNSS sweep.
   */
  setGnssVisible(visible) {
    this.gnssVisible = visible;
    this.gnssToggle.textContent = visible ? "Hide location" : "Show location";
    this.gnssBody.hidden = !visible;
    this.gnssClosedNote.hidden = visible;

    if (visible) {
      if (!this.streaming) this.runCommand("gnss");
    } else {
      for (const key of ["gnssFix", "gnssTime", "gnssQuality"]) {
        this.readings[key] = new Reading();
      }
      for (const dd of Object.values(this.gnssFacts.values)) dd.textContent = "-";
      // The track's origin is an absolute position too, so it goes with them.
      this.trackPlot.clear();
    }
    this.render();
  }

  startPolling() {
    this.stopPolling();
    this.polling = true;
    this._tick = 0;
    // Fire once immediately so the first numbers do not wait a whole sweep.
    this.sweep();
    this._timer = setInterval(() => this.sweep(), POLL_MS);
    this.render();
  }

  stopPolling() {
    this.polling = false;
    clearInterval(this._timer);
    this._timer = null;
    this.render();
  }

  /**
   * One poll sweep. Commands go out back to back rather than waiting for each
   * other's reply: the firmware handles one line at a time in order, and a
   * reply is matched by its shape wherever it lands, so there is nothing to
   * synchronise.
   */
  sweep() {
    const tick = this._tick++;
    const due = [];
    if (tick % DIVISORS.imu === 0) due.push("imu");
    if (tick % DIVISORS.baro === 0) due.push("baro");
    // Not asked for at all while the card is closed, so a position never
    // reaches the page - nor the raw console - unless someone opened it.
    if (this.gnssVisible && tick % DIVISORS.gnss === 0) due.push("gnss");
    for (const command of due) {
      this.link.send(command).catch((err) => {
        this.log(`Polling stopped: ${err.message}`, "error");
        this.stopPolling();
      });
    }
  }

  /* -------------------------------------------------------------- render - */

  /**
   * Coalesce to one repaint per frame. At the poll rate this changes little,
   * but a streaming board sends several hundred lines a second and each one
   * would otherwise rewrite the whole panel.
   */
  requestRender() {
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this.render();
    });
  }

  render() {
    const {readings} = this;

    /* Mode badge. */
    const live = this.streaming || readings.quaternion.fresh(this.freshWindow(DIVISORS.imu));
    this.modeBadge.dataset.state = live ? "ok" : this.polling ? "warn" : "idle";
    this.modeBadge.lastChild.textContent = this.streaming ? "Streaming" : this.polling ? (live ? "Polling" : "Polling, no replies") : "Stopped";

    /* Attitude. */
    const q = readings.quaternion.value;
    const attitude = this.attitudeFacts.values;
    if (q) {
      this.orientation.set(q);
      this.orientation.setStale(!live);
      const euler = quatToEuler(q);
      attitude.i.textContent = num(q.i, 3);
      attitude.j.textContent = num(q.j, 3);
      attitude.k.textContent = num(q.k, 3);
      attitude.r.textContent = num(q.r, 3);
      attitude.roll.textContent = num(euler.roll, 1, " deg");
      attitude.pitch.textContent = num(euler.pitch, 1, " deg");
      attitude.yaw.textContent = num(euler.yaw, 1, " deg");
    }
    this.orientation.draw();

    /* Environment. */
    const baro = readings.baro.value;
    const env = this.envFacts.values;
    if (baro) {
      env.pressure.textContent = `${num(baro.pressure, 0)} Pa (${num(baro.pressure / 100, 2)} hPa)`;
      env.temperature.textContent = num(baro.temperature, 2, " degC");
      env.altitude.textContent = num(pressureAltitude(baro.pressure), 1, " m");
    }
    this.pressureChart.draw();
    this.tempChart.draw();

    /* GNSS. Nothing is stored while the card is closed, so nothing to write. */
    const fix = readings.gnssFix.value;
    const quality = readings.gnssQuality.value;
    const time = readings.gnssTime.value;
    const gnss = this.gnssFacts.values;
    if (hasPosition(fix)) {
      // Six decimal places, matching the firmware's `%.6f`. The last digit is
      // below what a 32-bit float can hold - the spacing at a mid-latitude is
      // around half a metre - but printing fewer would throw away real
      // resolution.
      gnss.latitude.textContent = `${num(fix.latitude, 6)} deg ${dirLabel(fix.latDir)}`.trim();
      gnss.longitude.textContent = `${num(fix.longitude, 6)} deg ${dirLabel(fix.lonDir)}`.trim();
      gnss.altitude.textContent = num(fix.altitude, 1, " m");
    } else if (fix) {
      for (const key of ["latitude", "longitude", "altitude"]) {
        gnss[key].textContent = "no fix";
      }
    }
    const track = this.trackPlot.stats();
    if (track) {
      gnss.drift.textContent = `${num(track.distance, 1)} m (${num(track.north, 1)} N, ${num(track.east, 1)} E)`;
    }
    this.trackPlot.draw();
    if (quality) {
      gnss.fix.textContent = FIX_TYPES[quality.fix] ?? `type ${quality.fix}`;
      gnss.satellites.textContent = num(quality.satellites, 0);
      gnss.hdop.textContent = num(quality.hdop, 2);
      gnss.speed.textContent = num(quality.speed, 2, " kn");
      gnss.course.textContent = num(quality.course, 1, " deg");
    } else if (fix) {
      // The `gnss` command prints no fix quality at all. Say so rather than
      // leaving three dashes that read as "no signal".
      for (const key of ["fix", "satellites", "hdop", "speed", "course"]) {
        gnss[key].textContent = "not polled";
      }
    }
    if (time) {
      const pad = (n) => String(n).padStart(2, "0");
      gnss.utc.textContent = `${time.year}-${pad(time.month)}-${pad(time.day)} ` + `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
    }
    const gnssWindow = Math.max(this.freshWindow(DIVISORS.gnss), FRESH_GNSS_MS);
    // Not stale merely because it has never arrived: a card just opened, or a
    // receiver still searching for a fix, has nothing to dim.
    this.setStale(this.gnssFacts.el, !readings.gnssFix.missing && !readings.gnssFix.fresh(gnssWindow));
    this.setStale(this.attitudeFacts.el, !readings.quaternion.fresh(this.freshWindow(DIVISORS.imu)));
    this.setStale(this.envFacts.el, !readings.baro.fresh(this.freshWindow(DIVISORS.baro)));

    /* Motion. */
    let anyMotion = false;
    for (const [key, {
      block, chart, values
    }] of Object.entries(this.motionBlocks)) {
      const reading = readings[key];
      block.hidden = reading.missing;
      if (reading.missing) continue;
      anyMotion = true;
      values.x.textContent = num(reading.value.x, 2);
      values.y.textContent = num(reading.value.y, 2);
      values.z.textContent = num(reading.value.z, 2);
      chart.draw();
    }
    this.motionNote.hidden = anyMotion;

    /* Commands. */
    const uid = readings.uid.value;
    if (uid) this.uidValue.textContent = uid.join(" ");
  }

  setStale(el, stale) {
    el.classList.toggle("stale", stale);
  }

  /**
   * How long a reading fetched every `divisor` sweeps may go without an update
   * before it is dimmed. Three sweeps of slack absorbs a dropped reply without
   * flickering; a streaming board is not on a schedule at all.
   */
  freshWindow(divisor) {
    if (this.streaming) return FRESH_MS;
    return Math.max(FRESH_MS, POLL_MS * divisor * 3);
  }

  /** Redraw canvases that were laid out at zero size while the tab was hidden. */
  reflow() {
    this.orientation.draw({force: true});
    this.trackPlot.draw({force: true});
    this.pressureChart.draw({force: true});
    this.tempChart.draw({force: true});
    for (const {chart} of Object.values(this.motionBlocks)) chart.draw({force: true});
  }

  destroy() {
    this.stopPolling();
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._unsubscribe();
    this._unthemed();
  }
}

const FIX_TYPES = {
  0: "undetermined",
  1: "no fix",
  2: "GNSS limits exceeded",
  3: "DR limits exceeded",
  4: "dead reckoning",
  5: "RTK float",
  6: "RTK fixed",
  7: "GNSS fix",
};

/** Direction letters only; before the first fix the field is a NUL byte. */
function dirLabel(char) {
  return /^[NSEW]$/.test(char || "") ? `(${char})` : "";
}

/**
 * Whether a parsed fix actually locates anything.
 *
 * A receiver that has not acquired yet leaves the firmware's coordinates at
 * zero, and it prints those zeros just as readily as a real position - which
 * is a point in the Gulf of Guinea, several thousand kilometres from wherever
 * the board is. Left alone it would anchor the track plot there and put every
 * later fix off the edge of it. Indoors, which is where a demo usually
 * happens, this is the normal case rather than an edge one.
 */
function hasPosition(fix) {
  if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return false;
  return fix.latitude !== 0 || fix.longitude !== 0;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
}

export const momentum = {
  id: "momentum",
  name: "Momentum",
  summary: "9-DOF IMU, barometric pressure and multi-constellation GNSS on a Uno-footprint shield.",
  /** The name the `version` command prints, lower-cased. */
  matches: (name) => name === "momentum",
  create: (link, ctx) => new MomentumDemo(link, ctx),
};
