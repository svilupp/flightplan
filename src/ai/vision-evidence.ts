import type { Driver } from "../driver/types.ts";
import type { Redactor } from "../redaction/index.ts";

export interface JevVisualEvidence {
  captureId: string;
  url: string;
  frameId: string;
  signature: string;
  observedAtMs: number;
  image: { format: "png" | "jpeg"; data_base64: string; width: number; height: number };
  geometry: Record<string, { x: number; y: number; width: number; height: number }>;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; dpr: number };
  pixelsSafe: boolean;
}

/** Validate proof supplied by the capture adapter; never assume independent screenshot/snapshot atomicity. */
export function validateVisualEvidence(
  e: JevVisualEvidence,
  refs: string[],
  now = Date.now(),
): void {
  if (!e.pixelsSafe) throw new Error("jev_pixels_unsafe");
  if (
    !e.captureId ||
    !e.frameId ||
    !e.signature ||
    now - e.observedAtMs > 1000 ||
    e.observedAtMs > now + 100
  )
    throw new Error("jev_snapshot_stale");
  const { image, viewport } = e;
  if (
    ![image.width, image.height, viewport.width, viewport.height, viewport.dpr].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    ![viewport.scrollX, viewport.scrollY].every(Number.isFinite) ||
    Math.abs(image.width / viewport.width - viewport.dpr) > 0.01 ||
    Math.abs(image.height / viewport.height - viewport.dpr) > 0.01
  )
    throw new Error("jev_transform_unknown");
  if (
    image.width < 280 ||
    image.height < 280 ||
    image.width > 1568 ||
    image.height > 1568 ||
    image.width * image.height > 2_458_624 ||
    image.data_base64.length > 8_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data_base64)
  )
    throw new Error("jev_result_invalid");
  for (const ref of refs) {
    const r = e.geometry[ref];
    if (
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x < 0 ||
      r.y < 0 ||
      r.x + r.width > viewport.width ||
      r.y + r.height > viewport.height
    )
      throw new Error("jev_transform_unknown");
  }
}
export async function captureVisualEvidence(
  driver: Driver,
  refs: string[],
  redactor?: Redactor,
): Promise<JevVisualEvidence> {
  if (!driver.captureJevEvidence)
    throw new Error("jev_transform_unknown: driver lacks verified capture");
  const evidence = await driver.captureJevEvidence({ refs, ...(redactor ? { redactor } : {}) });
  validateVisualEvidence(evidence, refs);
  return evidence;
}
