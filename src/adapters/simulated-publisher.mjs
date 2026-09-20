export function createSimulatedPublisher({ delayMs = 5 } = {}) {
  const operations = new Map();
  return { operations, async publish(task) {
    const operationId = `sim-${task.task_id}`;
    if (operations.has(operationId)) return operations.get(operationId);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const result = { ok: true, operation_id: operationId, status: "confirmed", simulated: true };
    operations.set(operationId, result);
    return result;
  } };
}
