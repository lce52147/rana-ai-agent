export function validIdentityBox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [x, y, width, height] = bbox.map(Number);
  return [x, y, width, height].every(Number.isFinite)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x < 1 && y < 1 && x + width <= 1.000001 && y + height <= 1.000001;
}

export function identityLikeTarget(target) {
  return /^(?:person|character|screen_character|plush|figure)$/iu.test(String(target?.type || "").trim());
}

export function shouldUseIdentityFallbackTargets(targets = []) {
  if (!Array.isArray(targets) || targets.length === 0) return true;
  if (targets.length !== 1) return false;
  const bbox = targets[0]?.bbox;
  if (!validIdentityBox(bbox)) return false;
  const [x, y, width, height] = bbox.map(Number);
  return x <= 0.03 && y <= 0.03 && width >= 0.94 && height >= 0.94;
}

export function identityTargetMultiViewTargets(target) {
  if (!target || !validIdentityBox(target.bbox)) return [];
  const [x, y, width, height] = target.bbox.map(Number);
  const stableFeatures = Array.isArray(target.stable_features) ? target.stable_features : [];
  const visibility = Number.isFinite(Number(target.visibility))
    ? Math.max(0, Math.min(1, Number(target.visibility)))
    : 1;
  const within = (left, top, boxWidth, boxHeight) => [
    x + (width * left),
    y + (height * top),
    width * boxWidth,
    height * boxHeight,
  ];
  return [
    {
      target_id: "F1",
      source_target_id: target.target_id,
      type: "target_face",
      bbox: within(0.18, 0, 0.64, 0.68),
      foreground: true,
      visibility,
      stable_features: stableFeatures,
    },
    {
      target_id: "F2",
      source_target_id: target.target_id,
      type: "target_upper",
      bbox: within(0.08, 0, 0.84, 0.90),
      foreground: true,
      visibility: Math.max(0, visibility * 0.96),
      stable_features: stableFeatures,
    },
    {
      target_id: "F3",
      source_target_id: target.target_id,
      type: "target_full",
      bbox: [x, y, width, height],
      foreground: true,
      visibility: Math.max(0, visibility * 0.92),
      stable_features: stableFeatures,
    },
  ];
}
