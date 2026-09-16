import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** True when this module was run directly (`node src/index.ts`), tolerating
 *  relative argv and Windows drive-letter casing. */
export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return importMetaUrl === pathToFileURL(resolve(argvPath)).href;
  } catch {
    return false;
  }
}
