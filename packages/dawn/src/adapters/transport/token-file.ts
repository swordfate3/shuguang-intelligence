import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

export function assertServiceToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error("Invalid service token");
}

/** Explicit private local credential only. Never search Pi/model credentials. */
export function readTokenFile(path: string): string {
  if (!isAbsolute(path)) throw new Error("Absolute token file path required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 43 || stat.size > 129 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Token must be a private regular file owned by the current user");
    }
    const content = readFileSync(fd, "utf8");
    const token = content.endsWith("\n") ? content.slice(0, -1) : content;
    assertServiceToken(token);
    return token;
  } finally { closeSync(fd); }
}

/** Explicit command only; parent directory must already be private/trusted. Never print token. */
export function createTokenFile(path: string): void {
  if (!isAbsolute(path)) throw new Error("Absolute token file path required");
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${randomBytes(32).toString("base64url")}\n`, "utf8");
  } catch (error) {
    closeSync(fd);
    // The exclusive file belongs to this operation; do not remove existing credentials.
    unlinkSync(path);
    throw error;
  }
  closeSync(fd);
}
