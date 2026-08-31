import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface FileFingerprint {
  readonly exists: boolean;
  readonly size?: string;
  readonly modified?: string;
  readonly changed?: string;
  readonly inode?: string;
}

interface FamilyFingerprint {
  readonly database: FileFingerprint;
  readonly wal: FileFingerprint;
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  try {
    const metadata = await stat(path, { bigint: true });
    return {
      exists: true,
      size: metadata.size.toString(),
      modified: metadata.mtimeNs.toString(),
      changed: metadata.ctimeNs.toString(),
      inode: metadata.ino.toString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

async function familyFingerprint(databasePath: string): Promise<FamilyFingerprint> {
  const [database, wal] = await Promise.all([
    fingerprint(databasePath),
    fingerprint(`${databasePath}-wal`),
  ]);
  return { database, wal };
}

function sameFingerprint(left: FamilyFingerprint, right: FamilyFingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function withDatabaseSnapshot<T>(
  databasePath: string,
  inspect: (snapshotPath: string | undefined) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await familyFingerprint(databasePath);
    if (!before.database.exists) {
      const after = await familyFingerprint(databasePath);
      if (sameFingerprint(before, after)) {
        return inspect(undefined);
      }
      continue;
    }

    const snapshotDirectory = await mkdtemp(join(tmpdir(), "awacode-db-snapshot-"));
    const snapshotPath = join(snapshotDirectory, "awacode.db");
    try {
      await copyFile(databasePath, snapshotPath);
      if (before.wal.exists) {
        await copyFile(`${databasePath}-wal`, `${snapshotPath}-wal`);
      }
      const after = await familyFingerprint(databasePath);
      if (!sameFingerprint(before, after)) {
        continue;
      }
      return inspect(snapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    } finally {
      await rm(snapshotDirectory, { recursive: true, force: true });
    }
  }
  throw new Error(`database changed while taking classification snapshot: ${databasePath}`);
}
