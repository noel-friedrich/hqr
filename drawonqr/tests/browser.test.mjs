import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(join(tmpdir(), "drawonqr-test-"));
const errors = [];
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname.replace(/^\/hqr\/drawonqr\//, "") || "index.html";
    const filename = resolve(root, relative);
    if (!filename.startsWith(root + sep)) throw new Error("Invalid path");
    response.setHeader("Content-Type", mime[extname(filename)] ?? "application/octet-stream");
    response.end(await readFile(filename));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let socket;

try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome did not start")), 15000);
    chrome.on("error", reject);
    chrome.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1])); }
    });
  });
  const pages = await (await fetch(`http://${endpoint.host}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const callbacks = pending.get(message.id);
    if (callbacks) {
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression) => {
    const started = Date.now();
    while (!await evaluate(expression)) {
      if (Date.now() - started > 15000) throw new Error(`Timed out: ${expression}; status: ${await evaluate('document.querySelector("#status")?.textContent')}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const ready = () => until('document.querySelector("#status")?.textContent.startsWith("Within ECC limit (") && !document.querySelector("#png").disabled');
  const set = (selector, value, event = "change") => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const stroke = async (from, to = from) => {
    const bounds = await evaluate('(() => { const c = document.querySelector("canvas"), r = c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,size:c.width}; })()');
    const point = ({ row, column }) => ({ x: bounds.x + (column + .5) * bounds.w / bounds.size, y: bounds.y + (row + .5) * bounds.h / bounds.size });
    await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point(from), button: "left", buttons: 1, clickCount: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point(to), button: "left", buttons: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point(to), button: "left", buttons: 0, clickCount: 1 });
  };

  await command("Runtime.enable");
  await command("Page.enable");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__jobs = []; window.__done = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.addEventListener('message', ({data}) => {
        if (data.type === 'done') { window.__done.push(data); window.__lastResult = data.result; }
      }); }
      postMessage(data) { window.__jobs.push(data); super.postMessage(data); }
    };
    Object.defineProperty(navigator, 'canShare', {value: () => true});
    Object.defineProperty(navigator, 'share', {value: async (data) => { window.__shared = data; }});
    const createURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__export = blob; return createURL(blob); };
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (this.download) { window.__filename = this.download; return; }
      nativeClick.call(this);
    };
  ` });
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/hqr/drawonqr/` });
  await ready();
  assert.equal(await evaluate("document.title"), "DrawOnQR Codes");
  assert.equal(await evaluate('document.querySelector("#ecc").value'), "auto");
  assert.equal(await evaluate('document.querySelector("#mask").value'), "auto");
  assert.equal(await evaluate('__lastResult.model.dataBlocks.flat().slice(__lastResult.model.paddingStartCodeword).every((byte,index) => byte === (index % 2 === 0 ? 0xec : 0x11))'), true);
  assert.equal(await evaluate('document.querySelector("#version").value'), "1");
  assert.equal(await evaluate('document.querySelector("#version").tagName'), "SELECT");
  assert.deepEqual(await evaluate('[...document.querySelector("#version").options].map(option => Number(option.value))'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(await evaluate('document.querySelector("#highlight-areas").checked'), true);
  assert.equal(await evaluate('document.querySelectorAll(".legend-item").length'), 4);
  assert.equal(await evaluate('document.querySelector("#allow-alignment").checked'), false);
  assert.equal(await evaluate('document.querySelector("#allow-alignment").closest("label").textContent.trim()'), "Allow drawing on alignment/timing patterns");
  assert.equal(await evaluate('document.querySelector(".legend-swatch.alignment").parentElement.textContent'), "Alignment/timing");
  const protectedPixel = () => evaluate("[...document.querySelector('canvas').getContext('2d').getImageData(3,3,1,1).data]");
  const protectedJobs = await evaluate("__jobs.length");
  assert.deepEqual(await protectedPixel(), [180, 35, 24, 255]);
  await click("#highlight-areas");
  assert.deepEqual(await protectedPixel(), [0, 0, 0, 255]);
  assert.equal(await evaluate('document.querySelector("#grid-legend").hidden'), true);
  await click("#highlight-areas");
  assert.deepEqual(await protectedPixel(), [180, 35, 24, 255]);
  assert.equal(await evaluate('document.querySelector("#grid-legend").hidden'), false);
  assert.equal(await evaluate("__jobs.length"), protectedJobs);
  assert.equal(await evaluate('document.querySelector("#allow-metadata").checked'), false);
  assert.equal(await evaluate('document.querySelector("#metadata-blocks").hidden'), true);
  const metadataPixel = () => evaluate("[...document.querySelector('canvas').getContext('2d').getImageData(8,0,1,1).data]");
  const metadataColor = await evaluate("__lastResult.model.matrix[0][8] ? [180,90,10,255] : [255,226,184,255]");
  assert.deepEqual(await metadataPixel(), metadataColor);
  await click("#highlight-areas");
  assert.deepEqual(await metadataPixel(), await evaluate("__lastResult.model.matrix[0][8] ? [0,0,0,255] : [255,255,255,255]"));
  await click("#highlight-areas");
  assert.deepEqual(await metadataPixel(), metadataColor);
  console.log("pass: defaults and worker startup");

  for (const [width, height] of [[1600, 900], [1200, 900], [1199, 900], [901, 900], [900, 900], [375, 812]]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const layout = await evaluate(`(() => {
      const panel = document.querySelector('.panel');
      const container = document.querySelector('.panel-container');
      const frame = document.querySelector('.grid-frame');
      const workspace = document.querySelector('.workspace');
      const style = getComputedStyle(panel);
      return {
        panel: panel.getBoundingClientRect().toJSON(),
        frame: frame.getBoundingClientRect().toJSON(),
        workspace: workspace.getBoundingClientRect().toJSON(),
        radius: style.borderRadius,
        bodyOverflow: getComputedStyle(document.body).overflow,
        containerOverflow: getComputedStyle(container).overflowY,
        containerScrollbar: container.offsetWidth - container.clientWidth,
        mainDisplay: getComputedStyle(document.querySelector('main')).display,
        scrollWidth: document.documentElement.scrollWidth,
      };
    })()`);
    assert.ok(layout.scrollWidth <= width, `No horizontal overflow at ${width}px`);
    assert.ok(Math.abs(layout.frame.width - layout.frame.height) < 1, "QR frame stays square");
    if (width >= 1200) {
      assert.equal(layout.radius, "20px");
      assert.ok(Math.abs(layout.panel.width + layout.containerScrollbar - 430) < 1);
      assert.ok(Math.abs(layout.panel.top - height * .1) < 1);
      assert.ok(layout.panel.right < width, "Floating sidebar has a right margin");
      assert.equal(layout.containerOverflow, "auto");
    } else if (width > 900) {
      assert.equal(layout.radius, "0px");
      assert.ok(Math.abs(layout.panel.right - width) < 1);
      assert.ok(Math.abs(layout.panel.height - height) < 1);
    } else {
      assert.equal(layout.mainDisplay, "block");
      assert.equal(layout.bodyOverflow, "auto");
      assert.ok(layout.panel.top >= layout.workspace.bottom, "QR appears above the sidebar on mobile");
    }
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log("pass: HQR floating, docked, and mobile layout breakpoints");

  const jobs = await evaluate("window.__jobs.length");
  await stroke({ row: 2, column: 2 });
  assert.equal(await evaluate("window.__jobs.length"), jobs);
  const target = await evaluate(`(() => {
    const m = __lastResult.model;
    for(let row=9; row<m.matrix.length; row++) for(let column=9; column<m.matrix.length; column++)
      if (!m.functionMap[row][column] && !m.matrix[row][column]) return {row,column};
  })()`);
  await stroke(target);
  await until("window.__jobs.length > " + jobs);
  await ready();
  assert.equal(await evaluate(`__lastResult.edited[${target.row}][${target.column}]`), true);
  const paintedColor = await evaluate(`(() => { const c = document.querySelector('canvas'); return [...c.getContext('2d').getImageData(${target.column},${target.row},1,1).data]; })()`);
  assert.deepEqual(paintedColor, [18, 109, 60, 255]);
  const highlightJobs = await evaluate("__jobs.length");
  await click("#highlight-areas");
  assert.deepEqual(await evaluate(`(() => { const c = document.querySelector('canvas'); return [...c.getContext('2d').getImageData(${target.column},${target.row},1,1).data]; })()`), [0, 0, 0, 255]);
  await click("#highlight-areas");
  assert.deepEqual(await evaluate(`(() => { const c = document.querySelector('canvas'); return [...c.getContext('2d').getImageData(${target.column},${target.row},1,1).data]; })()`), paintedColor);
  assert.equal(await evaluate("__jobs.length"), highlightJobs);
  console.log("pass: finder protection, drawing, green highlight");

  await click('[data-tool="rectangle"]');
  await click('[data-color="white"]');
  await stroke({ row: 10, column: 10 }, { row: 12, column: 14 });
  await ready();
  const targetCount = await evaluate("__jobs.at(-1).settings.targets.length");
  assert.ok(targetCount >= 15);
  await click("#undo");
  await ready();
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 1);
  await click("#redo");
  await ready();
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), targetCount);
  console.log("pass: rectangle, white paint, undo/redo");

  await set("#ecc", "Q");
  await ready();
  await set("#mask", "5");
  await ready();
  assert.equal(await evaluate("__lastResult.model.level"), "Q");
  assert.equal(await evaluate("__lastResult.model.mask"), 5);
  await set("#version", "3");
  await ready();
  assert.equal(await evaluate("__lastResult.model.version"), 3);
  await click('[data-tool="pencil"]');
  await stroke({ row: 10, column: 10 });
  await ready();
  assert.equal(await evaluate("__lastResult.model.version"), 3);
  await set("#content", "noel-friedrich.de", "input");
  await ready();
  assert.equal(await evaluate('document.querySelector("#version").value'), "2");
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 0);
  console.log("pass: fixed manual version/ECC/mask and content auto-fit");

  await click("#svg");
  const svg = await evaluate("__export.text()");
  assert.match(svg, /image|<svg/);
  assert.match(svg, /viewBox="0 0 33 33"/);
  assert.ok(!svg.includes("green"));
  await click("#png");
  await until("__export.type === 'image/png'");
  assert.deepEqual(await evaluate("createImageBitmap(__export).then(image => [image.width,image.height])"), [330, 330]);
  await click("#share");
  assert.deepEqual(await evaluate("[__shared.files[0].type, __shared.files[0].size > 0]"), ["image/png", true]);
  console.log("pass: SVG, PNG, native image sharing");

  await set("#content", "67", "input");
  await ready();
  await click('[data-tool="rectangle"]');
  await stroke({ row: 0, column: 9 }, { row: 20, column: 20 });
  await until('document.querySelector("#status").classList.contains("is-error") && !document.querySelector("#png").disabled');
  assert.equal(await evaluate("__lastResult.readable"), false);
  assert.equal(await evaluate('document.querySelector(".frame").classList.contains("is-invalid")'), true);
  const invalidPixel = () => evaluate("[...document.querySelector('canvas').getContext('2d').getImageData(10,10,1,1).data]");
  assert.deepEqual(await invalidPixel(), [185, 227, 197, 255]);
  await click("#highlight-areas");
  assert.deepEqual(await invalidPixel(), [255, 255, 255, 255]);
  assert.equal(await evaluate('document.querySelector(".frame").classList.contains("is-invalid")'), false);
  assert.equal(await evaluate('document.querySelector("#status").classList.contains("is-error")'), true);
  await click("#highlight-areas");
  assert.deepEqual(await invalidPixel(), [185, 227, 197, 255]);
  assert.equal(await evaluate('document.querySelector(".frame").classList.contains("is-invalid")'), true);
  await click("#undo");
  await ready();
  assert.equal(await evaluate('document.querySelector(".frame").classList.contains("is-invalid")'), false);
  console.log("pass: over-budget red warning and recovery");

  await click('[data-tool="pencil"]');
  await stroke({ row: 10, column: 10 });
  await until('document.querySelector("#status").textContent === "Optimizing..."');
  await stroke({ row: 11, column: 11 });
  await ready();
  assert.equal(await evaluate('__jobs.at(-1).settings.targets.some(t => t.row === 10 && t.column === 10) && __jobs.at(-1).settings.targets.some(t => t.row === 11 && t.column === 11)'), true);
  await set("#content", "replacement content", "input");
  await set("#content", "67", "input");
  await ready();
  assert.equal(await evaluate("__lastResult.model.message"), "67");
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 0);
  console.log("pass: drawing during optimization and stale result cancellation");

  await set("#content", "x".repeat(1000), "input");
  assert.match(await evaluate('document.querySelector("#status").textContent'), /Versions 1-10/);
  assert.equal(await evaluate('document.querySelector("#png").disabled'), true);
  assert.ok(await evaluate('Number(document.querySelector("#version").value) >= 1 && Number(document.querySelector("#version").value) <= 10'));
  await set("#content", "67", "input");
  await ready();
  console.log("pass: version dropdown limit and error-view highlighting toggle");

  await set("#ecc", "H");
  await ready();
  await set("#content", "12345678901234567", "input");
  await ready();
  assert.equal(await evaluate('document.querySelector("#version").value'), "1");
  assert.equal(await evaluate("__lastResult.model.type"), "numeric");
  await set("#content", "ABCDEFGHIJ", "input");
  await ready();
  assert.equal(await evaluate('document.querySelector("#version").value'), "1");
  assert.equal(await evaluate("__lastResult.model.type"), "alphanumeric");
  await set("#content", "Abcdefg", "input");
  await ready();
  assert.equal(await evaluate("__lastResult.model.type"), "byte");
  assert.equal(await evaluate("__lastResult.model.message"), "Abcdefg");
  console.log("pass: numeric, alphanumeric, and byte mode auto-fit");

  await set("#mask", "0");
  await ready();
  await set("#content", "hi", "input");
  await ready();
  const lockedJobs = await evaluate("__jobs.length");
  await stroke({ row: 0, column: 8 });
  assert.equal(await evaluate("__jobs.length"), lockedJobs);
  await click("#allow-metadata");
  await ready();
  assert.equal(await evaluate('document.querySelector("#metadata-blocks").hidden'), false);
  assert.equal(await evaluate('document.querySelectorAll("#metadata-blocks .block").length'), 2);
  const unhighlightedMetadata = await evaluate("__lastResult.model.matrix[0][8] ? [0,0,0,255] : [255,255,255,255]");
  assert.deepEqual(await metadataPixel(), unhighlightedMetadata);
  for (let row = 0; row < 4; row += 1) {
    const current = await evaluate(`__lastResult.model.matrix[${row}][8]`);
    await click(current ? '[data-color="white"]' : '[data-color="black"]');
    await stroke({ row, column: 8 });
    if (row < 3) await ready();
    else await until('document.querySelector("#status").textContent.startsWith("Metadata ECC limit exceeded") && !document.querySelector("#png").disabled');
    assert.equal(await evaluate("__lastResult.damage.metadataStats[0].damagedBits"), row + 1);
    assert.equal(await evaluate("__lastResult.totalDamaged"), 0);
  }
  assert.equal(await evaluate('document.querySelector("#metadata-blocks .block").classList.contains("is-invalid")'), true);
  await click("#undo");
  await ready();
  await set("#version", "7");
  await ready();
  assert.equal(await evaluate('document.querySelectorAll("#metadata-blocks .block").length'), 4);
  await click("#allow-metadata");
  await ready();
  assert.equal(await evaluate('document.querySelector("#metadata-blocks").hidden'), true);
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 0);
  assert.deepEqual(await metadataPixel(), await evaluate("__lastResult.model.matrix[0][8] ? [180,90,10,255] : [255,226,184,255]"));
  console.log("pass: orange metadata, drawing permission, per-copy ECC meters, undo, and relocking");

  await set("#version", "2");
  await ready();
  const alignment = await evaluate(`(() => {
    const m = __lastResult.model;
    for (let row=0; row<m.matrix.length; row++) for (let column=0; column<m.matrix.length; column++)
      if (m.functionMap[row][column] === 'alignment' && m.matrix[row][column]) return {row,column};
  })()`);
  const alignmentPixel = () => evaluate(`[...document.querySelector('canvas').getContext('2d').getImageData(${alignment.column},${alignment.row},1,1).data]`);
  assert.deepEqual(await alignmentPixel(), [36, 92, 166, 255]);
  const alignmentJobs = await evaluate("__jobs.length");
  await stroke(alignment);
  assert.equal(await evaluate("__jobs.length"), alignmentJobs);
  await click("#highlight-areas");
  assert.deepEqual(await alignmentPixel(), [0, 0, 0, 255]);
  await click("#highlight-areas");
  assert.deepEqual(await alignmentPixel(), [36, 92, 166, 255]);
  await click("#allow-alignment");
  await ready();
  await click('[data-color="white"]');
  await stroke(alignment);
  await ready();
  assert.equal(await evaluate(`__lastResult.edited[${alignment.row}][${alignment.column}]`), false);
  assert.equal(await evaluate("__lastResult.totalDamaged"), 0);
  assert.equal(await evaluate("__lastResult.metadataDamaged"), 0);
  assert.equal(await evaluate('__lastResult.model.dataBlocks.flat().slice(__lastResult.model.paddingStartCodeword).every((byte,index) => byte === (index % 2 === 0 ? 0xec : 0x11))'), true);
  assert.deepEqual(await alignmentPixel(), [185, 227, 197, 255]);
  await click("#undo");
  await ready();
  assert.deepEqual(await alignmentPixel(), [36, 92, 166, 255]);
  await click("#redo");
  await ready();
  assert.deepEqual(await alignmentPixel(), [185, 227, 197, 255]);

  await click("#allow-metadata");
  await ready();
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 1);
  const metadataDark = await evaluate("__lastResult.model.matrix[0][8]");
  await click(metadataDark ? '[data-color="white"]' : '[data-color="black"]');
  await stroke({ row: 0, column: 8 });
  await ready();
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 2);
  await click("#allow-alignment");
  await ready();
  assert.deepEqual(await evaluate("__jobs.at(-1).settings.targets.map(t => [t.row,t.column])"), [[0, 8]]);
  assert.deepEqual(await alignmentPixel(), [36, 92, 166, 255]);
  await click("#undo");
  await ready();
  await click("#redo");
  await ready();
  assert.deepEqual(await evaluate("__jobs.at(-1).settings.targets.map(t => [t.row,t.column])"), [[0, 8]]);
  await click("#allow-alignment");
  await ready();
  await click('[data-color="white"]');
  await stroke(alignment);
  await ready();
  await click("#allow-metadata");
  await ready();
  assert.deepEqual(await evaluate("__jobs.at(-1).settings.targets.map(t => [t.row,t.column])"), [[alignment.row, alignment.column]]);
  assert.deepEqual(await alignmentPixel(), [185, 227, 197, 255]);
  assert.deepEqual(await metadataPixel(), await evaluate("__lastResult.model.matrix[0][8] ? [180,90,10,255] : [255,226,184,255]"));
  console.log("pass: blue alignment areas, opt-in drawing, undo/redo, and independent permission changes");

  await click("#allow-alignment");
  await ready();
  await set("#version", "1");
  await ready();
  const timing = { row: 6, column: 10 };
  assert.equal(await evaluate("__lastResult.model.functionMap[6][10]"), "timing");
  const timingPixel = () => evaluate("[...document.querySelector('canvas').getContext('2d').getImageData(10,6,1,1).data]");
  assert.deepEqual(await timingPixel(), [36, 92, 166, 255]);
  const timingJobs = await evaluate("__jobs.length");
  await stroke(timing);
  assert.equal(await evaluate("__jobs.length"), timingJobs);
  await click("#highlight-areas");
  assert.deepEqual(await timingPixel(), [0, 0, 0, 255]);
  await click("#highlight-areas");
  assert.deepEqual(await timingPixel(), [36, 92, 166, 255]);
  await click("#allow-alignment");
  await ready();
  await click('[data-color="white"]');
  await stroke(timing);
  await ready();
  assert.equal(await evaluate("__lastResult.edited[6][10]"), false);
  assert.equal(await evaluate("__lastResult.totalDamaged"), 0);
  assert.equal(await evaluate("__lastResult.metadataDamaged"), 0);
  assert.deepEqual(await timingPixel(), [185, 227, 197, 255]);
  await click("#undo");
  await ready();
  assert.deepEqual(await timingPixel(), [36, 92, 166, 255]);
  await click("#redo");
  await ready();
  assert.deepEqual(await timingPixel(), [185, 227, 197, 255]);
  await click("#allow-alignment");
  await ready();
  assert.equal(await evaluate("__jobs.at(-1).settings.targets.length"), 0);
  assert.deepEqual(await timingPixel(), [36, 92, 166, 255]);
  console.log("pass: blue timing patterns, opt-in drawing, highlight toggle, undo/redo, and relocking");

  await command("Page.captureScreenshot", { format: "png" }).then(async ({data}) => {
    if (process.env.DRAWONQR_SCREENSHOT) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.env.DRAWONQR_SCREENSHOT, Buffer.from(data, "base64"));
    }
  });

  await command("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"));
  assert.deepEqual(errors, []);
  console.log("pass: mobile layout and no browser exceptions");
} finally {
  socket?.close();
  if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => server.close(resolve));
  if (profile.startsWith(resolve(tmpdir()) + sep)) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
