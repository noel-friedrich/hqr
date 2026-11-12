import assert from "node:assert/strict";
import test from "node:test";
import { canDrawOn, generateBaseline, isMetadataModule } from "../js/qr-engine.js";
import { optimizeDrawing } from "../js/optimizer.js";

const settings = { message: "hi", version: 2, level: "H", mask: 0 };

function alignmentTargets(model) {
  return model.functionMap.flatMap((line, row) => line.flatMap((kind, column) =>
    kind === "alignment" ? [{ row, column, value: !model.matrix[row][column] }] : [],
  ));
}

test("alignment/timing drawing is independent of metadata permission and protects other functions", () => {
  assert.equal(alignmentTargets(generateBaseline({ ...settings, version: 1 })).length, 0);
  assert.equal(alignmentTargets(generateBaseline(settings)).length, 25);
  const model = generateBaseline({ ...settings, version: 7 });
  assert.ok(alignmentTargets(model).length > 25);
  for (const allowMetadata of [false, true]) {
    for (const allowAlignment of [false, true]) {
      model.functionMap.forEach((line, row) => line.forEach((kind, column) => {
        const expected = !kind || (allowMetadata && isMetadataModule(kind)) ||
          (allowAlignment && (kind === "alignment" || kind === "timing"));
        assert.equal(canDrawOn(model, row, column, allowMetadata, allowAlignment), expected);
      }));
    }
  }
  assert.equal(canDrawOn(model, -1, 0, true, true), false);
  assert.equal(canDrawOn(model, 0, 1000, true, true), false);
});

test("alignment targets are ignored unless explicitly enabled", async () => {
  const model = generateBaseline(settings);
  const targets = alignmentTargets(model);
  for (const allowMetadata of [false, true]) {
    const result = await optimizeDrawing({ ...settings, targets, allowMetadata });
    assert.deepEqual(result.edited, model.matrix);
    assert.equal(result.totalDamaged, 0);
    assert.equal(result.metadataDamaged, 0);
  }
});

test("enabled alignment edits do not spend data or metadata ECC", async () => {
  for (const version of [2, 7]) {
    const model = generateBaseline({ ...settings, version });
    const targets = alignmentTargets(model);
    const result = await optimizeDrawing({ ...settings, version, targets, allowAlignment: true });
    assert.equal(result.totalDamaged, 0);
    assert.equal(result.metadataDamaged, 0);
    assert.equal(result.readable, true);
    for (let row = 0; row < model.matrix.length; row += 1) {
      for (let column = 0; column < model.matrix.length; column += 1) {
        assert.equal(result.edited[row][column], model.functionMap[row][column] === "alignment"
          ? !model.matrix[row][column] : model.matrix[row][column]);
      }
    }
  }
});

test("timing patterns are editable only with the alignment/timing option, including version one", async () => {
  for (const version of [1, 2, 7]) {
    const model = generateBaseline({ ...settings, version });
    const targets = model.functionMap.flatMap((line, row) => line.flatMap((kind, column) =>
      kind === "timing" ? [{ row, column, value: !model.matrix[row][column] }] : [],
    ));
    assert.ok(targets.length > 0);
    const locked = await optimizeDrawing({ ...settings, version, targets, allowMetadata: true });
    assert.deepEqual(locked.edited, model.matrix);
    const editable = await optimizeDrawing({ ...settings, version, targets, allowAlignment: true });
    assert.equal(editable.totalDamaged, 0);
    assert.equal(editable.metadataDamaged, 0);
    assert.equal(editable.readable, true);
    model.matrix.forEach((line, row) => line.forEach((value, column) => {
      assert.equal(editable.edited[row][column], model.functionMap[row][column] === "timing" ? !value : value);
    }));
  }
});
