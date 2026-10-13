import { DEFAULT_FONT_ID, getFont } from "./fonts.js";

const LINE_GAP = 1;
const BORDER = 1;

function wrapText(text, charactersPerLine) {
  const lines = [];
  for (let offset = 0; offset < text.length; offset += charactersPerLine) {
    lines.push(text.slice(offset, offset + charactersPerLine));
  }
  return lines;
}

function splitByLengths(text, lengths) {
  const lines = [];
  let offset = 0;
  for (const length of lengths) {
    lines.push(text.slice(offset, offset + length));
    offset += length;
  }
  return lines;
}

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function balancedLengthVariants(totalLength, partCount) {
  const shortLength = Math.floor(totalLength / partCount);
  const longerCount = totalLength % partCount;
  const base = Array.from(
    { length: partCount },
    (_, index) => shortLength + Number(index < longerCount),
  );
  const variants = new Map();
  for (let offset = 0; offset < partCount; offset += 1) {
    const lengths = rotate(base, offset);
    variants.set(lengths.join(","), lengths);
  }
  return [...variants.values()];
}

function makeLineVariants(text, maximumCharactersPerLine) {
  const variants = new Map();
  const minimumLines = Math.ceil(text.length / maximumCharactersPerLine);
  const maximumLines = Math.min(text.length, minimumLines + 8);
  for (
    let charactersPerLine = Math.min(text.length, maximumCharactersPerLine);
    charactersPerLine >= 1;
    charactersPerLine -= 1
  ) {
    const greedy = wrapText(text, charactersPerLine);
    if (greedy.length > maximumLines) break;
    const lengths = greedy.map((line) => line.length);
    for (let offset = 0; offset < lengths.length; offset += 1) {
      const rotatedLengths = rotate(lengths, offset);
      variants.set(
        rotatedLengths.join(","),
        splitByLengths(text, rotatedLengths),
      );
    }
  }

  for (
    let lineCount = minimumLines;
    lineCount <= maximumLines;
    lineCount += 1
  ) {
    for (const lengths of balancedLengthVariants(text.length, lineCount)) {
      if (Math.max(...lengths) > maximumCharactersPerLine) continue;
      variants.set(lengths.join(","), splitByLengths(text, lengths));
    }
  }
  return [...variants.values()];
}

function trimUnusedVerticalRows(pixels) {
  const firstUsedRow = pixels.findIndex((row) => row.some(Boolean));
  if (firstUsedRow === -1) {
    return [Array(pixels[0]?.length ?? 1).fill(false)];
  }

  let lastUsedRow = pixels.length - 1;
  while (!pixels[lastUsedRow].some(Boolean)) lastUsedRow -= 1;
  return pixels.slice(firstUsedRow, lastUsedRow + 1);
}

export function renderTextLines(lines, fontId = DEFAULT_FONT_ID) {
  const font = getFont(fontId);
  const text = lines.join("");
  font.validateText(text);
  const renderedLines = lines.map((line) =>
    trimUnusedVerticalRows(font.renderLine(line)),
  );
  const contentWidth =
    Math.max(...renderedLines.map((pixels) => pixels[0].length));
  const contentHeight =
    renderedLines.reduce((sum, pixels) => sum + pixels.length, 0) +
    (lines.length - 1) * LINE_GAP;
  const width = contentWidth + BORDER * 2;
  const height = contentHeight + BORDER * 2;
  const pixels = Array.from({ length: height }, () => Array(width).fill(false));

  let top = BORDER;
  renderedLines.forEach((linePixels) => {
    for (let row = 0; row < linePixels.length; row += 1) {
      for (let column = 0; column < linePixels[row].length; column += 1) {
        pixels[top + row][BORDER + column] = linePixels[row][column];
      }
    }
    top += linePixels.length + LINE_GAP;
  });

  return { pixels, width, height, lines };
}

export function renderTextBlock(text, charactersPerLine, fontId = DEFAULT_FONT_ID) {
  return renderTextLines(wrapText(text, charactersPerLine), fontId);
}

function touchesFunctionModule(functionMap, top, left, block) {
  for (let row = 0; row < block.height; row += 1) {
    for (let column = 0; column < block.width; column += 1) {
      if (functionMap[top + row][left + column]) return true;
    }
  }
  return false;
}

function makeTargets(block, top, left) {
  const targets = [];
  for (let row = 0; row < block.height; row += 1) {
    for (let column = 0; column < block.width; column += 1) {
      targets.push({
        row: top + row,
        column: left + column,
        value: block.pixels[row][column],
      });
    }
  }
  return targets;
}

export function measurePlacement(model, block, top, left) {
  let freeRemainderPixels = 0;
  const blockCoverage = new Set();
  const controllableCodewords = new Set();
  const mismatchedCodewords = new Set();
  const mismatchedCodewordsByBlock = new Map();

  for (let row = 0; row < block.height; row += 1) {
    for (let column = 0; column < block.width; column += 1) {
      const targetRow = top + row;
      const targetColumn = left + column;
      const meta = model.metadata[targetRow][targetColumn];
      const desired = block.pixels[row][column];
      const differs = model.matrix[targetRow][targetColumn] !== desired;

      if (meta.kind === "remainder") {
        if (differs) freeRemainderPixels += 1;
        continue;
      }
      if (meta.kind === "data" || meta.kind === "ecc") {
        blockCoverage.add(meta.blockIndex);
        const codewordKey = `${meta.blockIndex}:${meta.kind}:${meta.blockCodewordIndex}`;
        if (meta.globalDataCodewordIndex >= model.paddingStartCodeword) {
          controllableCodewords.add(codewordKey);
        }
        if (differs && !mismatchedCodewords.has(codewordKey)) {
          mismatchedCodewords.add(codewordKey);
          mismatchedCodewordsByBlock.set(
            meta.blockIndex,
            (mismatchedCodewordsByBlock.get(meta.blockIndex) ?? 0) + 1,
          );
        }
      }
    }
  }

  const worstBlockDamage = Math.max(0, ...mismatchedCodewordsByBlock.values());
  const center = (model.matrix.length - 1) / 2;
  const blockCenterRow = top + (block.height - 1) / 2;
  const blockCenterColumn = left + (block.width - 1) / 2;
  const centerDistance =
    Math.abs(blockCenterRow - center) + Math.abs(blockCenterColumn - center);

  const score =
    block.width * 4 +
    controllableCodewords.size * 12 +
    freeRemainderPixels * 4 -
    mismatchedCodewords.size * 18 -
    worstBlockDamage * 8 -
    blockCoverage.size * 6 -
    centerDistance;

  return {
    score,
    width: block.width,
    freeRemainderPixels,
    controllableCodewords: controllableCodewords.size,
    mismatchedCodewords: mismatchedCodewords.size,
    worstBlockDamage,
    blocksTouched: blockCoverage.size,
    centerDistance,
  };
}

function placementScore(model, block, top, left) {
  return measurePlacement(model, block, top, left).score;
}

function enumerateBlockPlacements(model, block, maximumCandidates = Infinity) {
  const size = model.matrix.length;
  const placements = [];

  if (block.width > size || block.height > size) return placements;
  for (let top = 0; top <= size - block.height; top += 1) {
    for (let left = 0; left <= size - block.width; left += 1) {
      if (touchesFunctionModule(model.functionMap, top, left, block)) continue;
      placements.push({
        block,
        top,
        left,
        score: placementScore(model, block, top, left),
      });
    }
  }
  placements.sort(
    (a, b) => b.score - a.score || a.top - b.top || a.left - b.left,
  );
  if (!Number.isFinite(maximumCandidates)) return placements;

  // Retain strong candidates from across the symbol so split strips are not
  // forced into the same locally favorable region.
  const buckets = Array.from({ length: 9 }, () => []);
  placements.forEach((placement) => {
    const centerRow = placement.top + placement.block.height / 2;
    const centerColumn = placement.left + placement.block.width / 2;
    const bucketRow = Math.min(2, Math.floor((centerRow * 3) / size));
    const bucketColumn = Math.min(2, Math.floor((centerColumn * 3) / size));
    buckets[bucketRow * 3 + bucketColumn].push(placement);
  });

  const selected = [];
  let bucketOffset = 0;
  while (selected.length < maximumCandidates) {
    let added = false;
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[(index + bucketOffset) % buckets.length];
      if (!bucket.length) continue;
      selected.push(bucket.shift());
      added = true;
      if (selected.length === maximumCandidates) break;
    }
    if (!added) break;
    bucketOffset = (bucketOffset + 1) % buckets.length;
  }
  return selected;
}

function finishPlacement(rectangles) {
  return {
    rectangles,
    rectangleCount: rectangles.length,
    lineCount: rectangles.reduce(
      (sum, rectangle) => sum + rectangle.block.lines.length,
      0,
    ),
    score: rectangles.reduce((sum, rectangle) => sum + rectangle.score, 0),
    targets: rectangles.flatMap(({ block, top, left }) =>
      makeTargets(block, top, left),
    ),
  };
}

function findConnectedPlacements(model, text, horizontalOnly, fontId, allowWrap) {
  const size = model.matrix.length;
  const maximumCharactersPerLine = Math.floor((size - BORDER * 2 + 1) / getFont(fontId).advance);
  const placements = [];
  const lineVariants = allowWrap
    ? makeLineVariants(text, maximumCharactersPerLine)
    : [[text]];
  for (const lines of lineVariants) {
    const block = renderTextLines(lines, fontId);
    if (horizontalOnly && block.width < block.height) continue;
    placements.push(...enumerateBlockPlacements(model, block));
  }
  return placements.map((placement) => finishPlacement([placement]));
}

function rectanglesOverlap(a, b) {
  return !(
    a.left + a.block.width <= b.left ||
    b.left + b.block.width <= a.left ||
    a.top + a.block.height <= b.top ||
    b.top + b.block.height <= a.top
  );
}

export function rectangleGap(a, b) {
  const horizontalGap = Math.max(
    0,
    b.left - (a.left + a.block.width),
    a.left - (b.left + b.block.width),
  );
  const verticalGap = Math.max(
    0,
    b.top - (a.top + a.block.height),
    a.top - (b.top + b.block.height),
  );
  return horizontalGap + verticalGap;
}

function separationBonus(rectangles, candidate) {
  if (!rectangles.length) return 0;
  const nearestGap = Math.min(
    ...rectangles.map((rectangle) => rectangleGap(rectangle, candidate)),
  );
  return Math.min(8, nearestGap) * 3;
}

function followsReadingOrder(previous, next) {
  return (
    next.top > previous.top ||
    (next.top === previous.top &&
      next.left >= previous.left + previous.block.width)
  );
}

function findSplitPlacements(model, text, horizontalOnly, fontId) {
  const results = [];
  const maximumRectangles = Math.min(4, text.length);

  for (
    let rectangleCount = 2;
    rectangleCount <= maximumRectangles;
    rectangleCount += 1
  ) {
    for (const lengths of balancedLengthVariants(text.length, rectangleCount)) {
      const chunks = splitByLengths(text, lengths);
      const candidateSets = chunks.map((chunk) => {
        const block = renderTextBlock(chunk, chunk.length, fontId);
        if (horizontalOnly && block.width < block.height) return [];
        return enumerateBlockPlacements(model, block, 60);
      });
      if (candidateSets.some((candidates) => candidates.length === 0)) continue;

      let beam = [{ rectangles: [], score: 0 }];
      for (const candidates of candidateSets) {
        const nextBeam = [];
        for (const state of beam) {
          for (const candidate of candidates) {
            const previous = state.rectangles.at(-1);
            if (previous && !followsReadingOrder(previous, candidate)) continue;
            if (
              state.rectangles.some((rectangle) =>
                rectanglesOverlap(rectangle, candidate),
              )
            ) {
              continue;
            }
            nextBeam.push({
              rectangles: [...state.rectangles, candidate],
              score:
                state.score +
                candidate.score +
                separationBonus(state.rectangles, candidate),
            });
          }
        }
        nextBeam.sort((a, b) => b.score - a.score);
        beam = nextBeam.slice(0, 80);
        if (!beam.length) break;
      }
      results.push(...beam.map((state) => finishPlacement(state.rectangles)));
    }
  }
  return results;
}

function sortPlacements(placements) {
  placements.sort(
    (a, b) =>
      b.score - a.score ||
      a.rectangleCount - b.rectangleCount ||
      a.lineCount - b.lineCount,
  );
  return placements;
}

function placementLayoutKey(placement) {
  return placement.rectangles
    .map(({ block }) => block.lines.map((line) => line.length).join(","))
    .join("|");
}

function placementRegionKey(placement, size) {
  const rectangle = placement.rectangles[0];
  const centerRow = rectangle.top + rectangle.block.height / 2;
  const centerColumn = rectangle.left + rectangle.block.width / 2;
  const row = Math.min(2, Math.floor((centerRow * 3) / size));
  const column = Math.min(2, Math.floor((centerColumn * 3) / size));
  return `${row}:${column}`;
}

function prioritizeDiversePlacements(placements, size) {
  const ordered = [];
  const selected = new Set();
  const add = (placement) => {
    if (selected.has(placement)) return;
    selected.add(placement);
    ordered.push(placement);
  };

  placements.slice(0, 8).forEach(add);
  const groups = new Map();
  placements.forEach((placement) => {
    const key = `${placementLayoutKey(placement)}@${placementRegionKey(placement, size)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(placement);
  });
  const queues = [...groups.values()].sort((a, b) => b[0].score - a[0].score);

  let depth = 0;
  while (ordered.length < placements.length) {
    let added = false;
    for (const queue of queues) {
      if (depth >= queue.length) continue;
      add(queue[depth]);
      added = true;
    }
    if (!added) break;
    depth += 1;
  }
  return ordered;
}

export function findTextPlacements(
  model,
  text,
  maximumCandidates = 24,
  allowSplit = false,
  horizontalOnly = false,
  fontId = DEFAULT_FONT_ID,
  allowWrap = true,
) {
  getFont(fontId).validateText(text);
  const connected = sortPlacements(
    findConnectedPlacements(model, text, horizontalOnly, fontId, allowWrap),
  );
  const prioritizedConnected = prioritizeDiversePlacements(
    connected,
    model.matrix.length,
  );
  if (!allowSplit) return prioritizedConnected.slice(0, maximumCandidates);

  const split = sortPlacements(
    findSplitPlacements(model, text, horizontalOnly, fontId),
  );
  const prioritizedSplit = prioritizeDiversePlacements(
    split,
    model.matrix.length,
  );
  const connectedLimit = Math.ceil(maximumCandidates / 2);
  const splitLimit = maximumCandidates - connectedLimit;
  const selectedConnected = prioritizedConnected.slice(0, connectedLimit);
  const selectedSplit = prioritizedSplit.slice(0, splitLimit);
  const combined = [];
  const length = Math.max(selectedConnected.length, selectedSplit.length);
  for (let index = 0; index < length; index += 1) {
    if (selectedConnected[index]) combined.push(selectedConnected[index]);
    if (selectedSplit[index]) combined.push(selectedSplit[index]);
  }
  return combined;
}
