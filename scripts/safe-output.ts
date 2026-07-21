import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export type SafeOutputOptions = {
  projectRoot: string;
  allowedRoots: string[];
  kind: "file" | "directory";
  outsideCode: string;
};

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function assertNoSymlinkComponents(root: string, destination: string): Promise<void> {
  const relativePath = relative(root, destination);
  const components = relativePath === "" ? [] : relativePath.split(sep);
  let current = root;
  for (const component of ["", ...components]) {
    if (component) current = resolve(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error("output_path_contains_symlink");
      if (current !== destination && !metadata.isDirectory()) {
        throw new Error("output_parent_is_not_directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function assertSafeOutputPath(
  path: string,
  options: SafeOutputOptions,
): Promise<string> {
  const projectRoot = resolve(options.projectRoot);
  const destination = resolve(path);
  const legacyRoot = resolve(projectRoot, "legacy");
  if (isWithin(destination, legacyRoot)) throw new Error("output_inside_legacy_root");

  const roots = options.allowedRoots
    .map((root) => resolve(projectRoot, root))
    .sort((left, right) => right.length - left.length);
  const allowedRoot = roots.find((root) => isWithin(destination, root));
  if (!allowedRoot) throw new Error(options.outsideCode);
  await assertNoSymlinkComponents(projectRoot, destination);

  try {
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink()) throw new Error("output_path_contains_symlink");
    if (options.kind === "file" && !metadata.isFile()) throw new Error("output_path_is_not_file");
    if (options.kind === "directory" && !metadata.isDirectory()) {
      throw new Error("output_path_is_not_directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}

export async function writeSafeOutputFile(
  path: string,
  contents: string | Uint8Array,
  options: Omit<SafeOutputOptions, "kind">,
): Promise<void> {
  const destination = await assertSafeOutputPath(path, { ...options, kind: "file" });
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.temporary`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
