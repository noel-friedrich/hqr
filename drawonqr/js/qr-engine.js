import {
  encodeDataCodewords,
  encodeErrorCorrectionBlocks,
  getBlockInfo,
  getRemainderBitCount,
} from "./data-encoding.js";

const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

export function sizeForVersion(version) {
  return 17 + version * 4;
}

export function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

export function isMetadataModule(functionType) {
  return functionType === "format" || functionType === "version";
}

export function canDrawOn(model, row, column, allowMetadata = false, allowAlignment = false) {
  const functionType = model.functionMap[row]?.[column];
  return functionType === "" || (allowMetadata && isMetadataModule(functionType)) ||
    (allowAlignment && (functionType === "alignment" || functionType === "timing"));
}

export function getMetadataRegions(version) {
  const size = sizeForVersion(version);
  const regions = [
    { name: "Format 1", positions: formatCopyA() },
    { name: "Format 2", positions: formatCopyB(size) },
  ];
  if (version >= 7) {
    const first = [];
    const second = [];
    for (let index = 0; index < 18; index += 1) {
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      first.push([b, a]);
      second.push([a, b]);
    }
    regions.push({ name: "Version 1", positions: first }, { name: "Version 2", positions: second });
  }
  return regions;
}

export function getAlignmentCenters(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const centers = [6];
  for (
    let position = sizeForVersion(version) - 7;
    centers.length < count;
    position -= step
  ) {
    centers.splice(1, 0, position);
  }
  return centers;
}

function makeMatrix(size, value = false) {
  return Array.from({ length: size }, () => Array(size).fill(value));
}

function makeMetadataMatrix(size) {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

function setFunction(map, row, column, type) {
  if (row >= 0 && row < map.length && column >= 0 && column < map.length) {
    map[row][column] = type;
  }
}

function drawFinderOnMap(map, startRow, startColumn) {
  for (let row = -1; row <= 7; row += 1) {
    for (let column = -1; column <= 7; column += 1) {
      const inside = row >= 0 && row <= 6 && column >= 0 && column <= 6;
      setFunction(
        map,
        startRow + row,
        startColumn + column,
        inside ? "finder" : "separator",
      );
    }
  }
}

export function buildFunctionMap(version) {
  const size = sizeForVersion(version);
  const map = Array.from({ length: size }, () => Array(size).fill(""));

  drawFinderOnMap(map, 0, 0);
  drawFinderOnMap(map, 0, size - 7);
  drawFinderOnMap(map, size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    setFunction(map, 6, index, "timing");
    setFunction(map, index, 6, "timing");
  }

  for (const centerRow of getAlignmentCenters(version)) {
    for (const centerColumn of getAlignmentCenters(version)) {
      const existing = map[centerRow][centerColumn];
      if (existing && existing !== "timing") continue;
      for (let row = -2; row <= 2; row += 1) {
        for (let column = -2; column <= 2; column += 1) {
          setFunction(map, centerRow + row, centerColumn + column, "alignment");
        }
      }
    }
  }

  for (const [row, column] of [...formatCopyA(size), ...formatCopyB(size)]) {
    setFunction(map, row, column, "format");
  }
  setFunction(map, size - 8, 8, "dark");

  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      setFunction(map, b, a, "version");
      setFunction(map, a, b, "version");
    }
  }

  return map;
}

function formatCopyA() {
  const result = [];
  for (let index = 0; index <= 5; index += 1) result.push([index, 8]);
  result.push([7, 8], [8, 8], [8, 7]);
  for (let index = 9; index < 15; index += 1) {
    result.push([8, 14 - index]);
  }
  return result;
}

function formatCopyB(size) {
  const result = [];
  for (let index = 0; index < 8; index += 1) {
    result.push([8, size - 1 - index]);
  }
  for (let index = 8; index < 15; index += 1) {
    result.push([size - 15 + index, 8]);
  }
  return result;
}

export function getDataPath(functionMap) {
  const path = [];
  const size = functionMap.length;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < size; offset += 1) {
      const row = upward ? size - 1 - offset : offset;
      for (const column of [right, right - 1]) {
        if (!functionMap[row][column]) path.push({ row, column });
      }
    }
    upward = !upward;
  }
  return path;
}

function setValue(matrix, row, column, value) {
  if (
    row >= 0 &&
    row < matrix.length &&
    column >= 0 &&
    column < matrix.length
  ) {
    matrix[row][column] = Boolean(value);
  }
}

function drawFinderValues(matrix, startRow, startColumn) {
  for (let row = -1; row <= 7; row += 1) {
    for (let column = -1; column <= 7; column += 1) {
      const inside = row >= 0 && row <= 6 && column >= 0 && column <= 6;
      const dark =
        inside &&
        (row === 0 ||
          row === 6 ||
          column === 0 ||
          column === 6 ||
          (row >= 2 && row <= 4 && column >= 2 && column <= 4));
      setValue(matrix, startRow + row, startColumn + column, dark);
    }
  }
}

function drawAlignmentValues(matrix, centerRow, centerColumn) {
  for (let row = -2; row <= 2; row += 1) {
    for (let column = -2; column <= 2; column += 1) {
      const distance = Math.max(Math.abs(row), Math.abs(column));
      setValue(
        matrix,
        centerRow + row,
        centerColumn + column,
        distance === 2 || distance === 0,
      );
    }
  }
}

function getFormatCode(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | Number(mask);
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (remainder & (1 << bit)) remainder ^= 0x537 << (bit - 10);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function getVersionCode(version) {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit -= 1) {
    if (remainder & (1 << bit)) remainder ^= 0x1f25 << (bit - 12);
  }
  return (version << 12) | (remainder & 0xfff);
}

function drawFunctionValues(matrix, version, level, mask) {
  const size = matrix.length;
  drawFinderValues(matrix, 0, 0);
  drawFinderValues(matrix, 0, size - 7);
  drawFinderValues(matrix, size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    matrix[6][index] = index % 2 === 0;
    matrix[index][6] = index % 2 === 0;
  }

  for (const centerRow of getAlignmentCenters(version)) {
    for (const centerColumn of getAlignmentCenters(version)) {
      const overlapsFinder =
        (centerRow <= 8 && centerColumn <= 8) ||
        (centerRow <= 8 && centerColumn >= size - 9) ||
        (centerRow >= size - 9 && centerColumn <= 8);
      if (!overlapsFinder) {
        drawAlignmentValues(matrix, centerRow, centerColumn);
      }
    }
  }
  matrix[size - 8][8] = true;

  const formatCode = getFormatCode(level, mask);
  for (const copy of [formatCopyA(size), formatCopyB(size)]) {
    copy.forEach(([row, column], index) => {
      matrix[row][column] = Boolean((formatCode >>> index) & 1);
    });
  }

  if (version >= 7) {
    const code = getVersionCode(version);
    for (let index = 0; index < 18; index += 1) {
      const a = size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      const value = Boolean((code >>> index) & 1);
      matrix[b][a] = value;
      matrix[a][b] = value;
    }
  }
}

function maskApplies(mask, row, column) {
  switch (Number(mask)) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function toBits(value) {
  return value.toString(2).padStart(8, "0");
}

function makeInterleavedEntries(blocks, kind) {
  const entries = [];
  const blockOffsets = [];
  let offset = 0;
  for (const block of blocks) {
    blockOffsets.push(offset);
    offset += block.length;
  }
  const maxLength = Math.max(...blocks.map((block) => block.length));
  for (let codewordIndex = 0; codewordIndex < maxLength; codewordIndex += 1) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      if (codewordIndex < block.length) {
        entries.push({
          blockIndex,
          codewordIndex,
          kind,
          value: block[codewordIndex],
          globalDataCodewordIndex:
            kind === "data" ? blockOffsets[blockIndex] + codewordIndex : null,
        });
      }
    }
  }
  return entries;
}

function expandBlockDefinitions(version, level) {
  const info = getBlockInfo(version, level);
  const result = [];
  for (const group of info.groups) {
    for (let index = 0; index < group.blocks; index += 1) {
      result.push({
        dataCount: group.dataCodewords,
        eccCount: info.ecCodewordsPerBlock,
      });
    }
  }
  return result;
}

export function generateBaseline({
  version,
  level,
  mask,
  message,
  type = "byte",
  paddingBytes = null,
}) {
  const functionMap = buildFunctionMap(version);
  const path = getDataPath(functionMap);
  const matrix = makeMatrix(sizeForVersion(version));
  const metadata = makeMetadataMatrix(matrix.length);
  drawFunctionValues(matrix, version, level, mask);

  const encoded = encodeDataCodewords({
    type,
    value: message,
    version,
    errorCorrectionLevel: level,
    paddingBytes,
  });
  const eccBlocks = encodeErrorCorrectionBlocks({
    dataBlocks: encoded.blocks,
    version,
    errorCorrectionLevel: level,
  });
  const dataEntries = makeInterleavedEntries(encoded.blocks, "data");
  const eccEntries = makeInterleavedEntries(eccBlocks, "ecc");
  const entries = [...dataEntries, ...eccEntries];
  const rawBits = entries.flatMap((entry, physicalCodewordIndex) =>
    [...toBits(entry.value)].map((bit, bitIndex) => ({
      ...entry,
      physicalCodewordIndex,
      bitIndex,
      bit: Number(bit),
    })),
  );

  path.forEach(({ row, column }, streamBitIndex) => {
    const bit = rawBits[streamBitIndex];
    if (!bit) {
      metadata[row][column] = {
        kind: "remainder",
        streamBitIndex,
        rawBit: 0,
        masked: maskApplies(mask, row, column),
      };
      matrix[row][column] = maskApplies(mask, row, column);
      return;
    }

    const finalBit = bit.bit ^ Number(maskApplies(mask, row, column));
    matrix[row][column] = Boolean(finalBit);
    metadata[row][column] = {
      kind: bit.kind,
      blockIndex: bit.blockIndex,
      blockCodewordIndex: bit.codewordIndex,
      physicalCodewordIndex: bit.physicalCodewordIndex,
      bitIndex: bit.bitIndex,
      streamBitIndex,
      rawBit: bit.bit,
      masked: maskApplies(mask, row, column),
      globalDataCodewordIndex: bit.globalDataCodewordIndex,
    };
  });

  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix.length; column += 1) {
      if (functionMap[row][column]) {
        metadata[row][column] = {
          kind: "function",
          functionType: functionMap[row][column],
        };
      }
    }
  }

  return {
    version,
    level,
    mask: Number(mask),
    message,
    type,
    paddingBytes,
    matrix,
    metadata,
    functionMap,
    path,
    blocks: expandBlockDefinitions(version, level),
    dataBlocks: encoded.blocks,
    eccBlocks,
    codewordEntries: entries,
    paddingStartCodeword: encoded.paddingStartCodeword,
    totalCodewords: entries.length,
    remainderBitCount: getRemainderBitCount(version),
  };
}

function codewordKey(meta) {
  return `${meta.blockIndex}:${meta.kind}:${meta.blockCodewordIndex}`;
}

export function analyzeDamage(model, editedMatrix) {
  const changedModules = [];
  const changedCodewords = new Map();
  let changedRemainderModules = 0;

  for (let row = 0; row < model.matrix.length; row += 1) {
    for (let column = 0; column < model.matrix.length; column += 1) {
      if (editedMatrix[row][column] === model.matrix[row][column]) continue;
      const meta = model.metadata[row][column];
      changedModules.push({ row, column, meta });
      if (meta.kind === "data" || meta.kind === "ecc") {
        changedCodewords.set(codewordKey(meta), meta);
      } else if (meta.kind === "remainder") {
        changedRemainderModules += 1;
      }
    }
  }

  const blockStats = model.blocks.map((block, blockIndex) => {
    const changed = [...changedCodewords.values()].filter(
      (meta) => meta.blockIndex === blockIndex,
    );
    const damagedData = changed.filter((meta) => meta.kind === "data").length;
    const damagedEcc = changed.filter((meta) => meta.kind === "ecc").length;
    const totalDamaged = damagedData + damagedEcc;
    const theoreticalLimit = Math.floor(block.eccCount / 2);
    const ratio = theoreticalLimit === 0 ? 1 : totalDamaged / theoreticalLimit;
    const status =
      ratio <= 0.5
        ? "safe"
        : ratio <= 0.75
          ? "warning"
          : ratio <= 1
            ? "risky"
            : "invalid";

    return {
      blockIndex,
      ...block,
      damagedData,
      damagedEcc,
      totalDamaged,
      theoreticalLimit,
      conservativeLimit: Math.floor(theoreticalLimit / 2),
      status,
    };
  });

  return {
    changedModules,
    changedCodewords,
    changedRemainderModules,
    blockStats,
    metadataStats: getMetadataRegions(model.version).map(({ name, positions }) => ({
      name,
      damagedBits: positions.filter(([row, column]) => editedMatrix[row][column] !== model.matrix[row][column]).length,
      theoreticalLimit: 3,
    })),
  };
}

export function applyChanges(matrix, changes) {
  const next = cloneMatrix(matrix);
  for (const change of changes) {
    next[change.row][change.column] = change.value;
  }
  return next;
}
