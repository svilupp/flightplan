/** Test-only expectations: never import this module into candidate packet construction. */
import type { JevRoute } from "./jev.ts";
export interface JevOracle {
  target: string | null;
  result: string;
  dispatches: number;
}
export function jevOracle(route: JevRoute, variant = "default"): JevOracle {
  const blocked =
    (route === "absent" && variant !== "present") ||
    route === "actionability" ||
    (route === "icons" && variant === "disabled") ||
    (route === "duplicates" && variant === "identical") ||
    (route === "drift" && variant === "e") ||
    route === "redaction";
  const target = blocked ? null : route === "duplicates" || route === "context" ? "q2" : "q1";
  return { target, result: target ? `selected:${target}` : "", dispatches: target ? 1 : 0 };
}
