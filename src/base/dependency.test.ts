import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const sourceRoot = join(process.cwd(), 'src');

function typescriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...typescriptFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

function importsFrom(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

describe('module dependency direction', () => {
  it('does not let Base depend on the upper SDK', () => {
    const violations = typescriptFiles(join(sourceRoot, 'base')).flatMap((file) =>
      importsFrom(file)
        .filter((specifier) => specifier.includes('/sdk/'))
        .map((specifier) => `${relative(sourceRoot, file)} -> ${specifier}`));
    expect(violations).toEqual([]);
  });

  it('does not let protocol implementations depend on Base or the upper SDK', () => {
    const protocolRoots = ['desktop', 'http', 'passport', 'services', 'store'];
    const violations = protocolRoots.flatMap((directory) =>
      typescriptFiles(join(sourceRoot, directory)).flatMap((file) =>
        importsFrom(file)
          .filter((specifier) => specifier.includes('/base/') || specifier.includes('/sdk/'))
          .map((specifier) => `${relative(sourceRoot, file)} -> ${specifier}`)));
    expect(violations).toEqual([]);
  });
});
