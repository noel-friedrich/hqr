import { encodeErrorCorrectionBlocks } from "./data-encoding.js";
import { analyzeDamage, cloneMatrix, generateBaseline } from "./qr-engine.js";
import {
  balancedLengthVariants,
  findTextPlacements,
  measurePlacement,
  rectangleGap,
  renderTextBlock,
} from "./text-layout.js";
import { DEFAULT_FONT_ID, getFont } from "./fonts.js";

function bitIsSet(bits, index) {
  return (bits[index >>> 5] & (1 << (index & 31))) !== 0;
}

function setBit(bits, index) {
  bits[index >>> 5] |= 1 << (index & 31);
}

function xorBits(target, source) {
  for (let index = 0; index < target.length; index += 1) {
    target[index] ^= source[index];
  }
}

function firstSetBit(bits, variableCount) {
  for (let index = 0; index < variableCount; index += 1) {
    if (bitIsSet(bits, index)) return index;
  }
  return -1;
}

function addEquation(basis, equation, variableCount, addedPivots) {
  // Reduce one desired module value against the block's existing GF(2) rows.
  const bits = equation.bits.slice();
  let rightHandSide = equation.rightHandSide;

  for (let pivot = 0; pivot < variableCount; pivot += 1) {
    if (!bitIsSet(bits, pivot) || !basis[pivot]) continue;
    xorBits(bits, basis[pivot].bits);
    rightHandSide ^= basis[pivot].rightHandSide;
  }

  const pivot = firstSetBit(bits, variableCount);
  if (pivot === -1) return rightHandSide === 0;
  basis[pivot] = { bits, rightHandSide };
  addedPivots.push(pivot);
  return true;
}

function tryAddEquationGroup(basis, equations, variableCount) {
  const addedPivots = [];
  for (const equation of equations) {
    if (!addEquation(basis, equation, variableCount, addedPivots)) {
      addedPivots.forEach((pivot) => {
        basis[pivot] = null;
      });
      return false;
    }
  }
  return true;
}

function solveBasis(basis, variableCount) {
  const solution = Array(variableCount).fill(false);
  for (let pivot = variableCount - 1; pivot >= 0; pivot -= 1) {
    const row = basis[pivot];
    if (!row) continue;
    let value = row.rightHandSide;
    for (let index = pivot + 1; index < variableCount; index += 1) {
      if (solution[index] && bitIsSet(row.bits, index)) value ^= 1;
    }
    solution[pivot] = Boolean(value);
  }
  return solution;
}

async function makeBlockVariables(model, blockIndex, globalOffset, signal) {
  const block = model.blocks[blockIndex];
  const variables = [];
  const directVariableByBit = new Map();

  for (
    let codewordIndex = 0;
    codewordIndex < block.dataCount;
    codewordIndex += 1
  ) {
    if (codewordIndex % 4 === 0) {
      await nextFrame();
      throwIfAborted(signal);
    }
    const globalCodewordIndex = globalOffset + codewordIndex;
    if (globalCodewordIndex < model.paddingStartCodeword) continue;

    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      // Reed-Solomon is linear, so encoding a one-bit delta gives this
      // padding bit's complete influence across the block's ECC modules.
      const deltaBlock = Array(block.dataCount).fill(0);
      const bitMask = 1 << (7 - bitIndex);
      deltaBlock[codewordIndex] = bitMask;
      const eccDelta = encodeErrorCorrectionBlocks({
        dataBlocks: [deltaBlock],
        version: model.version,
        errorCorrectionLevel: model.level,
      })[0];
      const variableIndex = variables.length;
      variables.push({
        codewordIndex,
        bitIndex,
        bitMask,
        paddingIndex: globalCodewordIndex - model.paddingStartCodeword,
        eccDelta,
      });
      directVariableByBit.set(`${codewordIndex}:${bitIndex}`, variableIndex);
    }
  }

  return { variables, directVariableByBit };
}

async function buildPaddingBasis(model, signal) {
  let globalOffset = 0;
  const basis = [];
  for (let blockIndex = 0; blockIndex < model.blocks.length; blockIndex += 1) {
    const block = model.blocks[blockIndex];
    const blockBasis = await makeBlockVariables(
      model,
      blockIndex,
      globalOffset,
      signal,
    );
    basis.push(blockBasis);
    globalOffset += block.dataCount;
  }
  return basis;
}

function coefficientsForModule(meta, blockBasis) {
  const variableCount = blockBasis.variables.length;
  const bits = new Uint32Array(Math.ceil(variableCount / 32));
  if (meta.kind === "data") {
    const variableIndex = blockBasis.directVariableByBit.get(
      `${meta.blockCodewordIndex}:${meta.bitIndex}`,
    );
    if (variableIndex !== undefined) setBit(bits, variableIndex);
  } else if (meta.kind === "ecc") {
    const bitMask = 1 << (7 - meta.bitIndex);
    blockBasis.variables.forEach((variable, variableIndex) => {
      if ((variable.eccDelta[meta.blockCodewordIndex] & bitMask) !== 0) {
        setBit(bits, variableIndex);
      }
    });
  }
  return bits;
}

function groupTargetEquations(model, targets, paddingBasis) {
  const groupsByBlock = model.blocks.map(() => new Map());
  for (const target of targets) {
    const meta = model.metadata[target.row][target.column];
    if (meta.kind !== "data" && meta.kind !== "ecc") continue;
    const key = `${meta.kind}:${meta.blockCodewordIndex}`;
    const groups = groupsByBlock[meta.blockIndex];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      bits: coefficientsForModule(meta, paddingBasis[meta.blockIndex]),
      rightHandSide:
        Number(model.matrix[target.row][target.column]) ^ Number(target.value),
    });
  }
  return groupsByBlock;
}

function orderEquationGroups(groups, strategy) {
  const entries = [...groups.entries()].map(([key, equations]) => ({
    key,
    equations,
    flipCount: equations.reduce(
      (sum, equation) => sum + equation.rightHandSide,
      0,
    ),
    kind: key.startsWith("data:") ? "data" : "ecc",
  }));
  const keyOrder = (a, b) => a.key.localeCompare(b.key);
  const strategies = [
    (a, b) =>
      a.equations.length - b.equations.length ||
      a.flipCount - b.flipCount ||
      keyOrder(a, b),
    (a, b) =>
      a.equations.length - b.equations.length ||
      b.flipCount - a.flipCount ||
      -keyOrder(a, b),
    (a, b) =>
      a.flipCount - b.flipCount ||
      a.equations.length - b.equations.length ||
      keyOrder(a, b),
    (a, b) =>
      Number(a.kind === "ecc") - Number(b.kind === "ecc") ||
      a.equations.length - b.equations.length ||
      keyOrder(a, b),
    (a, b) =>
      Number(a.kind === "data") - Number(b.kind === "data") ||
      a.equations.length - b.equations.length ||
      keyOrder(a, b),
    (a, b) =>
      b.equations.length - a.equations.length ||
      a.flipCount - b.flipCount ||
      keyOrder(a, b),
  ];
  return entries.sort(strategies[strategy] ?? strategies[0]);
}

function solvePadding(model, targets, paddingBasis, strategy = 0) {
  const paddingLength =
    model.dataBlocks.flat().length - model.paddingStartCodeword;
  const paddingBytes = Array(Math.max(0, paddingLength)).fill(0);
  const groupsByBlock = groupTargetEquations(model, targets, paddingBasis);

  groupsByBlock.forEach((groups, blockIndex) => {
    const blockBasis = paddingBasis[blockIndex];
    const variableCount = blockBasis.variables.length;
    const basis = Array(variableCount).fill(null);
    // Add a codeword's target equations atomically. A partly matched codeword
    // still costs one full correction, so pixel-by-pixel greed is wasteful.
    const equationGroups = orderEquationGroups(groups, strategy);
    equationGroups.forEach(({ equations }) => {
      tryAddEquationGroup(basis, equations, variableCount);
    });

    const solution = solveBasis(basis, variableCount);
    solution.forEach((enabled, variableIndex) => {
      if (!enabled) return;
      const variable = blockBasis.variables[variableIndex];
      paddingBytes[variable.paddingIndex] ^= variable.bitMask;
    });
  });

  return paddingBytes;
}

function applyTextTargets(matrix, targets) {
  const edited = cloneMatrix(matrix);
  targets.forEach(({ row, column, value }) => {
    edited[row][column] = value;
  });
  return edited;
}

function evaluatePadding(baseModel, placement, paddingBytes, budgetRatio) {
  const model = generateBaseline({
    version: baseModel.version,
    level: "H",
    mask: baseModel.mask,
    message: baseModel.message,
    type: "byte",
    paddingBytes: paddingBytes.length ? paddingBytes : null,
  });
  const edited = applyTextTargets(model.matrix, placement.targets);
  const damage = analyzeDamage(model, edited);
  const budgets = damage.blockStats.map((stat) =>
    Math.floor(stat.theoreticalLimit * budgetRatio),
  );
  const accepted = damage.blockStats.every(
    (stat, blockIndex) => stat.totalDamaged <= budgets[blockIndex],
  );
  const maximumUse = Math.max(
    ...damage.blockStats.map((stat, blockIndex) =>
      budgets[blockIndex] === 0
        ? stat.totalDamaged === 0
          ? 0
          : Infinity
        : stat.totalDamaged / budgets[blockIndex],
    ),
  );

  return {
    accepted,
    model,
    edited,
    damage,
    paddingBytes,
    placement,
    budgets,
    maximumUse,
    baselineMaskPenalty: calculateMaskPenalty(model.matrix),
    maskPenalty: calculateMaskPenalty(edited),
    totalDamaged: damage.blockStats.reduce(
      (sum, stat) => sum + stat.totalDamaged,
      0,
    ),
  };
}

function comparePaddingResults(a, b) {
  return (
    Number(b.accepted) - Number(a.accepted) ||
    a.maximumUse - b.maximumUse ||
    a.totalDamaged - b.totalDamaged ||
    a.maskPenalty - b.maskPenalty ||
    a.baselineMaskPenalty - b.baselineMaskPenalty
  );
}

function evaluatePlacement(
  baseModel,
  placement,
  paddingBasis,
  budgetRatio,
  useAlternativeStrategies = true,
) {
  const primaryPadding = solvePadding(
    baseModel,
    placement.targets,
    paddingBasis,
    0,
  );
  const primary = evaluatePadding(
    baseModel,
    placement,
    primaryPadding,
    budgetRatio,
  );
  if (
    primary.accepted ||
    !useAlternativeStrategies ||
    primary.maximumUse > 1.25
  ) {
    return primary;
  }

  const results = [primary];
  const seenPadding = new Set([primaryPadding.join(",")]);
  for (let strategy = 1; strategy < 6; strategy += 1) {
    const paddingBytes = solvePadding(
      baseModel,
      placement.targets,
      paddingBasis,
      strategy,
    );
    const key = paddingBytes.join(",");
    if (seenPadding.has(key)) continue;
    seenPadding.add(key);
    results.push(
      evaluatePadding(baseModel, placement, paddingBytes, budgetRatio),
    );
  }
  results.sort(comparePaddingResults);
  return results[0];
}

export function calculateMaskPenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;

  for (const line of [
    ...matrix,
    ...Array.from({ length: size }, (_, column) =>
      matrix.map((row) => row[column]),
    ),
  ]) {
    let runLength = 1;
    for (let index = 1; index < size; index += 1) {
      if (line[index] === line[index - 1]) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + runLength - 5;
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += 3 + runLength - 5;

    const bits = line.map(Number).join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      let offset = bits.indexOf(pattern);
      while (offset !== -1) {
        penalty += 40;
        offset = bits.indexOf(pattern, offset + 1);
      }
    }
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = matrix[row][column];
      if (
        matrix[row][column + 1] === value &&
        matrix[row + 1][column] === value &&
        matrix[row + 1][column + 1] === value
      ) {
        penalty += 3;
      }
    }
  }

  const darkModules = matrix
    .flat()
    .reduce((sum, value) => sum + Number(value), 0);
  const darkPercentage = (darkModules * 100) / (size * size);
  penalty += Math.floor(Math.abs(darkPercentage - 50) / 5) * 10;
  return penalty;
}

function compareResults(a, b) {
  return (
    a.maximumUse - b.maximumUse ||
    a.totalDamaged - b.totalDamaged ||
    a.baselineMaskPenalty - b.baselineMaskPenalty ||
    a.maskPenalty - b.maskPenalty ||
    a.placement.rectangleCount - b.placement.rectangleCount ||
    a.placement.lineCount - b.placement.lineCount ||
    b.placement.score - a.placement.score
  );
}

export function hqrLayoutKey(result) {
  return result.edited
    .map((row) => row.map((value) => Number(value)).join(""))
    .join("");
}

function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new DOMException("HQR generation was aborted.", "AbortError");
}

export async function findOptimalTextQr({
  message,
  displayText = message,
  fontId = DEFAULT_FONT_ID,
  budgetRatio = 0.8,
  allowSplit = false,
  allowWrap = true,
  horizontalOnly = false,
  startVersion = 1,
  maxVersion = 40,
  maskPatterns = [0, 1, 2, 3, 4, 5, 6, 7],
  onProgress = () => {},
  onSearchModel = () => {},
  onBestCandidate = () => {},
  excludedLayoutKeys = [],
  signal,
}) {
  throwIfAborted(signal);
  if (!message) throw new Error("Enter a URL or message to encode.");
  if (!displayText) throw new Error("Enter text to draw inside the QR code.");
  if (!(budgetRatio > 0 && budgetRatio <= 1)) {
    throw new Error("ECC budget must be greater than 0% and at most 100%.");
  }
  if (!Number.isInteger(maxVersion) || maxVersion < 1 || maxVersion > 40) {
    throw new Error("Maximum QR version must be an integer from 1 to 40.");
  }
  if (
    !Number.isInteger(startVersion) ||
    startVersion < 1 ||
    startVersion > maxVersion + 1
  ) {
    throw new Error("Starting QR version is outside the search range.");
  }
  getFont(fontId).validateText(displayText);
  if (!allowWrap && !allowSplit) {
    const textWidth = getFont(fontId).renderLine(displayText)[0].length + 2;
    const maximumWidth = 17 + maxVersion * 4;
    if (textWidth > maximumWidth) {
      throw new Error(`Text needs ${textWidth} modules on one line, but Version ${maxVersion} is only ${maximumWidth} modules wide. Enable text wrapping or splitting, shorten the text, or choose a smaller font.`);
    }
  }
  if (
    !Array.isArray(maskPatterns) ||
    maskPatterns.length === 0 ||
    maskPatterns.some((mask) => !Number.isInteger(mask) || mask < 0 || mask > 7)
  ) {
    throw new Error("Mask search must contain patterns 0 through 7.");
  }
  const excludedLayouts = new Set(excludedLayoutKeys);

  let bestRejected = null;
  for (let version = startVersion; version <= maxVersion; version += 1) {
    throwIfAborted(signal);
    const accepted = [];
    let versionFits = false;
    let paddingBasis = null;

    for (const mask of maskPatterns) {
      onProgress(`Trying Version ${version}, mask ${mask}...`);
      await nextFrame();
      throwIfAborted(signal);

      let baseModel;
      try {
        baseModel = generateBaseline({
          version,
          level: "H",
          mask,
          message,
          type: "byte",
          paddingBytes: [0],
        });
        versionFits = true;
      } catch {
        break;
      }
      onSearchModel(baseModel);

      const placements = findTextPlacements(
        baseModel,
        displayText,
        96,
        allowSplit,
        horizontalOnly,
        fontId,
        allowWrap,
      );
      if (!placements.length) continue;
      if (!paddingBasis) {
        paddingBasis = await buildPaddingBasis(baseModel, signal);
      }

      for (const batchEnd of [24, 96]) {
        const start = batchEnd === 24 ? 0 : 24;
        const batchResults = [];
        const recordResult = (result) => {
          batchResults.push(result);
          if (
            result.accepted &&
            !excludedLayouts.has(hqrLayoutKey(result))
          ) {
            accepted.push(result);
          }
          if (
            !excludedLayouts.has(hqrLayoutKey(result)) &&
            (!bestRejected || compareResults(result, bestRejected) < 0)
          ) {
            bestRejected = result;
            onBestCandidate(result);
          }
        };
        for (
          let placementIndex = start;
          placementIndex < Math.min(batchEnd, placements.length);
          placementIndex += 1
        ) {
          if ((placementIndex - start) % 4 === 0) {
            await nextFrame();
            throwIfAborted(signal);
          }
          recordResult(
            evaluatePlacement(
              baseModel,
              placements[placementIndex],
              paddingBasis,
              budgetRatio,
              false,
            ),
          );
        }
        if (!accepted.length) {
          batchResults.sort(compareResults);
          for (const nearMiss of batchResults.slice(0, 8)) {
            await nextFrame();
            throwIfAborted(signal);
            recordResult(
              evaluatePlacement(
                baseModel,
                nearMiss.placement,
                paddingBasis,
                budgetRatio,
                true,
              ),
            );
          }
        }
        if (accepted.length) break;
      }
    }

    if (accepted.length) {
      accepted.sort(compareResults);
      const uniqueResults = [];
      const seenLayouts = new Set();
      for (const result of accepted) {
        const key = hqrLayoutKey(result);
        if (seenLayouts.has(key)) continue;
        seenLayouts.add(key);
        uniqueResults.push(result);
      }
      const [result, ...pendingResults] = uniqueResults;
      return {
        ...result,
        fontId,
        allowWrap,
        continuation: {
          pendingResults,
          nextVersion: version + 1,
        },
      };
    }
    if (!versionFits) continue;
  }

  const detail = bestRejected
    ? ` Best attempt was Version ${bestRejected.model.version} with ${bestRejected.totalDamaged} damaged codewords.`
    : "";
  const subject = excludedLayouts.size || startVersion > 1
    ? "No other arrangement"
    : `No Version ${startVersion}-${maxVersion} arrangement`;
  throw new Error(
    `${subject} stays within the selected ECC budget.${detail}`,
  );
}

export function runQartTests() {
  const block = renderTextBlock("HI", 2);
  if (block.height !== 7 || block.width !== 9) {
    throw new Error("QArt test failed: Tom Thumb text layout");
  }
  if (
    renderTextBlock("ace", 3).height !== 6 ||
    renderTextBlock("j", 1).height !== 8
  ) {
    throw new Error("QArt test failed: actual glyph vertical bounds");
  }

  const testModel = generateBaseline({
    version: 5,
    level: "H",
    mask: 0,
    message: "HELLO",
    type: "byte",
    paddingBytes: [0],
  });
  const placement = findTextPlacements(testModel, "HI", 1)[0];
  if (
    !placement ||
    placement.targets.some(({ row, column }) => row < 0 || column < 0)
  ) {
    throw new Error("QArt test failed: placement coordinates");
  }
  if (
    placement.targets.some(
      ({ row, column }) => testModel.functionMap[row][column],
    )
  ) {
    throw new Error("QArt test failed: text overlaps a function module");
  }
  if (
    testModel.paddingStartCodeword <= 0 ||
    testModel.paddingStartCodeword >= testModel.dataBlocks.flat().length
  ) {
    throw new Error("QArt test failed: padding boundary");
  }

  const splitPlacement = findTextPlacements(testModel, "HELLO", 50, true).find(
    (candidate) => candidate.rectangleCount > 1,
  );
  if (
    !splitPlacement ||
    splitPlacement.rectangles.some((rectangle, index) => {
      const previous = splitPlacement.rectangles[index - 1];
      return (
        previous &&
        !(
          rectangle.top > previous.top ||
          (rectangle.top === previous.top &&
            rectangle.left >= previous.left + previous.block.width)
        )
      );
    })
  ) {
    throw new Error("QArt test failed: split text reading order");
  }
  const separatedPlacement = findTextPlacements(
    testModel,
    "HELLO WORLD",
    80,
    true,
  ).find(
    (candidate) =>
      candidate.rectangleCount > 1 &&
      candidate.rectangles.some((rectangle, index) => {
        const previous = candidate.rectangles[index - 1];
        return previous && rectangleGap(previous, rectangle) > 0;
      }),
  );
  if (!separatedPlacement) {
    throw new Error("QArt test failed: separated text rectangles");
  }
  const horizontalPlacements = findTextPlacements(
    testModel,
    "HELLO WORLD",
    80,
    true,
    true,
  );
  if (
    !horizontalPlacements.length ||
    horizontalPlacements.some((candidate) =>
      candidate.rectangles.some(
        (rectangle) => rectangle.block.width < rectangle.block.height,
      ),
    )
  ) {
    throw new Error("QArt test failed: horizontal-only text rectangles");
  }
  const metricModel = {
    matrix: Array.from({ length: 9 }, () => Array(9).fill(false)),
    metadata: Array.from({ length: 9 }, () =>
      Array.from({ length: 9 }, () => ({
        kind: "data",
        blockIndex: 0,
        blockCodewordIndex: 0,
        globalDataCodewordIndex: 0,
      })),
    ),
    paddingStartCodeword: 1,
  };
  const oneMismatch = measurePlacement(
    metricModel,
    { width: 1, height: 1, pixels: [[true]] },
    4,
    4,
  );
  const eightMismatches = measurePlacement(
    metricModel,
    {
      width: 8,
      height: 1,
      pixels: [Array(8).fill(true)],
    },
    4,
    0,
  );
  if (
    oneMismatch.mismatchedCodewords !== 1 ||
    eightMismatches.mismatchedCodewords !== 1 ||
    eightMismatches.score <= oneMismatch.score
  ) {
    throw new Error("QArt test failed: byte-level damage or width preference");
  }
  if (
    JSON.stringify(balancedLengthVariants(19, 2)) !==
    JSON.stringify([
      [10, 9],
      [9, 10],
    ])
  ) {
    throw new Error("QArt test failed: balanced wrapping variants");
  }
  const penalty = calculateMaskPenalty(testModel.matrix);
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new Error("QArt test failed: mask penalty");
  }
  return 11;
}
