import { encodeDataCodewords, encodeErrorCorrectionBlocks } from "./data-encoding.js";
import { analyzeDamage, canDrawOn, generateBaseline } from "./qr-engine.js";
import { applyImageConstraints } from "./image-constraints.js";

const LEVELS = ["H", "Q", "M", "L"];
const MASKS = [0, 1, 2, 3, 4, 5, 6, 7];
const paddingCache = new Map();

export function fittingModes(message, version, level) {
  const modes = [];
  if (message.length && !/[^0-9]/.test(message)) modes.push("numeric");
  if (message.length && !/[^0-9A-Z $%*+./:-]/.test(message)) modes.push("alphanumeric");
  modes.push("byte");
  return modes.filter((type) => {
    try {
      encodeDataCodewords({
        type, value: message, version, errorCorrectionLevel: level,
      });
      return true;
    } catch (error) {
      if (!error.message.includes("Data does not fit")) throw error;
      return false;
    }
  });
}

export function fittingLevels(message, version, level = "auto") {
  return (level === "auto" ? LEVELS : [level]).filter((candidate) =>
    fittingModes(message, version, candidate).length > 0,
  );
}

export function smallestVersion(message, level = "auto", maxVersion = 40) {
  for (let version = 1; version <= maxVersion; version += 1) {
    if (fittingLevels(message, version, level).length) return version;
  }
  throw new Error(`Content does not fit in Versions 1-${maxVersion}.`);
}

function evaluate(base, targets, paddingBytes = base.paddingBytes, allowApproximation = false) {
  const model = paddingBytes === base.paddingBytes ? base : generateBaseline({
    version: base.version, level: base.level, mask: base.mask,
    message: base.message, type: base.type, paddingBytes: paddingBytes?.length ? paddingBytes : null,
  });
  const { edited, appliedTargets, imageStats } = applyImageConstraints(model, targets, allowApproximation);
  const damage = analyzeDamage(model, edited);
  const counts = damage.blockStats.map((block) => block.totalDamaged);
  return {
    model, edited, damage, appliedTargets, imageStats,
    imageMismatches: imageStats.reduce((sum, image) => sum + image.total - image.matched, 0),
    readable: damage.blockStats.every((block) => block.totalDamaged <= block.theoreticalLimit) &&
      damage.metadataStats.every((region) => region.damagedBits <= region.theoreticalLimit) &&
      imageStats.every((image) => image.matched >= image.minimum),
    maximumUse: Math.max(
      ...damage.blockStats.map((block) => block.totalDamaged / block.theoreticalLimit),
      ...damage.metadataStats.map((region) => region.damagedBits / region.theoreticalLimit),
    ),
    totalDamaged: counts.reduce((sum, value) => sum + value, 0),
    metadataDamaged: damage.metadataStats.reduce((sum, region) => sum + region.damagedBits, 0),
    paddingChanges: model.dataBlocks.flat().slice(model.paddingStartCodeword).reduce(
      (sum, byte, index) => sum + Number(byte !== (index % 2 === 0 ? 0xec : 0x11)), 0,
    ),
    penalty: calculateMaskPenalty(edited),
  };
}

function compare(a, b) {
  return Number(b.readable) - Number(a.readable) ||
    a.maximumUse - b.maximumUse || a.totalDamaged - b.totalDamaged ||
    a.metadataDamaged - b.metadataDamaged ||
    a.imageMismatches - b.imageMismatches ||
    LEVELS.indexOf(a.model.level) - LEVELS.indexOf(b.model.level) ||
    a.model.paddingStartCodeword - b.model.paddingStartCodeword ||
    a.paddingChanges - b.paddingChanges ||
    a.penalty - b.penalty;
}

export async function optimizeDrawing({ message, version, level = "auto", mask = "auto", targets = [], previous, allowMetadata = false, allowAlignment = false, allowImageApproximation = false }, onBest = () => {}) {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new Error("Version must be between 1 and 40.");
  }
  if (level !== "auto" && !LEVELS.includes(level)) throw new Error("Invalid ECC level.");
  if (mask !== "auto" && (!Number.isInteger(Number(mask)) || Number(mask) < 0 || Number(mask) > 7)) {
    throw new Error("Invalid mask pattern.");
  }
  const levels = fittingLevels(message, version, level);
  if (!levels.length) throw new Error("Content does not fit at this version and ECC level.");
  let best = null;
  const assess = (base, editableTargets, padding) => evaluate(base, editableTargets, padding, allowImageApproximation);
  const record = (result) => {
    if (!best || compare(result, best) < 0) {
      best = result;
      onBest(result);
    }
    return result;
  };

  for (const candidateLevel of levels) {
    for (const type of fittingModes(message, version, candidateLevel)) {
      let paddingBasis;
      for (const candidateMask of mask === "auto" ? MASKS : [Number(mask)]) {
        const base = generateBaseline({ version, level: candidateLevel, mask: candidateMask, message, type });
        const editableTargets = targets.filter(({ row, column }) =>
          Number.isInteger(row) && Number.isInteger(column) &&
          row >= 0 && column >= 0 && row < base.matrix.length && column < base.matrix.length &&
          canDrawOn(base, row, column, allowMetadata, allowAlignment),
        );
        const standard = record(assess(base, editableTargets));
        if (!editableTargets.some(({ row, column }) =>
          ["data", "ecc"].includes(base.metadata[row][column].kind),
        )) continue;

        const variants = [standard];
        if (previous && previous.version === version && previous.level === candidateLevel &&
            previous.mask === candidateMask && previous.message === message && previous.type === type) {
          variants.push(record(assess(previous, editableTargets)));
        }
        const cacheKey = `${version}:${candidateLevel}:${base.paddingStartCodeword}`;
        if (!paddingBasis) {
          paddingBasis = paddingCache.get(cacheKey) ?? buildPaddingBasis(base);
          if (!paddingCache.has(cacheKey)) {
            if (paddingCache.size >= 12) paddingCache.delete(paddingCache.keys().next().value);
            paddingCache.set(cacheKey, paddingBasis);
          }
        }
        const seen = new Set();
        for (let strategy = 0; strategy < 6; strategy += 1) {
          const padding = solvePadding(base, editableTargets, paddingBasis, strategy);
          const key = padding.join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          variants.push(record(assess(base, editableTargets, padding)));
        }

        // Each Reed-Solomon block is independent: combine the best strategy per block.
        const combined = base.dataBlocks.flat().slice(base.paddingStartCodeword);
        let offset = 0;
        base.blocks.forEach((block, index) => {
          const winner = variants.reduce((a, b) =>
            b.damage.blockStats[index].totalDamaged < a.damage.blockStats[index].totalDamaged ? b : a,
          );
          for (let word = 0; word < block.dataCount; word += 1) {
            const paddingIndex = offset + word - base.paddingStartCodeword;
            if (paddingIndex >= 0) combined[paddingIndex] = winner.model.dataBlocks[index][word];
          }
          offset += block.dataCount;
        });
        record(assess(base, editableTargets, combined));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return best;
}

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

function makeBlockVariables(model, blockIndex, globalOffset) {
  const block = model.blocks[blockIndex];
  const variables = [];
  const directVariableByBit = new Map();

  for (
    let codewordIndex = 0;
    codewordIndex < block.dataCount;
    codewordIndex += 1
  ) {
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

function buildPaddingBasis(model) {
  let globalOffset = 0;
  const basis = [];
  for (let blockIndex = 0; blockIndex < model.blocks.length; blockIndex += 1) {
    const block = model.blocks[blockIndex];
    const blockBasis = makeBlockVariables(
      model,
      blockIndex,
      globalOffset,
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
  // Solve bit deltas from standard padding so unconstrained bytes stay EC 11.
  const paddingBytes = model.dataBlocks.flat().slice(model.paddingStartCodeword);
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
