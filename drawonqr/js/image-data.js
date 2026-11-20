import { canDrawOn } from "./qr-engine.js";

export function luminancePixels(rgba) {
  return Int16Array.from({ length: rgba.length / 4 }, (_, index) => {
    const offset = index * 4;
    return rgba[offset + 3] < 128 ? -1 : Math.round(
      rgba[offset] * .2126 + rgba[offset + 1] * .7152 + rgba[offset + 2] * .0722,
    );
  });
}

export function balancedThreshold(pixels) {
  const histogram = Array(256).fill(0);
  let total = 0;
  for (const value of pixels) if (value >= 0) { histogram[value] += 1; total += 1; }
  if (!total) return 128;
  const below = [0];
  histogram.forEach((count, index) => { below[index + 1] = below[index] + count; });
  let low = 0, high = 256, best = 128;
  for (let step = 0; step < 9 && low <= high; step += 1) {
    const middle = Math.floor((low + high) / 2);
    const error = Math.abs(below[middle] - total / 2);
    const bestError = Math.abs(below[best] - total / 2);
    if (error < bestError || (error === bestError && Math.abs(middle - 128) < Math.abs(best - 128))) best = middle;
    if (below[middle] < total / 2) low = middle + 1;
    else high = middle - 1;
  }
  return best;
}

export function thresholdPixels(pixels, threshold) {
  return Int8Array.from(pixels, (value) => value < 0 ? -1 : Number(value < threshold));
}

export function imageCoordinates(image, x, y) {
  const dx = x - image.x, dy = y - image.y;
  const cosine = Math.cos(image.rotation), sine = Math.sin(image.rotation);
  return {
    u: (dx * cosine + dy * sine) / image.width + .5,
    v: (-dx * sine + dy * cosine) / image.height + .5,
  };
}

export function sampleImageTargets(images, model, allowMetadata = false, allowAlignment = false) {
  const size = model.matrix.length;
  const targets = new Map();
  for (const image of images) {
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (!canDrawOn(model, row, column, allowMetadata, allowAlignment)) continue;
        const { u, v } = imageCoordinates(image, (column + .5) / size, (row + .5) / size);
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        const { asset } = image;
        const value = asset.pixels[Math.floor(v * asset.height) * asset.width + Math.floor(u * asset.width)];
        if (value >= 0) targets.set(row * size + column, { row, column, value: Boolean(value), imageId: image.id });
      }
    }
  }
  return targets;
}

export function resizeImage(image, corner, point) {
  const [sx, sy] = corner;
  const cosine = Math.cos(image.rotation), sine = Math.sin(image.rotation);
  const anchor = {
    x: image.x - (sx * image.width * cosine - sy * image.height * sine) / 2,
    y: image.y - (sx * image.width * sine + sy * image.height * cosine) / 2,
  };
  const dx = point.x - anchor.x, dy = point.y - anchor.y;
  const localX = dx * cosine + dy * sine, localY = -dx * sine + dy * cosine;
  const scale = Math.max(.02 / Math.max(image.width, image.height), Math.min(
    3 / Math.max(image.width, image.height),
    (localX * sx * image.width + localY * sy * image.height) / (image.width ** 2 + image.height ** 2),
  ));
  const width = image.width * scale, height = image.height * scale;
  return {
    width, height,
    x: anchor.x + (sx * width * cosine - sy * height * sine) / 2,
    y: anchor.y + (sx * width * sine + sy * height * cosine) / 2,
  };
}
