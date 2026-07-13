export async function runReadOnlyVerification({
  client,
  extensionVersion,
  storeNeedle = "丽丽1号",
  watermarkNeedle = "lysh",
} = {}) {
  if (!client || typeof client.getFavoritePage !== "function" || typeof client.resolvePublishTarget !== "function") {
    throw new TypeError("read-only Maozi client is required");
  }
  const favoritePage = await client.getFavoritePage({ page: 1, pageSize: 1, isImported: 0 });
  const target = await client.resolvePublishTarget({ storeNeedle, watermarkNeedle });
  return {
    authenticated: true,
    extensionVersion: String(extensionVersion || "unknown"),
    favoriteCount: favoritePage.total,
    favoritePageRows: favoritePage.rows.length,
    store: { id: target.store.id, name: target.store.name ?? target.store.title },
    watermark: { id: target.watermark.id, name: target.watermark.name ?? target.watermark.title },
  };
}
