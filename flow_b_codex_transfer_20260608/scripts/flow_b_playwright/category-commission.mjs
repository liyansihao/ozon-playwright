function rubleBounds(label) {
  return [...String(label || "").matchAll(/([0-9][0-9,]*\.?[0-9]*)\s*₽/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter(Number.isFinite);
}

function selectTier(children, saleRub) {
  for (const child of children || []) {
    const label = String(child.label || "");
    const bounds = rubleBounds(label);
    if (label.includes("≤") && bounds.length === 1 && saleRub <= bounds[0]) return child;
    if (label.includes(">") && !label.includes("≤") && bounds.length === 1 && saleRub > bounds[0]) return child;
    if (bounds.length >= 2 && saleRub > bounds[0] && saleRub <= bounds[1]) return child;
  }
  return (children || [])[0] || null;
}

export function mapOzonCategory(cate, commissionTree, sellCny, cnyRubRate = 10.4672) {
  const raw = Array.isArray(cate) ? cate.filter((value) => value !== undefined && value !== null) : [];
  const top = (commissionTree || []).find((row) => String(row.cate_id ?? row.value) === String(raw[0]));
  const second = top?.children?.find((row) => String(row.cate_id ?? row.value) === String(raw[1]));
  if (!top || !second) return { mapped: raw, labels: [] };
  const saleRub = Number(sellCny) * Number(cnyRubRate);
  const tier = Number.isFinite(saleRub) && saleRub > 0 ? selectTier(second.children, saleRub) : second.children?.[0];
  return {
    mapped: [top.cate_id ?? raw[0], second.cate_id ?? raw[1], tier?.value ?? raw[2]].filter((value) => value !== undefined && value !== null),
    labels: [top.label, second.label, tier?.label].filter(Boolean),
  };
}
