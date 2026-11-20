import { analyzeDamage, applyChanges, getMetadataRegions } from "./qr-engine.js";

export function applyImageConstraints(model, targets, allowApproximation = false) {
  const size = model.matrix.length;
  const edited = applyChanges(model.matrix, targets);
  const images = new Map();
  for (const target of targets) {
    if (target.imageId === undefined) continue;
    if (!images.has(target.imageId)) images.set(target.imageId, { imageId: target.imageId, total: 0, omitted: 0 });
    images.get(target.imageId).total += 1;
  }
  const omitted = new Set();
  if (allowApproximation && images.size) {
    const damage = analyzeDamage(model, edited);
    const counts = damage.blockStats.map((block) => block.totalDamaged);
    const limits = damage.blockStats.map((block) => block.theoreticalLimit);
    const metadataRegion = new Map();
    getMetadataRegions(model.version).forEach(({ positions }, index) => {
      const region = counts.length;
      counts.push(damage.metadataStats[index].damagedBits);
      limits.push(damage.metadataStats[index].theoreticalLimit);
      for (const [row, column] of positions) metadataRegion.set(row * size + column, region);
    });
    const groups = new Map();
    for (const target of targets) {
      const { row, column } = target;
      if (target.value === model.matrix[row][column]) continue;
      const meta = model.metadata[row][column];
      const position = row * size + column;
      const data = meta.kind === "data" || meta.kind === "ecc";
      const region = data ? meta.blockIndex : metadataRegion.get(position);
      if (region === undefined) continue;
      const key = data ? `${meta.kind}:${meta.blockIndex}:${meta.blockCodewordIndex}` : `metadata:${position}`;
      if (!groups.has(key)) groups.set(key, { key, region, hard: false, targets: [], costs: new Map() });
      const group = groups.get(key);
      if (target.imageId === undefined) group.hard = true;
      else {
        group.targets.push(target);
        group.costs.set(target.imageId, (group.costs.get(target.imageId) ?? 0) + 1);
      }
    }
    let candidates = [...groups.values()].filter((group) => !group.hard);
    // Restore whole codewords, not individual bits: partial repairs still cost ECC.
    while (candidates.length) {
      candidates = candidates.filter((group) => [...group.costs].every(([id, cost]) => {
        const image = images.get(id);
        return image.omitted + cost <= image.total - Math.ceil(image.total * 4 / 5);
      }));
      if (!candidates.length) break;
      candidates.sort((a, b) =>
        counts[b.region] / limits[b.region] - counts[a.region] / limits[a.region] ||
        a.targets.length - b.targets.length || a.key.localeCompare(b.key),
      );
      const group = candidates.shift();
      for (const target of group.targets) {
        omitted.add(target.row * size + target.column);
        edited[target.row][target.column] = model.matrix[target.row][target.column];
      }
      for (const [id, cost] of group.costs) images.get(id).omitted += cost;
      counts[group.region] -= 1;
    }
  }
  return {
    edited,
    appliedTargets: targets.filter(({ row, column }) => !omitted.has(row * size + column)),
    imageStats: [...images.values()].map(({ imageId, total, omitted: count }) => ({
      imageId, total, matched: total - count, minimum: allowApproximation ? Math.ceil(total * 4 / 5) : total,
    })),
  };
}
