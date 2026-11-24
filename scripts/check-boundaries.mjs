import { builtinModules } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const allowed = {
  core: [],
  ports: ['core'],
  formats: ['core'],
  application: ['core', 'ports', 'formats'],
  ui: ['application', 'core', 'formats'],
  platform: ['core', 'ports', 'application', 'formats', 'ui'],
  server: ['core', 'ports'],
};
const pure = new Set(['core', 'ports', 'formats', 'application']);
const platformPackages = new Set(['react', 'react-dom', 'electron', 'better-sqlite3', 'express']);

export function boundaryError(from, target, specifier) {
  const owner = from.split('/')[0];
  if (!(owner in allowed)) return `Неизвестный модуль: ${from}`;
  if (target === null) {
    const packageName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (
      pure.has(owner) &&
      (specifier.startsWith('node:') ||
        builtinModules.includes(specifier) ||
        platformPackages.has(packageName))
    )
      return `Платформенная зависимость ${specifier} в ${owner}`;
    if (
      owner === 'ui' &&
      (specifier.startsWith('node:') ||
        builtinModules.includes(specifier) ||
        ['electron', 'better-sqlite3', 'express'].includes(packageName))
    ) {
      return `Платформенная зависимость ${specifier} в UI`;
    }
    return null;
  }
  const dependency = target.split('/')[0];
  if (owner === dependency) return null;
  if (!allowed[owner].includes(dependency)) return `${owner} не может зависеть от ${dependency}`;
  if (target !== `${dependency}/index.ts`) return `Обход публичной точки входа: ${target}`;
  return null;
}

export function sourceImports(text, fileName) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      imports.push(expression && ts.isStringLiteral(expression) ? expression.text : null);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0];
      imports.push(arg && ts.isStringLiteral(arg) ? arg.text : null);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

export function checkBoundaries(root = process.cwd()) {
  const src = resolve(root, 'src');
  const normalize = (path) => relative(src, path).split(sep).join('/');
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowArbitraryExtensions: true,
  };
  const errors = [];
  for (const file of walk(src)) {
    for (const specifier of sourceImports(readFileSync(file, 'utf8'), file)) {
      if (specifier === null) {
        errors.push(`${normalize(file)}: вычисляемый импорт запрещён`);
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      const internal = resolved && !resolved.isExternalLibraryImport;
      // CSS принадлежит тому же модулю; остальные неразрешённые локальные импорты — ошибка.
      let target = internal ? normalize(resolved.resolvedFileName) : null;
      if (!resolved && specifier.startsWith('.')) {
        if (specifier.endsWith('.css')) target = normalize(resolve(dirname(file), specifier));
        else {
          errors.push(`${normalize(file)}: не разрешён ${specifier}`);
          continue;
        }
      }
      const error = boundaryError(normalize(file), target, specifier);
      if (error) errors.push(`${normalize(file)}: ${error}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Границы модулей: OK');
}
