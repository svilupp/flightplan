// Pure, portable posix-style path helpers used on the run path (no `node:path`, no ambient
// cwd). Behavior is intended to match `node:path`'s posix mode for the shapes flightplan uses
// (relative segment joining/resolution, dirname, absolute-path detection); see
// `paths.test.ts` for the parity assertions against `node:path`.
//
// `isAbsolute` additionally recognizes Windows drive-letter absolutes (`C:\...`, `C:/...`) so
// callers on Windows-authored paths behave sanely, even though the rest of this module treats
// `/` as the only separator once normalized.

/** Convert backslashes to forward slashes, matching the existing normalization in glob code. */
export function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[/\\]/;

/** True iff `path` is an absolute POSIX path (`/...`) or a Windows drive-letter absolute. */
export function isAbsolute(path: string): boolean {
  if (WINDOWS_DRIVE_ABSOLUTE.test(path)) return true;
  return path.startsWith("/");
}

/** The parent directory of `path` (posix semantics; mirrors `node:path.dirname`). */
export function dirname(path: string): string {
  const normalized = normalize(path);
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return trimmed.slice(0, slash);
}

/** Join path segments with `/`, then normalize the result (mirrors `node:path.join`). */
export function join(...segments: string[]): string {
  if (segments.length === 0) return ".";
  const joined = segments.map((s) => normalize(s)).join("/");
  return normalizeSlashes(joined) || ".";
}

/** Collapse `.`/`..`/duplicate-slash segments, preserving leading absoluteness. */
function normalizeSlashes(path: string): string {
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter((part) => part.length > 0);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joinedOut = out.join("/");
  return absolute ? `/${joinedOut}` : joinedOut;
}

/**
 * Resolve `parts` against a **required** explicit `base` (no implicit `process.cwd()`).
 * With an absolute base, mirrors `node:path.resolve(base, ...parts)` for posix inputs.
 * Relative bases stay relative unless a later part is absolute. The filesystem adapter
 * owns cwd resolution; inventing a leading slash would redirect imports to the host root.
 */
export function resolve(base: string, ...parts: string[]): string {
  let result = normalize(base);
  for (const part of parts) {
    const normalized = normalize(part);
    if (isAbsolute(normalized) || result === "") {
      result = normalized;
    } else {
      result = result.endsWith("/") ? `${result}${normalized}` : `${result}/${normalized}`;
    }
  }
  if (WINDOWS_DRIVE_ABSOLUTE.test(result)) return result;
  const normalized = normalizeSlashes(result);
  return normalized === "" ? "." : normalized;
}
