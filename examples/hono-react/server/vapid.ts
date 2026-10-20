import { readFile, writeFile } from "node:fs/promises";
import { generateVapidKeys, type VapidKeys } from "easy-ping/providers/web-push";

/**
 * VAPID keys from the environment, or generated on first start and kept in a gitignored file.
 * Never regenerate them: a new pair silently invalidates every browser subscription.
 */
export async function loadVapidKeys(file: string): Promise<VapidKeys> {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  if (publicKey && privateKey) return { publicKey, privateKey };

  try {
    return JSON.parse(await readFile(file, "utf8")) as VapidKeys;
  } catch {
    const keys = await generateVapidKeys();
    try {
      // "wx" fails if another process got there first; then theirs is the pair to use.
      await writeFile(file, JSON.stringify(keys, null, 2), { flag: "wx" });
      return keys;
    } catch {
      return JSON.parse(await readFile(file, "utf8")) as VapidKeys;
    }
  }
}
