import { randomBytes } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';

/** Replace only GH_TOKEN, keeping the rest of an existing .env intact. */
export async function saveTokenToEnv(token: string, targetEnvPath: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(token)) {
    throw new Error('GitHub returned a token format that cannot safely be written to a shell .env file.');
  }

  let existing = '';
  try {
    const details = await lstat(targetEnvPath);
    if (!details.isFile()) throw new Error('The .env must be a regular file, not a symlink or directory.');
    existing = await readFile(targetEnvPath, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const lines = existing ? existing.split(/\r?\n/) : [];
  const output: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*(?:export\s+)?GH_TOKEN\s*=/.test(line)) {
      if (!replaced) output.push(`GH_TOKEN=${token}`);
      replaced = true;
    } else {
      output.push(line);
    }
  }

  let contents;
  if (replaced) {
    contents = output.join('\n');
    if (!contents.endsWith('\n')) contents += '\n';
  } else {
    contents = existing;
    if (contents && !contents.endsWith('\n')) contents += '\n';
    if (contents && !contents.endsWith('\n\n')) contents += '\n';
    contents += `# GitHub App installation token; expires after one hour.\nGH_TOKEN=${token}\n`;
  }

  const tempPath = `${targetEnvPath}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tempPath, contents, { flag: 'wx', mode: 0o600 });
    await rename(tempPath, targetEnvPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return targetEnvPath;
}
