/**
 * Runs `fn` over `items` with at most `limit` calls in flight and keeps the result order.
 * Workers pull from a shared cursor, so one slow item doesn't idle the rest.
 * Rejects as soon as any call does.
 */
export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};
