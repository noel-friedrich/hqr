import { balancedThreshold, luminancePixels, thresholdPixels } from "./image-data.js";

function binaryCanvas(width, height, pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  pixels.forEach((value, index) => {
    const color = value === 1 ? 0 : 255;
    image.data.set([color, color, color, value < 0 ? 0 : 255], index * 4);
  });
  context.putImageData(image, 0, 0);
  return canvas;
}

export class ImageUpload {
  constructor(onAdd) {
    this.dialog = document.getElementById("image-dialog");
    this.drop = document.getElementById("image-drop");
    this.file = document.getElementById("image-file");
    this.slider = document.getElementById("image-threshold");
    this.preview = document.getElementById("image-upload-preview");
    this.error = document.getElementById("image-upload-error");
    this.add = document.getElementById("image-confirm");
    this.sources = [];
    this.revision = 0;
    document.getElementById("add-image").addEventListener("click", () => this.dialog.showModal());
    document.getElementById("image-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => this.reset());
    this.drop.addEventListener("click", () => this.file.click());
    this.file.addEventListener("change", () => this.load(this.file.files));
    this.drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      this.drop.classList.add("is-dragging");
    });
    this.drop.addEventListener("dragleave", () => this.drop.classList.remove("is-dragging"));
    this.drop.addEventListener("drop", (event) => {
      event.preventDefault();
      this.drop.classList.remove("is-dragging");
      this.load(event.dataTransfer.files);
    });
    this.slider.addEventListener("input", () => this.render());
    this.add.addEventListener("click", () => {
      if (!this.sources.length || this.add.disabled) return;
      onAdd(this.assets());
      this.dialog.close();
    });
  }

  reset() {
    this.revision += 1;
    this.sources = [];
    this.file.value = "";
    this.slider.value = "0";
    this.error.textContent = "";
    this.render();
  }

  async load(files) {
    const revision = ++this.revision;
    this.add.disabled = true;
    this.error.textContent = "";
    try {
      const sources = [];
      for (const file of files) {
        if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
        let bitmap;
        let url;
        try {
          try { bitmap = await createImageBitmap(file); }
          catch {
            url = URL.createObjectURL(file);
            bitmap = new Image();
            bitmap.src = url;
            await bitmap.decode();
          }
          const sourceWidth = bitmap.naturalWidth ?? bitmap.width;
          const sourceHeight = bitmap.naturalHeight ?? bitmap.height;
          const scale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight));
          const width = Math.max(1, Math.round(sourceWidth * scale));
          const height = Math.max(1, Math.round(sourceHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.drawImage(bitmap, 0, 0, width, height);
          const luminance = luminancePixels(context.getImageData(0, 0, width, height).data);
          sources.push({ width, height, luminance, threshold: balancedThreshold(luminance) });
        } finally {
          bitmap?.close?.();
          if (url) URL.revokeObjectURL(url);
        }
      }
      if (revision !== this.revision) return;
      this.sources = sources;
      this.slider.value = "0";
      this.render();
    } catch (error) {
      if (revision !== this.revision) return;
      this.sources = [];
      this.render();
      this.error.textContent = error.message === "Choose an image file." ? error.message : "Could not open this image.";
    }
  }

  assets() {
    return this.sources.map(({ width, height, luminance, threshold }) => {
      const pixels = thresholdPixels(luminance, Math.max(0, Math.min(256, threshold + Number(this.slider.value))));
      return { width, height, pixels, canvas: binaryCanvas(width, height, pixels) };
    });
  }

  render() {
    const asset = this.assets()[0];
    this.preview.hidden = !asset;
    this.drop.querySelector("span").hidden = Boolean(asset);
    document.getElementById("image-threshold-field").hidden = !asset;
    this.add.disabled = !asset;
    if (asset) {
      this.preview.width = asset.width;
      this.preview.height = asset.height;
      this.preview.getContext("2d").drawImage(asset.canvas, 0, 0);
    }
  }
}
