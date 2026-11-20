import { canDrawOn } from "./qr-engine.js";
import { imageCoordinates, resizeImage } from "./image-data.js";

let sequence = 0;
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

export class ImageEditor {
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.images = [];
    this.selected = null;
    this.active = false;
    this.interaction = null;
    this.preview = document.getElementById("image-preview");
    this.layer = document.getElementById("image-layer");
    root.addEventListener("pointerdown", (event) => this.start(event));
    root.addEventListener("pointermove", (event) => this.move(event));
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      root.addEventListener(name, (event) => this.finish(event));
    }
    window.addEventListener("pointerdown", (event) => {
      if (!root.contains(event.target)) this.deselect();
    });
    document.addEventListener("keydown", (event) => {
      if (!this.active || !this.selected || event.target.matches("input, textarea, select") || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") this.deselect();
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.remove(this.selected);
      }
    });
  }

  snapshot() { return this.images.map((image) => ({ ...image })); }

  deselect() {
    this.finish();
    if (!this.selected) return;
    this.selected = null;
    this.render();
  }

  restore(images) {
    this.finish();
    this.images = images.map((image) => ({ ...image }));
    if (!this.images.some(({ id }) => id === this.selected)) this.selected = null;
    this.render();
  }

  add(assets) {
    for (const asset of assets) {
      const scale = .5 / Math.max(asset.width, asset.height);
      const image = {
        id: `image-${++sequence}`, asset, x: .5, y: .5,
        width: asset.width * scale, height: asset.height * scale, rotation: 0,
      };
      this.images.push(image);
      this.selected = image.id;
    }
    this.render();
  }

  setActive(active) {
    this.finish();
    this.active = active;
    if (!active) this.selected = null;
    this.root.classList.toggle("is-selecting", active);
    this.render();
  }

  deselect() {
    this.finish();
    this.selected = null;
    this.render();
  }

  point(event) {
    const bounds = this.root.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }

  start(event) {
    if (!this.active || !this.callbacks.ready() || this.interaction || event.button !== 0) return;
    const point = this.point(event);
    const element = event.target.closest("[data-image-id]");
    const image = element ? this.images.find(({ id }) => id === element.dataset.imageId) : [...this.images].reverse().find((image) => {
      const { u, v } = imageCoordinates(image, point.x, point.y);
      return u >= 0 && v >= 0 && u <= 1 && v <= 1;
    });
    if (!image) { this.deselect(); return; }
    event.preventDefault();
    this.selected = image.id;
    const handle = event.target.closest("[data-handle]")?.dataset.handle;
    if (handle === "delete") { this.remove(image.id); return; }
    this.interaction = {
      pointerId: event.pointerId, image, original: { ...image }, point,
      before: this.callbacks.snapshot(), handle: handle ?? "drag", changed: false,
    };
    this.root.focus({ preventScroll: true });
    this.root.setPointerCapture(event.pointerId);
    this.render();
  }

  move(event) {
    const action = this.interaction;
    if (!action || action.pointerId !== event.pointerId) return;
    const point = this.point(event);
    if (!action.changed && Math.hypot(point.x - action.point.x, point.y - action.point.y) < .002) return;
    action.changed = true;
    const original = action.original;
    if (action.handle === "rotate") {
      action.image.rotation = original.rotation + Math.atan2(point.y - original.y, point.x - original.x) -
        Math.atan2(action.point.y - original.y, action.point.x - original.x);
    } else if (action.handle === "drag") {
      action.image.x = Math.max(-1, Math.min(2, original.x + point.x - action.point.x));
      action.image.y = Math.max(-1, Math.min(2, original.y + point.y - action.point.y));
    } else Object.assign(action.image, resizeImage(original, CORNERS[Number(action.handle)], point));
    this.callbacks.change();
  }

  finish(event) {
    const action = this.interaction;
    if (!action || (event && event.pointerId !== action.pointerId)) return;
    this.interaction = null;
    if (this.root.hasPointerCapture(action.pointerId)) this.root.releasePointerCapture(action.pointerId);
    if (action.changed) this.callbacks.commit(action.before);
  }

  remove(id) {
    const before = this.callbacks.snapshot();
    this.images = this.images.filter((image) => image.id !== id);
    this.selected = null;
    this.callbacks.change();
    this.callbacks.commit(before);
  }

  render(view = this.callbacks.view()) {
    const liveIds = new Set(this.images.map(({ id }) => id));
    for (const child of [...this.layer.children]) if (!liveIds.has(child.dataset.imageId)) child.remove();
    for (const image of this.images) {
      let box = [...this.layer.children].find((child) => child.dataset.imageId === image.id);
      if (!box) {
        box = document.createElement("div");
        box.className = "placed-image";
        box.dataset.imageId = image.id;
        for (let corner = 0; corner < 4; corner += 1) {
          const knob = document.createElement("button");
          knob.type = "button";
          knob.className = `image-knob corner corner-${corner}`;
          knob.dataset.handle = String(corner);
          knob.setAttribute("aria-label", `Resize image corner ${corner + 1}`);
          box.append(knob);
        }
        for (const [handle, label] of [["rotate", "Rotate image"], ["delete", "Remove image"]]) {
          const knob = document.createElement("button");
          knob.type = "button";
          knob.className = `image-knob image-${handle}`;
          knob.dataset.handle = handle;
          knob.setAttribute("aria-label", label);
          if (handle === "delete") knob.textContent = "x";
          if (handle === "delete") knob.addEventListener("click", (event) => {
            if (event.detail === 0) this.remove(image.id);
          });
          box.append(knob);
        }
        this.layer.append(box);
      }
      box.style.left = `${image.x * 100}%`;
      box.style.top = `${image.y * 100}%`;
      box.style.width = `${image.width * 100}%`;
      box.style.height = `${image.height * 100}%`;
      box.style.transform = `translate(-50%, -50%) rotate(${image.rotation}rad)`;
      box.classList.toggle("is-selected", this.active && this.selected === image.id);
      box.querySelectorAll("button").forEach((button) => { button.tabIndex = this.active && this.selected === image.id ? 0 : -1; });
    }
    const context = this.preview.getContext("2d");
    const selected = this.active && this.images.find(({ id }) => id === this.selected);
    this.preview.hidden = !selected || !view.model;
    if (!selected || !view.model) return;
    const resolution = 768;
    if (this.preview.width !== resolution) this.preview.width = this.preview.height = resolution;
    context.clearRect(0, 0, resolution, resolution);
    context.save();
    context.translate(selected.x * resolution, selected.y * resolution);
    context.rotate(selected.rotation);
    context.imageSmoothingEnabled = false;
    context.drawImage(selected.asset.canvas, -selected.width * resolution / 2, -selected.height * resolution / 2,
      selected.width * resolution, selected.height * resolution);
    context.restore();
    const size = view.model.matrix.length;
    // The source preview sits behind protected QR cells and manual strokes.
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (canDrawOn(view.model, row, column, view.allowMetadata, view.allowAlignment) && !view.manualTargets.has(row * size + column)) continue;
        const left = Math.floor(column * resolution / size), top = Math.floor(row * resolution / size);
        context.clearRect(left, top, Math.ceil((column + 1) * resolution / size) - left,
          Math.ceil((row + 1) * resolution / size) - top);
      }
    }
  }
}
