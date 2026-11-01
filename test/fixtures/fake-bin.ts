import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Puts an executable named `name` in the directory that runs the fixture
 * script under the Bun that runs the tests, whatever PATH holds.
 */
export function installFake(
  binDirectory: string,
  name: string,
  fixture: string,
): void {
  const path = join(binDirectory, name);

  writeFileSync(
    path,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, fixture)}' "$@"\n`,
  );
  chmodSync(path, 0o755);
}
