import assert from "node:assert/strict";
import test from "node:test";
import { balancedThreshold, imageCoordinates, luminancePixels, resizeImage, sampleImageTargets, thresholdPixels } from "../js/image-data.js";
import { applyImageConstraints } from "../js/image-constraints.js";
import { canDrawOn, generateBaseline, getMetadataRegions } from "../js/qr-engine.js";
import { optimizeDrawing } from "../js/optimizer.js";

const settings = { message: "abcdefg", version: 1, level: "H", mask: 0 };

function picture(id, pixels = [1, 0]) {
  return { id, x: .5, y: .5, width: 1, height: 1, rotation: 0, asset: { width: 2, height: 1, pixels } };
}

function drawing(model, changed, matching, imageId) {
  const seen = new Set();
  const targets = [];
  for (const { row, column } of model.path) {
    const meta = model.metadata[row][column];
    if (meta.kind !== "data" && meta.kind !== "ecc") continue;
    const key = `${meta.kind}:${meta.blockIndex}:${meta.blockCodewordIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ row, column, value: !model.matrix[row][column], imageId });
    if (targets.length === changed) break;
  }
  const positions = new Set(targets.map(({ row, column }) => `${row}:${column}`));
  for (const { row, column } of model.path) {
    if (matching === 0) break;
    if (positions.has(`${row}:${column}`)) continue;
    targets.push({ row, column, value: model.matrix[row][column], imageId });
    matching -= 1;
  }
  return targets;
}

test("threshold initialization balances brightness and ignores transparent pixels", () => {
  const pixels = luminancePixels([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]);
  assert.deepEqual([...pixels], [0, 255, -1]);
  assert.equal(balancedThreshold(pixels), 128);
  assert.deepEqual([...thresholdPixels(pixels, 128)], [1, 0, -1]);
  const gradient = Int16Array.from({ length: 256 }, (_, index) => index);
  assert.equal([...thresholdPixels(gradient, balancedThreshold(gradient))].filter(Boolean).length, 128);
  const dim = Int16Array.from({ length: 100 }, (_, index) => 20 + index);
  assert.equal([...thresholdPixels(dim, balancedThreshold(dim))].filter(Boolean).length, 50);
  assert.deepEqual([...thresholdPixels(pixels, 0)], [0, 0, -1]);
  assert.deepEqual([...thresholdPixels(pixels, 256)], [1, 1, -1]);
  assert.equal(balancedThreshold([-1, -1]), 128);
});

test("sampling uses module centers, normalized geometry, and inverse rotation", () => {
  for (const size of [4, 8]) {
    const model = { matrix: Array.from({ length: size }, () => Array(size).fill(false)), functionMap: Array.from({ length: size }, () => Array(size).fill("")) };
    const image = picture("first");
    const sampled = sampleImageTargets([image], model);
    assert.equal(sampled.size, size * size);
    for (const target of sampled.values()) assert.equal(target.value, target.column < size / 2);
    image.rotation = Math.PI / 2;
    for (const target of sampleImageTargets([image], model).values()) assert.equal(target.value, target.row < size / 2);
    assert.deepEqual(imageCoordinates(image, .5, .5), { u: .5, v: .5 });
  }
});

test("newer opaque images win without changing selection order, and manual targets override images", () => {
  const model = generateBaseline(settings);
  const first = picture("first", [1, 1]);
  const second = picture("second", [-1, 0]);
  const sampled = sampleImageTargets([first, second], model);
  for (const target of sampled.values()) {
    assert.equal(target.value, target.column + .5 < model.matrix.length / 2);
    assert.equal(target.imageId, target.value ? "first" : "second");
  }
  const target = [...sampled.values()][0];
  const manual = { row: target.row, column: target.column, value: !target.value };
  sampled.set(target.row * model.matrix.length + target.column, manual);
  assert.equal(sampled.get(target.row * model.matrix.length + target.column).imageId, undefined);
  const result = applyImageConstraints(model, [...sampled.values()], true);
  for (const image of result.imageStats) {
    assert.equal(image.total, [...sampled.values()].filter(({ imageId }) => imageId === image.imageId).length);
  }
});

test("image targets respect metadata and alignment/timing permissions", () => {
  const model = generateBaseline({ ...settings, version: 7 });
  for (const allowMetadata of [false, true]) for (const allowAlignment of [false, true]) {
    const targets = sampleImageTargets([picture("all", [1, 1])], model, allowMetadata, allowAlignment);
    model.matrix.forEach((line, row) => line.forEach((_, column) => {
      assert.equal(targets.has(row * line.length + column), canDrawOn(model, row, column, allowMetadata, allowAlignment));
    }));
  }
});

test("corner resizing keeps the opposite corner fixed and preserves aspect ratio after rotation", () => {
  for (const rotation of [0, Math.PI / 3]) for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const image = { ...picture("first"), width: .4, height: .2, rotation };
    const [sx, sy] = corner;
    const local = (width, height) => ({
      x: (sx * width * Math.cos(rotation) - sy * height * Math.sin(rotation)) / 2,
      y: (sx * width * Math.sin(rotation) + sy * height * Math.cos(rotation)) / 2,
    });
    const before = local(image.width, image.height);
    const resized = resizeImage(image, corner, { x: image.x + before.x * 2, y: image.y + before.y * 2 });
    assert.ok(Math.abs(resized.width / resized.height - 2) < 1e-10);
    const after = local(resized.width, resized.height);
    assert.ok(Math.abs(resized.x - after.x - (image.x - before.x)) < 1e-10);
    assert.ok(Math.abs(resized.y - after.y - (image.y - before.y)) < 1e-10);
  }
});

test("approximation can recover an over-budget image without relaxing manual drawing", async () => {
  const model = generateBaseline(settings);
  const targets = drawing(model, 10, 10, "first");
  const strict = await optimizeDrawing({ ...settings, targets });
  assert.equal(strict.readable, false);
  assert.equal(strict.imageStats[0].matched, 20);
  assert.equal(strict.totalDamaged, 10);
  const approximate = await optimizeDrawing({ ...settings, targets, allowImageApproximation: true });
  assert.equal(approximate.readable, true);
  assert.equal(approximate.totalDamaged, 6);
  assert.deepEqual(approximate.imageStats, [{ imageId: "first", total: 20, matched: 16, minimum: 16 }]);
  const manual = targets.map(({ imageId, ...target }) => target);
  const hard = await optimizeDrawing({ ...settings, targets: manual, allowImageApproximation: true });
  assert.equal(hard.readable, false);
  for (const { row, column, value } of manual) assert.equal(hard.edited[row][column], value);
});

test("80 percent is enforced per image rather than pooled across images", () => {
  const model = generateBaseline(settings);
  const targets = drawing(model, 10, 10, "large");
  targets[0] = { ...targets[0], imageId: "small" };
  const result = applyImageConstraints(model, targets, true);
  const small = result.imageStats.find(({ imageId }) => imageId === "small");
  assert.equal(small.matched, 1);
  for (const image of result.imageStats) assert.ok(image.matched >= Math.ceil(image.total * .8));
  assert.equal(result.edited[targets[0].row][targets[0].column], targets[0].value);
});

test("approximation does not partially repair codewords already damaged by manual targets", () => {
  const model = generateBaseline(settings);
  const targets = drawing(model, 1, 9, "first");
  const first = targets[0];
  const firstMeta = model.metadata[first.row][first.column];
  const other = model.path.find(({ row, column }) => {
    const meta = model.metadata[row][column];
    return meta.kind === firstMeta.kind && meta.blockCodewordIndex === firstMeta.blockCodewordIndex && meta.bitIndex !== firstMeta.bitIndex;
  });
  const withoutOther = targets.filter(({ row, column }) => row !== other.row || column !== other.column);
  const result = applyImageConstraints(model, [...withoutOther, { ...other, value: !model.matrix[other.row][other.column] }], true);
  assert.equal(result.edited[first.row][first.column], first.value);
});

test("images that remain beyond ECC limits are invalid even with approximation", async () => {
  const model = generateBaseline(settings);
  const targets = drawing(model, 20, 0, "dense");
  const result = await optimizeDrawing({ ...settings, targets, allowImageApproximation: true });
  assert.equal(result.readable, false);
  assert.ok(result.imageStats[0].matched >= result.imageStats[0].minimum);
});

test("image approximation respects metadata's separate per-copy correction limits", async () => {
  const model = generateBaseline(settings);
  const targets = getMetadataRegions(1)[0].positions.slice(0, 4).map(([row, column]) => ({
    row, column, value: !model.matrix[row][column], imageId: "metadata",
  }));
  targets.push(...model.path.slice(0, 16).map(({ row, column }) => ({
    row, column, value: model.matrix[row][column], imageId: "metadata",
  })));
  const strict = await optimizeDrawing({ ...settings, targets, allowMetadata: true });
  assert.equal(strict.readable, false);
  const approximate = await optimizeDrawing({ ...settings, targets, allowMetadata: true, allowImageApproximation: true });
  assert.equal(approximate.readable, true);
  assert.equal(approximate.metadataDamaged, 0);
  assert.equal(approximate.imageStats[0].matched, 16);
  assert.equal(approximate.totalDamaged, 0);
});
