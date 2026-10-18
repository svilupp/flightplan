/** Verify the owner receipt before reporting continuity or admitting a resumed controller. */
export function confirmsOwnerHandback(
  receipt: unknown,
  ownerEpoch: string,
  targetId: string,
): boolean {
  if (!receipt || typeof receipt !== "object") return false;
  const value = receipt as Record<string, unknown>;
  return (
    value.confirmed === true &&
    value.ownerEpoch === ownerEpoch &&
    value.targetId === targetId &&
    value.refsInvalidated === true &&
    value.pendingActions === "drained" &&
    typeof value.observationEpoch === "string" &&
    value.observationEpoch.length > 0 &&
    typeof value.bindingRevision === "number" &&
    Number.isSafeInteger(value.bindingRevision) &&
    value.bindingRevision >= 0
  );
}
