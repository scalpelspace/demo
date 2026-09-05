/**
 * Small DOM helpers and the canvas widgets the demos draw with.
 *
 * No dependencies on purpose. The site is served as plain files from GitHub
 * Pages, and a chart library would be more code than the charts it would draw
 * here.
 *
 * `cssVar` and `fitCanvas` are exported although nothing outside this file
 * uses them yet: they are what a new product's own canvas would need, and both
 * hold knowledge that is easy to get wrong on a second attempt - reading the
 * palette from custom properties so a drawing follows the light/dark switch,
 * and sizing to device pixels while surviving a zero-sized layout in a hidden
 * tab.
 */

/** Hyperscript: h("div.card", {id: "x"}, "text", child, [children]). */
export function h(spec, attrs = null, ...children) {
  const [tag, ...classes] = String(spec).split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && (attrs.nodeType || Array.isArray(attrs) || typeof attrs === "string")) {
    children.unshift(attrs);
  } else if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") {
        el.className = el.className ? `${el.className} ${value}` : value;
      } else if (key === "style") {
        // Assigning to el.style works, but going through the attribute keeps
        // custom properties (--swatch and friends) intact.
        el.setAttribute("style", value);
      } else if (key === "dataset") {
        Object.assign(el.dataset, value);
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && key !== "list" && key !== "type" && key !== "step") {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? "" : value);
      }
    }
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(append); else el.append(child.nodeType ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);
  return el;
}

/** A <dl class="facts"> row set; returns the element plus its <dd> map. */
export function facts(entries) {
  const values = {};
  const list = h("dl.facts", null, entries.map(([key, label]) => {
    const dd = h("dd", null, "-");
    values[key] = dd;
    return h("div", null, h("dt", null, label), dd);
  }));
  return {el: list, values};
}

/** Fixed-point text for a possibly-missing number. */
export function num(value, digits = 2, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toFixed(digits) + suffix;
}

export function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Run `redraw` whenever the palette could have changed. Canvases paint pixels
 * rather than resolving custom properties, so unlike everything else on the
 * page they do not follow the system light/dark switch on their own.
 */
export function onThemeChange(redraw) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => redraw();
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/**
 * Size a canvas to its CSS box at the display's pixel density and scale the
 * context so drawing code can work in CSS pixels. Returns the context and the
 * box in CSS pixels, or null while the element is still laid out at zero (a
 * hidden tab), which is the caller's cue to skip the frame.
 */
export function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {ctx, width, height};
}

/**
 * Axis colours. Fixed hues rather than theme tokens: these encode which axis
 * is which, so they have to mean the same thing in both schemes, and all
 * three clear 3:1 against both page backgrounds.
 *
 * Duplicated in site.css as the `.axis[data-axis]` edge colours, because a
 * canvas cannot read a class and CSS cannot read this object. Change both, or
 * a trace stops matching the number beside it.
 */
export const AXIS_COLORS = {x: "#e5484d", y: "#30a46c", z: "#3b82f6"};

/* ------------------------------------------------------------ strip chart - */

/**
 * A scrolling multi-series line chart over the last N samples.
 *
 * Sample-indexed rather than time-indexed: the demos push one point per
 * update, and an update arrives when the device answers, so wall-clock
 * spacing is exactly the thing that is not uniform. Plotting against sample
 * number keeps a dropped reply from stretching the trace.
 */
export class StripChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * A series colour may be a custom property name ("--accent"), which is
   * resolved at draw time so the trace follows the light/dark switch the way
   * the rest of the page does.
   *
   * @param {{series: {key: string, color: string}[], span?: number,
   *          symmetric?: boolean, minRange?: number, digits?: number}} options
   */
  constructor(canvas, {
    series, span = 240, symmetric = false, minRange = 0.1, digits = 2
  }) {
    this.canvas = canvas;
    this.series = series;
    this.span = span;
    this.symmetric = symmetric;
    this.minRange = minRange;
    this.digits = digits;
    this.data = new Map(series.map((s) => [s.key, []]));
    this._dirty = true;
  }

  push(values) {
    for (const {key} of this.series) {
      const points = this.data.get(key);
      const value = values[key];
      points.push(Number.isFinite(value) ? value : null);
      if (points.length > this.span) points.shift();
    }
    this._dirty = true;
  }

  clear() {
    for (const points of this.data.values()) points.length = 0;
    this._dirty = true;
  }

  /** Cheap enough to call every animation frame; skips when nothing changed. */
  draw({force = false} = {}) {
    if (!this._dirty && !force) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    this._dirty = false;
    const {ctx, width, height} = fit;
    ctx.clearRect(0, 0, width, height);

    const pad = {top: 8, right: 8, bottom: 8, left: 44};
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    if (plotW < 20 || plotH < 20) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (const points of this.data.values()) {
      for (const value of points) {
        if (value === null) continue;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (this.symmetric) {
      const reach = Math.max(Math.abs(lo), Math.abs(hi), this.minRange / 2);
      lo = -reach;
      hi = reach;
    } else if (hi - lo < this.minRange) {
      const mid = (hi + lo) / 2;
      lo = mid - this.minRange / 2;
      hi = mid + this.minRange / 2;
    }
    const headroom = (hi - lo) * 0.08;
    lo -= headroom;
    hi += headroom;

    const yFor = (value) => pad.top + plotH * (1 - (value - lo) / (hi - lo));
    const xFor = (index) => pad.left + (plotW * index) / Math.max(1, this.span - 1);

    const border = cssVar("--border", "#e4e4e9");
    const faint = cssVar("--text-faint", "#85858f");

    // Frame and gridlines: three labelled levels is enough to read a scale
    // off without turning the card into a lab instrument.
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.fillStyle = faint;
    ctx.font = "11px " + cssVar("--font-mono", "monospace");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const level of [hi, (hi + lo) / 2, lo]) {
      const y = Math.round(yFor(level)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(level.toFixed(this.digits), pad.left - 6, y);
    }

    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const {key, color} of this.series) {
      const points = this.data.get(key);
      // Right-align the trace so the newest sample is always at the edge.
      const offset = this.span - points.length;
      ctx.strokeStyle = color.startsWith("--") ? cssVar(color, "#7a00d4") : color;
      ctx.beginPath();
      let pen = false;
      points.forEach((value, index) => {
        if (value === null) {
          pen = false;
          return;
        }
        const x = xFor(index + offset);
        const y = yFor(value);
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      });
      ctx.stroke();
    }
  }
}

/* ------------------------------------------------------------ track plot - */

/**
 * Metres per degree of latitude and of longitude at a given latitude, from the
 * usual truncated series for the WGS84 ellipsoid. Good to a metre or so
 * anywhere, which is far better than this needs to be.
 */
function metresPerDegree(latitude) {
  const rad = (latitude * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * rad) + 1.175 * Math.cos(4 * rad),
    lon: 111412.84 * Math.cos(rad) - 93.5 * Math.cos(3 * rad),
  };
}

/**
 * The smallest square the plot will zoom to, in metres.
 *
 * The firmware prints coordinates from a 32-bit float, whose spacing at a
 * mid-latitude is around half a metre - so a receiver that has not moved still
 * produces a scatter a few metres across, and letting the view zoom past that
 * would just magnify the quantisation grid into something that looks like
 * motion.
 */
const MIN_TRACK_SPAN_M = 6;

/**
 * Where the board has been, relative to where it was when you started
 * watching, in metres.
 *
 * Deliberately not a map. Nothing is fetched, so nothing about the board's
 * position leaves the machine - which is the same promise the rest of the page
 * makes, and the reason the GNSS card can be opened on a shared screen at all.
 * It also happens to show the thing worth seeing from a receiver sitting on a
 * desk: how far a fix wanders while the board does not move.
 */
export class TrackPlot {
  constructor(canvas, {span = 900} = {}) {
    this.canvas = canvas;
    this.span = span;
    this.origin = null;
    this.points = [];
    this._dirty = true;
  }

  /** @param {{latitude: number, longitude: number}} fix */
  push({latitude, longitude}) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (!this.origin) {
      const scale = metresPerDegree(latitude);
      this.origin = {latitude, longitude, scale};
    }
    const {origin} = this;
    this.points.push({
      east: (longitude - origin.longitude) * origin.scale.lon,
      north: (latitude - origin.latitude) * origin.scale.lat,
    });
    if (this.points.length > this.span) this.points.shift();
    this._dirty = true;
  }

  /** Forgets the origin too, so nothing absolute is left behind. */
  clear() {
    this.origin = null;
    this.points.length = 0;
    this._dirty = true;
  }

  /** Latest offset from the first fix, or null before there is one. */
  stats() {
    const last = this.points[this.points.length - 1];
    if (!last) return null;
    return {
      count: this.points.length, ...last,
      distance: Math.hypot(last.east, last.north)
    };
  }

  draw({force = false} = {}) {
    if (!this._dirty && !force) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    this._dirty = false;
    const {ctx, width, height} = fit;
    ctx.clearRect(0, 0, width, height);

    const faint = cssVar("--text-faint", "#85858f");
    const border = cssVar("--border", "#e4e4e9");
    const accent = cssVar("--accent", "#7a00d4");
    const mono = cssVar("--font-mono", "monospace");

    const pad = 12;
    // Equal metres per pixel on both axes, or the track would be sheared.
    const size = Math.min(width, height) - pad * 2;
    if (size < 40) return;
    const cx = width / 2;
    const cy = height / 2;

    ctx.font = `11px ${mono}`;
    ctx.textBaseline = "middle";

    if (!this.points.length) {
      ctx.fillStyle = faint;
      ctx.textAlign = "center";
      ctx.fillText("waiting for a fix", cx, cy);
      return;
    }

    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const {east, north} of this.points) {
      if (east < minE) minE = east;
      if (east > maxE) maxE = east;
      if (north < minN) minN = north;
      if (north > maxN) maxN = north;
    }
    const reach = Math.max(maxE - minE, maxN - minN, MIN_TRACK_SPAN_M) * 1.15;
    const midE = (minE + maxE) / 2;
    const midN = (minN + maxN) / 2;
    const perPixel = reach / size;
    // North is up, so the screen y axis runs the other way from the world's.
    const at = ({
                  east, north
                }) => [cx + (east - midE) / perPixel, cy - (north - midN) / perPixel];

    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, pad + 0.5, width - pad * 2 - 1, height - pad * 2 - 1);

    // Crosshair on the first fix, which is where every offset is measured from.
    const [ox, oy] = at({east: 0, north: 0});
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = faint;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad, oy);
    ctx.lineTo(width - pad, oy);
    ctx.moveTo(ox, pad);
    ctx.lineTo(ox, height - pad);
    ctx.stroke();
    ctx.restore();

    // The path, then a dot per fix: where the receiver dwelt comes out darker
    // as the dots pile up, which a bare polyline hides.
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.beginPath();
    this.points.forEach((point, index) => {
      const [x, y] = at(point);
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.28;
    for (const point of this.points) {
      const [x, y] = at(point);
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Start marker: a ring, so it reads as a reference rather than a reading.
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ox, oy, 4, 0, Math.PI * 2);
    ctx.stroke();

    const [lx, ly] = at(this.points[this.points.length - 1]);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(lx, ly, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = faint;
    ctx.textAlign = "left";
    ctx.fillText("N", pad + 6, pad + 10);
    ctx.textAlign = "right";
    ctx.fillText(`${this.points.length} fixes`, width - pad - 6, pad + 10);

    /*
     * Scale bar rather than tick labels. The view rescales itself constantly
     * as the scatter grows, so a fixed grid would be relabelled every second;
     * a bar the reader measures against stays legible.
     */
    const barMetres = niceLength(size * 0.35 * perPixel);
    const barPixels = barMetres / perPixel;
    const barY = height - pad - 12;
    const barX = pad + 8;
    ctx.strokeStyle = faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(barX, barY - 3);
    ctx.lineTo(barX, barY + 3);
    ctx.moveTo(barX, barY);
    ctx.lineTo(barX + barPixels, barY);
    ctx.moveTo(barX + barPixels, barY - 3);
    ctx.lineTo(barX + barPixels, barY + 3);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(formatMetres(barMetres), barX + barPixels + 6, barY);
  }
}

/** The largest 1/2/5 x 10^k that fits in `value`. */
function niceLength(value) {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(value, 1e-6))));
  const steps = [5, 2, 1];
  for (const step of steps) {
    if (step * power <= value) return step * power;
  }
  return power;
}

function formatMetres(metres) {
  if (metres >= 1000) return `${metres / 1000} km`;
  if (metres >= 1) return `${metres} m`;
  return `${Math.round(metres * 100)} cm`;
}

/* ------------------------------------------------------- orientation view - */

const VIEW = (() => {
  /*
   * Orthographic camera, fixed. `forward` is the direction from the board to
   * the eye, in body coordinates.
   *
   * The board is viewed from behind, below the IMU's +X: at rest the sensor's
   * +X recedes into the screen, +Y runs to the left and +Z stands up. That is
   * how the BNO086 sits on the board and how the board is normally held, so
   * tilting it away pitches the drawing away too, rather than sideways.
   *
   * The offsets off that axis are what keep the view readable. Looking exactly
   * down +X would show a 25 mm sliver of board edge, and would land the X and
   * Z labels on the same point: `right` has no vertical component by
   * construction, so +Z always projects straight up the screen and only +X can
   * be moved away from it. So the eye sits 25 degrees above the board and off
   * to one side, which spreads the three axis labels by at least 55 degrees.
   */
  const normalize = (v) => {
    const len = Math.hypot(...v);
    return v.map((c) => c / len);
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const forward = normalize([-1, -0.62, 0.55]);
  const right = normalize(cross([0, 0, 1], forward));
  const up = cross(forward, right);
  return {forward, right, up};
})();

/** Rotate v by unit quaternion q = {i, j, k, r}. */
function quatRotate(q, v) {
  const {i, j, k, r} = q;
  // t = 2 * (u x v); v' = v + r*t + u x t, with u = (i, j, k).
  const tx = 2 * (j * v[2] - k * v[1]);
  const ty = 2 * (k * v[0] - i * v[2]);
  const tz = 2 * (i * v[1] - j * v[0]);
  return [v[0] + r * tx + (j * tz - k * ty), v[1] + r * ty + (k * tx - i * tz), v[2] + r * tz + (i * ty - j * tx),];
}

/**
 * Roll, pitch and yaw in degrees from a quaternion, in the aerospace ZYX
 * order. Pitch is clamped rather than left to produce NaN at the poles: a
 * board held exactly nose-up is a normal thing to do while looking at a demo.
 */
export function quatToEuler({i, j, k, r}) {
  const roll = Math.atan2(2 * (r * i + j * k), 1 - 2 * (i * i + j * j));
  const sinPitch = Math.max(-1, Math.min(1, 2 * (r * j - k * i)));
  const pitch = Math.asin(sinPitch);
  const yaw = Math.atan2(2 * (r * k + i * j), 1 - 2 * (j * j + k * k));
  const deg = 180 / Math.PI;
  return {roll: roll * deg, pitch: pitch * deg, yaw: yaw * deg};
}

/**
 * Draws a board-shaped slab in the attitude given by a quaternion, with its
 * body axes.
 *
 * Painter's algorithm over six quads. A depth buffer would be overkill for a
 * convex box: sorting the faces by the depth of their centre is exact for
 * one, and the axis lines are simply drawn over the top.
 */
export class OrientationView {
  constructor(canvas, {size = [1.0, 0.72, 0.09]} = {}) {
    this.canvas = canvas;
    this.size = size;
    this.q = {i: 0, j: 0, k: 0, r: 1};
    this.stale = true;
    this._dirty = true;
  }

  set(q) {
    this.q = q;
    this._dirty = true;
  }

  setStale(stale) {
    if (this.stale !== stale) this._dirty = true;
    this.stale = stale;
  }

  draw({force = false} = {}) {
    if (!this._dirty && !force) return;
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    this._dirty = false;
    const {ctx, width, height} = fit;
    ctx.clearRect(0, 0, width, height);

    const scale = Math.min(width, height) * 0.34;
    const cx = width / 2;
    const cy = height / 2;
    const project = (p) => {
      const rotated = quatRotate(this.q, p);
      return {
        x: cx + scale * dot(rotated, VIEW.right),
        y: cy - scale * dot(rotated, VIEW.up),
        depth: dot(rotated, VIEW.forward),
        world: rotated,
      };
    };

    const [sx, sy, sz] = this.size;
    const corner = (a, b, c) => [(a * sx) / 2, (b * sy) / 2, (c * sz) / 2];
    // Vertex order per face is counter-clockwise seen from outside, which is
    // what makes the cross product below the outward normal.
    const faces = [{
      n: [0, 0, 1],
      v: [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
      top: true
    }, {
      n: [0, 0, -1],
      v: [corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1), corner(-1, -1, -1)]
    }, {
      n: [1, 0, 0],
      v: [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)]
    }, {
      n: [-1, 0, 0],
      v: [corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), corner(-1, -1, -1)]
    }, {
      n: [0, 1, 0],
      v: [corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1)]
    }, {
      n: [0, -1, 0],
      v: [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)]
    },];

    const base = this.stale ? cssVar("--text-faint", "#85858f") : cssVar("--accent", "#7a00d4");
    const rgb = parseColor(base) || [122, 0, 212];
    const border = cssVar("--border-strong", "#d0d0d8");

    const drawn = faces.map((face) => {
      const points = face.v.map(project);
      const depth = points.reduce((sum, p) => sum + p.depth, 0) / points.length;
      const normal = quatRotate(this.q, face.n);
      return {points, depth, normal, top: face.top};
    });
    drawn.sort((a, b) => a.depth - b.depth); // far faces first

    // Head-on light, so a face turned towards the viewer is the bright one.
    for (const face of drawn) {
      if (dot(face.normal, VIEW.forward) <= 0) continue; // back face
      const lit = 0.42 + 0.58 * Math.max(0, dot(face.normal, VIEW.forward));
      const alpha = face.top ? 0.95 : 0.8;
      ctx.beginPath();
      face.points.forEach((p, index) => (index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb.map((c) => Math.round(c * lit + 255 * (1 - lit) * 0.18)).join(",")},${alpha})`;
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Body axes, drawn last so they read against the slab.
    const origin = {x: cx, y: cy};
    const axes = [["x", [1, 0, 0], "X"], ["y", [0, 1, 0], "Y"], ["z", [0, 0, 1], "Z"]];
    ctx.lineWidth = 2;
    ctx.font = "600 12px " + cssVar("--font", "sans-serif");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [key, vector, label] of axes) {
      const tip = project(vector.map((c) => c * 0.95));
      ctx.globalAlpha = this.stale ? 0.35 : 1;
      ctx.strokeStyle = AXIS_COLORS[key];
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.fillStyle = AXIS_COLORS[key];
      const labelAt = project(vector.map((c) => c * 1.14));
      ctx.fillText(label, labelAt.x, labelAt.y);
      ctx.globalAlpha = 1;
    }
  }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** #rgb, #rrggbb or rgb()/oklch() as resolved by the browser -> [r, g, b]. */
function parseColor(value) {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map((c) => c + c) : hex[1].match(/../g);
    return digits.map((pair) => Number.parseInt(pair, 16));
  }
  const rgb = value.match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
  if (rgb && value.startsWith("rgb")) return rgb.slice(1, 4).map(Number);
  return null;
}
