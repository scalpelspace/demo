/**
 * mc_stepper demo.
 *
 * A closed-loop stepper controller: a TMC2209 driver, an AS5047P encoder and a
 * position/speed control loop, reachable over the USART1 console.
 *
 * Two properties of this firmware shape everything below.
 *
 * One, it accepts a single command at a time. `comm_run()` is a 20 ms
 * scheduler task that executes at most one line per call, and the receive
 * interrupt *drops* a line that arrives while one is still pending, answering
 * "Error: command dropped". So nothing here writes to the link directly;
 * everything goes through a queue that spaces commands out (see CommandQueue).
 * This is the opposite of `momentum`, whose interrupt handles each line as it
 * lands and can be talked over freely.
 *
 * Two, it moves a motor. Every command that could is gated by the firmware on
 * the driver being enabled and unfaulted, and the page does not try to
 * second-guess those gates - it sends the command and shows the reason back if
 * the firmware refuses. A demo that hid the Enable button behind its own idea
 * of the state would be wrong the moment the two disagreed.
 *
 * Firmware reference: https://github.com/scalpelspace/mc_stepper
 */

import {DialGauge, StripChart, facts, h, num, onThemeChange} from "../ui.js";
import {VERSION_RE} from "../version.js";

/* --------------------------------------------------------------- parsing - */

/** A C `printf` float, in any of the forms `%f` and `%.4f` can produce. */
const FLOAT = "[-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?";

/**
 * Almost every reply is `<name> <value>` with an optional unit, because the
 * firmware prints them that way throughout - `pos 1.5708 rad`, `irun 8`,
 * `state idle`. One pattern reads them all and the routing table below decides
 * what each means, which beats twenty near-identical regexes that would have
 * to be kept in step with `comm.c` one by one.
 *
 * The unit is part of the identity, not decoration: `pos 1.5708 rad` is the
 * measured position from `stat`, while `pos 1.5708` with no unit is the
 * acknowledgement of a position command. Same word, different reading.
 */
const UNITS = ["rad/s\\^2", "rad/s", "rad", "steps/s", "mA"];
const READOUT_RE = new RegExp(`^([a-z][a-z0-9_]*) (\\S+)(?: (${UNITS.join("|")}))?$`);

const PATTERNS = [// "mc_stepper 0.3.1.p", shared with the connect handshake.
  {
    kind: "version", re: VERSION_RE, map: (m) => ({
      product: m[1], version: `${m[2]}.${m[3]}.${m[4]}.${m[5]}`,
    }),
  }, // "41293 8172 55031" - the 48-bit UID as three 16-bit parts.
  {
    kind: "uid", re: /^(\d{1,5}) (\d{1,5}) (\d{1,5})$/, map: (m) => ({
      uid: [Number(m[1]), Number(m[2]), Number(m[3])],
    }),
  }, {
    kind: "zero", re: /^zero requested, applied at standstill$/, map: () => ({})
  }, {kind: "error", re: /^Error: (.+)$/, map: (m) => ({message: m[1]})},];

/**
 * Where each readout belongs: `[group, field, type]`, keyed by the printed
 * name and, where it disambiguates, its unit.
 *
 * A name missing from here is not an error. The motion acknowledgements
 * (`pos`, `rel`, `spd`, `ol` with no unit) land there deliberately, and so
 * does anything a later firmware adds.
 */
const READOUTS = {
  "state": ["control", "state", "word"],
  "mode": ["control", "mode", "word"],
  "pos|rad": ["motion", "position", "float"],
  "pos_sp|rad": ["motion", "positionSetpoint", "float"],
  "pos_err|rad": ["motion", "positionError", "float"],
  "vel_sp|rad/s": ["motion", "velocitySetpoint", "float"],
  "step_rate|steps/s": ["motion", "stepRate", "float"],
  "drv_status": ["driver", "status", "hex"],
  "microsteps": ["config", "microsteps", "int"],
  "max_accel|rad/s^2": ["config", "maxAccel", "float"],
  "max_vel|rad/s": ["config", "maxVelocity", "float"],
  "run_current|mA": ["config", "runCurrentMa", "int"],
  "irun": ["config", "irun", "int"],
  "ihold": ["config", "ihold", "int"],
  "iholddelay": ["config", "iholdDelay", "int"],
  "kp": ["config", "kp", "float"],
  "ki": ["config", "ki", "float"],
  "kd": ["config", "kd", "float"],
  "stallguard": ["stall", "enabled", "int"],
  "sgthrs": ["stall", "threshold", "int"],
  "sg_result": ["stall", "result", "int"],
  "stalled": ["stall", "stalled", "int"],
};

/** The command words whose bare `<word> <number>` reply is an acknowledgement. */
const MOTION_WORDS = new Set(["pos", "rel", "spd", "ol"]);

export function parseLine(line) {
  for (const {kind, re, map} of PATTERNS) {
    const match = re.exec(line);
    if (match) return {kind, ...map(match)};
  }

  const match = READOUT_RE.exec(line);
  if (!match) return null;
  const [, name, raw, unit] = match;

  const route = READOUTS[unit ? `${name}|${unit}` : name];
  if (route) {
    const [group, field, type] = route;
    let value = raw;
    if (type === "float" || type === "int") value = Number(raw);
    if (type === "hex") value = Number.parseInt(raw, 16);
    if ((type === "float" || type === "int" || type === "hex") && !Number.isFinite(value)) {
      return null;
    }
    return {kind: "readout", group, field, value};
  }

  if (!unit && MOTION_WORDS.has(name) && new RegExp(`^${FLOAT}$`).test(raw)) {
    return {kind: "ack", command: name, setpoint: Number(raw)};
  }
  return null;
}

/**
 * The packed status word from `stat`, bit for bit as `tmc2209_runner.h`
 * documents it: GSTAT[2:0] in bits 0-2, DRV_STATUS[7:0] in bits 3-10.
 *
 * `reset` is not a fault - the TMC2209 raises it once after power-up and it
 * stays until GSTAT is read - so it is labelled as the notice it is rather
 * than lit up red alongside a short to ground.
 */
const STATUS_BITS = [{bit: 0, label: "reset", notice: true}, {
  bit: 1, label: "drv_err"
}, {bit: 2, label: "uv_cp"}, {
  bit: 3, label: "otpw"
}, {bit: 4, label: "ot"}, {bit: 5, label: "s2ga"}, {
  bit: 6, label: "s2gb"
}, {bit: 7, label: "s2vsa"}, {
  bit: 8, label: "s2vsb"
}, {bit: 9, label: "ola"}, {bit: 10, label: "olb"},];

/* ------------------------------------------------------------ freshness -- */

const FRESH_MS = 1500;

class Reading {
  constructor() {
    this.value = null;
    this.at = 0;
  }

  set(value) {
    this.value = value;
    this.at = performance.now();
  }

  /** Merge one field, keeping whatever else has arrived. */
  merge(field, value) {
    this.set({...(this.value || {}), [field]: value});
  }

  get missing() {
    return this.at === 0;
  }

  fresh(within = FRESH_MS) {
    return !this.missing && performance.now() - this.at < within;
  }
}

/* -------------------------------------------------------- command queue -- */

/**
 * One command at a time, with a gap between them.
 *
 * The firmware's receive interrupt holds exactly one pending line and drops
 * anything that arrives while it is still there; `comm_run()` clears it on a
 * 20 ms schedule. So two commands sent back to back lose the second, and the
 * page would be reading a status that silently never refreshed.
 *
 * 80 ms is the gap: 20 ms of scheduler period, up to ~16 ms to transmit the
 * eight lines `stat` prints at 115200 baud, and the rest as margin for a board
 * whose main loop is busy driving a motor.
 */
const COMMAND_GAP_MS = 80;

/**
 * A hard ceiling on the queue. Nothing should ever reach it - the poll backs
 * off long before (see `sweep`) - so it exists for the case the poll cannot
 * see: someone leaning on the Send buttons. Refusing loudly beats accepting a
 * command that will not go out for two seconds.
 */
const MAX_QUEUE = 16;

class CommandQueue {
  constructor(link, log) {
    this.link = link;
    this.log = log;
    this.pending = [];
    this._timer = null;
    this._running = false;
  }

  /**
   * @param {string} text command line to send
   * @param {{coalesce?: boolean}} [options] `coalesce` skips the send when an
   *   identical command is already waiting, so a poll that outruns the queue
   *   asks once rather than piling up duplicates of the same question.
   */
  push(text, {coalesce = false} = {}) {
    if (coalesce && this.pending.includes(text)) return;
    if (this.pending.length >= MAX_QUEUE) {
      this.log(`Too many commands queued; "${text}" was not sent`, "warn");
      return;
    }
    this.pending.push(text);
    if (!this._running) this._drain();
  }

  _drain() {
    const text = this.pending.shift();
    if (text === undefined) {
      this._running = false;
      return;
    }
    this._running = true;
    this.link.send(text).catch((err) => {
      this.log(`Could not send "${text}": ${err.message}`, "error");
    });
    this._timer = setTimeout(() => this._drain(), COMMAND_GAP_MS);
  }

  stop() {
    this.pending.length = 0;
    clearTimeout(this._timer);
    this._timer = null;
    this._running = false;
  }
}

/* ------------------------------------------------------------- the demo -- */

/*
 * Polling this board is not free, and not in the usual way.
 *
 * `_write()` is a *blocking* `HAL_UART_Transmit`, and `comm_run()` is a
 * cooperative task in the same main loop as `controls_run` - which is a 1 ms
 * task. A `stat` reply is eight lines, about 155 bytes, which at 115200 baud
 * holds that loop for roughly 13.5 ms. Worse, the scheduler's catch-up skips
 * missed slots rather than running them late, so those 13.5 ms are about
 * thirteen control ticks that never happen, and the loop's fixed-dt maths
 * treats the gap as a single tick.
 *
 * So every sweep is measured in skipped control ticks, and the numbers below
 * are chosen to keep that small: `stat` twice a second is ~27 ms/s of blocked
 * loop, a little under 3%, against nearly 6% at the 4 Hz this first ran at.
 * `sg` adds 52 bytes (~4.5 ms) and is only asked for when StallGuard is
 * actually switched on.
 *
 * The page cannot do better than this on its own. The fix that would make the
 * rate stop mattering is in the firmware: a DMA or interrupt-driven `_write()`
 * would cost the main loop microseconds instead of milliseconds, the way the
 * receive side already works.
 */
const POLL_MS = 500;

/** StallGuard's load reading is live, but it is not worth a whole sweep. */
const SG_EVERY = 4;

/**
 * Sweeps between polls while the motor is parked. In `disable` and `fault` the
 * driver is not driving anything, so nothing in `stat` can change except in
 * reply to a command - and those replies carry the new state themselves. A
 * board sitting on the bench between demos costs a poll every two seconds.
 */
const PARKED_EVERY = 4;

/** States in which nothing can move, so nothing needs watching closely. */
const PARKED_STATES = new Set(["disable", "fault"]);

/** Queue depth at which the poll stands aside and asks for nothing. */
const SWEEP_SKIP_AT = 3;

/** Read once on mount, and again whenever a write echoes new values back. */
const CONFIG_COMMANDS = ["motion", "cur", "gains", "sg"];


/** Control states in which the loop is live and the motor may move. */
const LIVE_STATES = new Set(["idle", "start", "executing", "on_target"]);

class StepperDemo {
  /**
   * @param {import("../link.js").DeviceLink} link
   * @param {{log: (msg: string, level?: string) => void, version: string}} ctx
   */
  constructor(link, ctx) {
    this.link = link;
    this.log = ctx.log;
    this.version = ctx.version;
    this.queue = new CommandQueue(link, this.log);

    this.readings = {
      control: new Reading(),
      motion: new Reading(),
      driver: new Reading(),
      stall: new Reading(),
      config: new Reading(),
      uid: new Reading(),
    };

    this.polling = false;
    this._tick = 0;
    this._timer = null;
    this._frame = null;
    this._unsubscribe = link.onLine((line) => this.handleLine(line));

    this.el = this.build();
    this.render();
    this._unthemed = onThemeChange(() => this.reflow());

    /*
     * Disabled first, before anything else is asked.
     *
     * A board that has just come up is disabled already - `controls_state`
     * starts at CONTROLS_DISABLE and `tmc2209_init` runs with `enable` false -
     * so on a clean connect this changes nothing. It is here for the connect
     * that was not clean: the boot lines may not have been drivable, in which
     * case the page carried on without resetting anything, and the board on
     * the other end could be one somebody left running. Opening a window onto
     * a moving motor and calling it the starting state is the wrong default.
     *
     * Starting the motor is the operator's move, on the Enable button, and
     * nothing here does it for them. The reply also fills in the Control card
     * a poll sooner than the first `stat` would, and it leaves the board in
     * the state that `motion` and `cur` writes require.
     */
    this.queue.push("dis");

    // The configuration is static until something writes it, so it is read
    // once here and refreshed only when a write echoes back.
    for (const command of CONFIG_COMMANDS) this.queue.push(command);
    this.startPolling();
  }

  /* -------------------------------------------------------------- markup - */

  build() {
    const grid = h("div.demo-grid");

    /*
     * Every settable value on the page is a number in a labelled box, read
     * back from the board and applied as one command, so both are built here
     * once - by the setpoint card as well as the configuration one.
     */
    this.configInputs = {};
    const field = (key, label, attrs) => {
      const input = h("input", {type: "number", ...attrs});
      this.configInputs[key] = input;
      return h("label", null, label, input);
    };
    const group = (title, note, fields, command, build) => h("div.config-group", null, //
      h("p.chart-label", null, title), //
      note ? h("p.hint", null, note) : null, //
      h("div.grid", null, fields), //
      h("div.row", null, h("button", {
        type: "button", onclick: () => this.applyConfig(command, build)
      }, "Apply"), h("button", {
        type: "button", onclick: () => this.queue.push(command)
      }, "Read back")));

    /* Control. */
    this.stateBadge = h("span.conn", {dataset: {state: "idle"}}, h("span.dot", {"aria-hidden": "true"}), h("span", null, "Unknown"));
    /*
     * State, mode, step rate and the driver's own status word all arrive in
     * the same `stat` reply and answer one question between them: is this
     * thing running, and does the hardware agree? Splitting the last two into
     * a card of their own meant reading half the answer, scrolling, and
     * reading the rest.
     */
    this.controlFacts = facts([["state", "State"], ["mode", "Mode"], ["stepRate", "Step rate"], ["status", "DRV_STATUS"],]);
    this.statusFlags = h("div.flags", null, STATUS_BITS.map(({
                                                               bit, label
                                                             }) => h("span.flag", {dataset: {bit: String(bit)}}, label)));
    grid.append(this.card({
      title: "Control",
      id: "cardControl",
      source: "control loop and TMC2209",
      head: this.stateBadge,
      body: [h("p.hint", null, "A setpoint needs the driver enabled and any latched fault cleared."), h("div.row", null, //
        h("button.primary", {
          type: "button", onclick: () => this.run("en")
        }, "Enable"), //
        h("button", {
          type: "button", onclick: () => this.run("dis")
        }, "Disable"), //
        h("button", {type: "button", onclick: () => this.run("stop")}, "Stop"), //
        h("button", {type: "button", onclick: () => this.run("zero")}, "Zero"), //
        h("button", {
          type: "button", onclick: () => this.run("clr")
        }, "Clear fault")), this.controlFacts.el, h("p.chart-label", null, "Status flags"), this.statusFlags,],
    }));

    /* Position. */
    this.dial = new DialGauge(h("canvas.dial-canvas", {"aria-label": "Shaft angle"}));
    this.positionFacts = facts([["position", "Position"], ["setpoint", "Setpoint"], ["error", "Error"],]);
    this.positionChart = new StripChart(h("canvas.chart", {"aria-label": "Position history"}), {
      series: [{key: "position", color: "--accent"}, {
        key: "setpoint", color: "--text-faint"
      }], minRange: 0.5, digits: 2,
    });
    grid.append(this.card({
      title: "Position",
      id: "cardPosition",
      source: "AS5047P encoder",
      body: [h("div.dial", null, this.dial.canvas), this.positionFacts.el, h("p.chart-label", null, "Position and setpoint (rad)"), this.positionChart.canvas,],
    }));

    /* Setpoints. */
    this.setpointInputs = {};
    const setpointRow = ([command, label, unit, placeholder]) => {
      const input = h("input.command-input", {
        type: "number",
        step: "0.001",
        placeholder,
        "aria-label": `${label} setpoint`
      });
      this.setpointInputs[command] = input;
      const send = () => this.sendSetpoint(command, input.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          send();
        }
      });
      return h("div.setpoint-row", null, //
        h("span.setpoint-name", null, command), //
        input, //
        h("span.setpoint-unit", null, unit), //
        h("button", {type: "button", onclick: send}, "Send"));
    };
    /*
     * The gains sit with the setpoints because they are the same job. Tuning
     * is a loop: send a setpoint, watch the trace on the Position card, change
     * a gain, send it again. Splitting the two across cards put a scroll
     * between the two halves of one motion.
     *
     * It is also why they are not in Configuration. Everything there is set
     * once for a given motor and left alone, and half of it can only be
     * written with the driver disabled - the opposite of tuning, which is done
     * live against a moving loop.
     */
    grid.append(this.card({
      title: "Setpoint and tuning",
      id: "cardSetpoint",
      source: "motion and control loop",
      body: [h("div.config-group", null, [["pos", "Absolute position", "rad", "absolute"], ["rel", "Relative position", "rad", "offset"], ["spd", "Speed", "rad/s", "speed"], ["ol", "Open-loop position", "rad", "absolute"],].map(setpointRow)), //
        group("Position PID", "Applied live, without resetting the integrator - a large jump lands " + "as a step input on a moving loop.", [field("kp", "Kp", {step: "0.1"}), field("ki", "Ki", {step: "0.1"}), field("kd", "Kd", {step: "0.1"}),], "gains", () => [this.configInputs.kp.value, this.configInputs.ki.value, this.configInputs.kd.value,]),],
    }));

    /*
     * StallGuard, next to the driver it belongs to, and reading and setting in
     * one card for the same reason the gains sit with the setpoints: choosing
     * SGTHRS means watching SG_RESULT under load and putting the threshold
     * below where it settles. With the number on one card and the field on
     * another, that is done from memory.
     */
    this.stallFacts = facts([["result", "SG_RESULT"], ["stalled", "Stalled"],]);
    this.sgChart = new StripChart(h("canvas.chart.chart-short", {"aria-label": "StallGuard history"}), {
      series: [{key: "result", color: "--accent"}], minRange: 20, digits: 0,
    });
    grid.append(this.card({
      title: "StallGuard",
      id: "cardStallGuard",
      source: "TMC2209",
      body: [h("div.config-group", null, //
        h("p.chart-label", null, "Load"), //
        this.stallFacts.el, //
        this.sgChart.canvas, //
        h("p.hint.card-note", null, "SG_RESULT falls as the motor loads up, and a stall latches once it " + "drops below SGTHRS. It only reads meaningfully while the motor is " + "turning - and the page only asks for it while StallGuard is switched " + "on below, so with it off these hold whatever they last said.")), //
        group("Configuration", null, [field("stallEnabled", "Enabled (0 or 1)", {
          min: 0, max: 1, step: 1
        }), field("threshold", "SGTHRS", {
          min: 0, max: 255, step: 1
        }),], "sg", () => [this.configInputs.stallEnabled.value, this.configInputs.threshold.value,]),],
    }));

    /* Configuration. */
    grid.append(this.card({
      title: "Configuration",
      id: "cardConfig",
      source: "controls and TMC2209",
      body: [group("Motion envelope", "The firmware refuses these while the driver is enabled: changing " + "the microstep resolution mid-move would glitch the step stream. " + "Disable first.", [field("microsteps", "Microsteps", {
        min: 1, max: 256, step: 1
      }), field("maxAccel", "Accel (rad/s²)", {
        step: "0.1", min: 0
      }), field("maxVelocity", "Max velocity (rad/s)", {
        step: "0.1", min: 0
      }),], "motion", () => [this.configInputs.microsteps.value, this.configInputs.maxAccel.value, this.configInputs.maxVelocity.value,]), //

        group("Current", "Also disabled-only: a current change under load steps the torque " + "envelope.", [field("runCurrentMa", "Run current (mA)", {
          min: 0, max: 65535, step: 1
        }), field("irun", "IRUN", {
          min: 0, max: 31, step: 1
        }), field("ihold", "IHOLD", {
          min: 0, max: 31, step: 1
        }), field("iholdDelay", "IHOLDDELAY", {
          min: 0, max: 15, step: 1
        }),], "cur", () => [this.configInputs.runCurrentMa.value, this.configInputs.irun.value, this.configInputs.ihold.value, this.configInputs.iholdDelay.value,]),],
    }));

    /* One-shot commands. */
    this.uidValue = h("span", null, "-");
    grid.append(this.card({
      title: "Commands",
      id: "cardCommands",
      source: "USART1 console",
      body: [h("p.hint", null, "Send one command by hand. Replies land in the panels above and, raw, " + "in the console tab - which is the only place ", h("code", null, "help"), " output shows, since it is prose rather than readings."), h("div.row.command-row", null, ["help", "version", "uid", "stat", "motion", "cur", "gains", "sg"].map((text) => h("button", {
        type: "button", onclick: () => this.run(text),
      }, text))), h("dl.facts", null, h("div", null, h("dt", null, "Firmware"), h("dd", null, this.version)), h("div", null, h("dt", null, "Device UID"), h("dd", null, this.uidValue))),],
    }));

    this.modeBadge = h("span.conn", {dataset: {state: "idle"}}, h("span.dot", {"aria-hidden": "true"}), h("span", null, "Idle"));
    const status = h("div.card.control-card", null, //
      h("div.card-head", null, h("h2", null, "Live data"), this.modeBadge), //
      h("p.hint", null, "This firmware executes one command every 20 ms, drops anything sent on " + "top of a line it has not run yet, and prints from the same loop that " + "runs the control law - so the page queues its commands, spaces them " + "out and asks for as little as it can. ", h("code", null, "stat"), " goes out twice a second, once every two while the motor is parked; " + "StallGuard only when it is switched on, and the configuration only " + "when something changes it."));

    return h("div.product", {id: "productStepper"}, status, grid);
  }

  card({title, id, source, head, body}) {
    return h("section.card.demo-card", {id}, h("div.card-head", null, h("h2", null, title), head || h("span.card-source.push-end", null, source)), ...body);
  }

  /* ------------------------------------------------------------ incoming - */

  handleLine(line) {
    const parsed = parseLine(line);
    if (!parsed) return;

    switch (parsed.kind) {
      case "readout":
        this.applyReadout(parsed);
        break;
      case "ack":
        this.log(`${parsed.command} setpoint ${parsed.setpoint}`, "ok");
        break;
      case "zero":
        this.log("Zero requested; applied at the next standstill", "ok");
        break;
      case "uid":
        this.readings.uid.set(parsed.uid);
        break;
      case "error":
        // The firmware refuses rather than silently dropping, so its reason is
        // the most useful thing on the page when a command does nothing.
        this.log(`mc_stepper: ${parsed.message}`, "warn");
        break;
      default:
        break;
    }
    this.requestRender();
  }

  applyReadout({group, field, value}) {
    this.readings[group].merge(field, value);

    if (group === "motion" && field === "position") {
      const setpoint = (this.readings.motion.value || {}).positionSetpoint;
      this.positionChart.push({position: value, setpoint});
    }
    if (group === "stall" && field === "result") {
      this.sgChart.push({result: value});
    }
    // The configuration inputs are only seeded from the board, never fought
    // over: a value the operator is part-way through typing is left alone.
    //
    // Both groups, not just `config`: `sg` prints its two settings alongside
    // two live readings, so StallGuard's configuration arrives labelled as
    // status. The readings among them simply have no input to seed.
    if (group === "config" || group === "stall") this.seedConfigInput(field, value);
  }

  /** `stall.enabled` is the only field whose input is not named after it. */
  seedConfigInput(field, value) {
    const key = field === "enabled" ? "stallEnabled" : field;
    const input = this.configInputs[key];
    if (input && document.activeElement !== input) input.value = String(value);
  }

  /* ------------------------------------------------------------ outgoing - */

  /** Everything the page sends goes through the queue, never straight out. */
  run(text) {
    this.queue.push(text);
  }

  sendSetpoint(command, raw) {
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      this.log(`${command}: enter a number first`, "warn");
      return;
    }
    this.run(`${command} ${value}`);
  }


  /**
   * Send a configuration write, then read it back. The firmware echoes the
   * applied values on success and an error on refusal, so the read-back is
   * belt and braces - but it is also what corrects the form after a partial
   * write, which is exactly the case where the screen must not keep showing
   * what was typed as though it had taken.
   */
  applyConfig(command, buildArgs) {
    const args = buildArgs().map((value) => String(value).trim());
    if (args.some((value) => value === "")) {
      this.log(`${command}: fill in every field first`, "warn");
      return;
    }
    this.run(`${command} ${args.join(" ")}`);
    this.run(command);
  }

  startPolling() {
    this.stopPolling();
    this.polling = true;
    this._tick = 0;
    this.sweep();
    this._timer = setInterval(() => this.sweep(), POLL_MS);
    this.render();
  }

  stopPolling() {
    this.polling = false;
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * One poll sweep, and the only thing on the page allowed to skip itself.
   *
   * A refresh is worth nothing if it arrives late, so the poll gives way to
   * anything already waiting rather than queueing behind it. That back
   * pressure is what keeps the queue bounded when the drain slows down, and it
   * does slow down: a browser throttles a background tab's timers to about
   * one a second, at which point an unconditional sweep would enqueue two
   * commands for every one that went out and the page would fall further
   * behind for as long as it stayed hidden. Coalescing alone does not save it,
   * since `stat` and `sg` are different strings.
   */
  sweep() {
    const tick = this._tick++;
    if (this.queue.pending.length >= SWEEP_SKIP_AT) return;
    if (this.parked() && tick % PARKED_EVERY !== 0) return;

    this.queue.push("stat", {coalesce: true});
    // Asking a board with StallGuard switched off for its load reading buys
    // two constants and a zero, for 4.5 ms of blocked control loop.
    if (this.stallGuardOn() && tick % SG_EVERY === 0) {
      this.queue.push("sg", {coalesce: true});
    }
  }

  parked() {
    return PARKED_STATES.has((this.readings.control.value || {}).state);
  }

  stallGuardOn() {
    return Boolean((this.readings.stall.value || {}).enabled);
  }

  /** How long a `stat` reading stays live, given the rate it is asked at. */
  freshWindow() {
    return POLL_MS * (this.parked() ? PARKED_EVERY + 1 : 3);
  }

  /* -------------------------------------------------------------- render - */

  requestRender() {
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this.render();
    });
  }

  render() {
    const {readings} = this;
    const live = readings.control.fresh(this.freshWindow());

    /* Live badge. */
    this.modeBadge.dataset.state = live ? "ok" : this.polling ? "warn" : "idle";
    this.modeBadge.lastChild.textContent = live ? "Polling" : this.polling ? "Polling, no replies" : "Stopped";

    /* Control, including what the driver makes of it. */
    const control = readings.control.value || {};
    const driver = readings.driver.value || {};
    const motion = readings.motion.value || {};
    const state = control.state;
    const controlValues = this.controlFacts.values;

    this.stateBadge.dataset.state = state === "fault" ? "error" : LIVE_STATES.has(state) ? "ok" : "idle";
    this.stateBadge.lastChild.textContent = state ? state : "Unknown";
    if (state) controlValues.state.textContent = state;
    if (control.mode) controlValues.mode.textContent = control.mode;
    if (Number.isFinite(motion.stepRate)) {
      controlValues.stepRate.textContent = num(motion.stepRate, 1, " steps/s");
    }
    if (Number.isFinite(driver.status)) {
      controlValues.status.textContent = "0x" + driver.status.toString(16).padStart(4, "0").toUpperCase();
      for (const {bit, notice} of STATUS_BITS) {
        const chip = this.statusFlags.children[bit];
        const set = (driver.status & (1 << bit)) !== 0;
        chip.classList.toggle("set", set && !notice);
        chip.classList.toggle("notice", set && Boolean(notice));
      }
    }
    // Every field above arrives in the same `stat` reply, so one staleness.
    this.setStale(this.controlFacts.el, !live && !readings.control.missing);

    /* Position. */
    const position = this.positionFacts.values;
    if (Number.isFinite(motion.position)) {
      this.dial.set({
        measured: motion.position, setpoint: motion.positionSetpoint
      });
      this.dial.setStale(!live);
      position.position.textContent = num(motion.position, 4, " rad");
    }
    if (Number.isFinite(motion.positionSetpoint)) {
      position.setpoint.textContent = num(motion.positionSetpoint, 4, " rad");
    }
    if (Number.isFinite(motion.positionError)) {
      position.error.textContent = num(motion.positionError, 4, " rad");
    }
    this.setStale(this.positionFacts.el, !live && !readings.motion.missing);
    this.dial.draw();
    this.positionChart.draw();

    /* StallGuard. */
    const stall = readings.stall.value || {};
    const stallValues = this.stallFacts.values;
    if (Number.isFinite(stall.result)) stallValues.result.textContent = num(stall.result, 0);
    if (Number.isFinite(stall.stalled)) {
      stallValues.stalled.textContent = stall.stalled ? "yes" : "no";
    }
    this.sgChart.draw();

    /* Commands. */
    const uid = readings.uid.value;
    if (uid) this.uidValue.textContent = uid.join(" ");
  }

  setStale(el, stale) {
    el.classList.toggle("stale", stale);
  }

  reflow() {
    this.dial.draw({force: true});
    this.positionChart.draw({force: true});
    this.sgChart.draw({force: true});
  }

  destroy() {
    this.stopPolling();
    this.queue.stop();
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._unsubscribe();
    this._unthemed();
  }
}

export const mcStepper = {
  id: "mc_stepper",
  name: "Stepper motor controller",
  summary: "Closed-loop stepper control: a TMC2209 driver and an AS5047P encoder, over a UART breakout.",
  links: [{
    label: "Firmware", href: "https://github.com/scalpelspace/mc_stepper"
  }, {
    label: "Hardware", href: "https://github.com/scalpelspace/mc_stepper_pcb"
  }, {
    label: "Driver", href: "https://github.com/scalpelspace/mc_stepper_driver"
  },],
  matches: (name) => name === "mc_stepper",
  create: (link, ctx) => new StepperDemo(link, ctx),
};
