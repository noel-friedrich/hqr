import { isMetadataModule } from "./qr-engine.js";

export class DrawingCanvas {
  constructor(root, canvas) {
    this.root = root;
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.token = 0;
  }

  moduleFromPointer(event) {
    const bounds = this.canvas.getBoundingClientRect();
    const column = Math.floor((event.clientX - bounds.left) * this.canvas.width / bounds.width);
    const row = Math.floor((event.clientY - bounds.top) * this.canvas.height / bounds.height);
    if (row < 0 || column < 0 || row >= this.canvas.height || column >= this.canvas.width) return null;
    return { row, column };
  }

  makeImage({ model, targets, invalid = false, highlightAreas = true, allowMetadata = false }) {
    const size = model.matrix.length;
    if (this.canvas.width !== size) {
      this.canvas.width = this.canvas.height = size;
      this.root.parentElement.style.setProperty("--qr-size", size);
    }
    this.root.parentElement.classList.toggle("is-invalid", invalid && highlightAreas);
    const image = this.context.createImageData(size, size);
    model.matrix.forEach((line, row) => line.forEach((baseline, column) => {
      const target = targets.get(row * size + column);
      const dark = target ? target.value : baseline;
      const metadata = isMetadataModule(model.functionMap[row][column]);
      const alignment = ["alignment", "timing"].includes(model.functionMap[row][column]);
      const color = !highlightAreas ? (dark ? [0, 0, 0] : [255, 255, 255])
        : target
        ? (dark ? [18, 109, 60] : [185, 227, 197])
        : metadata && !allowMetadata ? (dark ? [180, 90, 10] : [255, 226, 184])
        : alignment ? (dark ? [36, 92, 166] : [203, 225, 251])
        : invalid || (model.functionMap[row][column] && !metadata)
          ? (dark ? [180, 35, 24] : [255, 240, 239])
          : dark ? [0, 0, 0] : [255, 255, 255];
      image.data.set([...color, 255], (row * size + column) * 4);
    }));
    return image;
  }

  render(state) {
    this.context.putImageData(this.makeImage(state), 0, 0);
  }

  optimize(getState) {
    const token = ++this.token;
    this.root.classList.add("is-optimizing");
    let lastUpdate = -Infinity;
    const frame = (now) => {
      if (token !== this.token) return;
      if (now - lastUpdate > 45) {
        lastUpdate = now;
        const state = getState();
        const image = this.makeImage({ ...state, invalid: false });
        const size = state.model.matrix.length;
        for (let index = 0; index < size * size; index += 1) {
          const row = Math.floor(index / size);
          const column = index % size;
          if (state.model.functionMap[row][column] || state.targets.has(index)) continue;
          const grey = Math.random() < .08 ? (Math.random() < .5 ? 85 : 210) : image.data[index * 4] * .7 + 45;
          image.data.set([grey, grey, grey, 255], index * 4);
        }
        this.context.putImageData(image, 0, 0);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop() {
    this.token += 1;
    this.root.classList.remove("is-optimizing");
  }

  async finish(state) {
    this.stop();
    const token = this.token;
    const before = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const after = this.makeImage(state);
    if (before.width !== after.width) {
      this.context.putImageData(after, 0, 0);
      return;
    }
    const changes = [];
    for (let index = 0; index < after.data.length; index += 4) {
      if (after.data[index] !== before.data[index] || after.data[index + 1] !== before.data[index + 1] || after.data[index + 2] !== before.data[index + 2]) changes.push(index);
    }
    for (let index = changes.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [changes[index], changes[swap]] = [changes[swap], changes[index]];
    }
    const start = performance.now();
    let completed = 0;
    await new Promise((resolve) => {
      const frame = (now) => {
        if (token !== this.token) { resolve(); return; }
        const progress = Math.min(1, (now - start) / 260);
        const count = Math.floor(changes.length * progress);
        while (completed < count) {
          const offset = changes[completed++];
          before.data.set(after.data.subarray(offset, offset + 4), offset);
        }
        this.context.putImageData(before, 0, 0);
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }
}
