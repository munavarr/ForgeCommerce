// Read-only source/dependency/provenance checks. Findings contain locations, never matched values.
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const app = path.resolve(__dirname, '..'), root = path.dirname(app);
const manifest = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8'));
const declared = { ...manifest.dependencies, ...manifest.devDependencies };
const errors = [], external = new Set(), dynamic = [];
const skipped = new Set(['node_modules', 'dist', '.git', '.agents', '.codex', '.aws']);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) { errors.push({ file: path.relative(root, file), kind: 'source symlink requires review' }); return []; }
    return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
  });
}
let edges = 0;
const sources = ['src', 'test', 'scripts'].flatMap(dir => walk(path.join(app, dir))).filter(file => /\.(ts|js)$/.test(file));
for (const file of sources) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
    const loader = ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'require' && node.expression.name.text === 'resolve'));
    if (loader) {
      if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) spec = node.arguments[0].text;
      else dynamic.push({ file: path.relative(app, file), line: source.getLineAndCharacterOfPosition(node.pos).line + 1 });
    }
    if (spec) {
      edges++;
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(app + path.sep) || ![resolved, resolved + '.ts', resolved + '.js', path.join(resolved, 'index.js'), path.join(resolved, 'index.ts')].some(fs.existsSync))
          errors.push({ file: path.relative(app, file), kind: 'missing or escaping relative import' });
      } else if (!isBuiltin(spec)) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        external.add(name);
        if (!declared[name] || name.startsWith('@vendure/')) errors.push({ file: path.relative(app, file), kind: 'undeclared or upstream import' });
        try {
          if (!fs.realpathSync(require.resolve(spec, { paths: [path.dirname(file)] })).startsWith(path.join(app, 'node_modules') + path.sep))
            errors.push({ file: path.relative(app, file), kind: 'dependency resolved outside application' });
        } catch { errors.push({ file: path.relative(app, file), kind: 'unresolved dependency' }); }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const field of ['dependencies', 'devDependencies', 'engines']) if (JSON.stringify(manifest[field]) !== JSON.stringify(lock.packages[''][field])) errors.push({ kind: 'manifest/lock mismatch', field });
for (const [name, version] of Object.entries(declared)) if (lock.packages['node_modules/' + name]?.version !== version) errors.push({ kind: 'direct version mismatch', name });
for (const [name, entry] of Object.entries(lock.packages)) if (entry.link || (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) || name.includes('@vendure/')) errors.push({ kind: 'unexpected lock resolution', name });
for (const [name, command] of Object.entries(manifest.scripts)) if (/\b(?:lerna|bunx?|vendure)\b|\.\.\//.test(command)) errors.push({ kind: 'workspace or parent script', name });
const config = JSON.parse(fs.readFileSync(path.join(app, 'tsconfig.json'), 'utf8'));
if (config.extends || config.references || config.compilerOptions.paths) errors.push({ kind: 'external TypeScript configuration' });
for (const name of ['pg', '@nestjs/platform-express']) if (!manifest.dependencies[name]) errors.push({ kind: 'missing runtime driver', name });
const options = fs.readFileSync(path.join(app, 'src/database/options.ts'), 'utf8');
if (!/synchronize:\s*false/.test(options) || !/migrationsRun:\s*false/.test(options)) errors.push({ kind: 'unsafe schema startup options' });

const patterns = {
  'Google API credential': /AIza[0-9A-Za-z_-]{30,}/g,
  'AWS access ID': /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  'GitHub token': /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
  'Stripe credential': /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  'private key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  'credential URL': /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/[^\s/:]+:[^\s/@]+@/g,
};
const files = walk(root);
for (const file of files) {
  const relative = path.relative(root, file);
  if ((path.basename(file).startsWith('.env') && path.basename(file) !== '.env.example') ||
      /\.(pem|key|p12|pfx|jks|keystore|dump|backup|bak|db|sqlite3?|sql|tar|gz|tgz|zip)$/i.test(file) ||
      relative.split(path.sep).some(part => /^(backup|backups|mnv-commerce-backups|postgres-data|\.pgdata)$/.test(part))) {
    errors.push({ file: relative, kind: 'sensitive artifact' }); continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  for (const [kind, pattern] of Object.entries(patterns)) {
    for (const match of content.matchAll(pattern)) errors.push({ file: relative, line: content.slice(0, match.index).split('\n').length, kind });
  }
  if (file.startsWith(path.join(app, 'src') + path.sep) && /https?:\/\//.test(content)) errors.push({ file: relative, kind: 'runtime endpoint requires review' });
  if (file.startsWith(path.join(app, 'src') + path.sep) && /opentelemetry|posthog|segment\.com|sentry\.io|google-analytics|amplitude\.com/i.test(content)) errors.push({ file: relative, kind: 'telemetry requires review' });
}
for (const line of fs.readFileSync(path.join(app, '.env.example'), 'utf8').split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const [key, ...parts] = line.split('='), value = parts.join('=');
  if (/PASSWORD|TOKEN|SECRET|KEY/i.test(key) && value && !/replace|placeholder|change|^</i.test(value)) errors.push({ kind: 'non-placeholder example environment' });
}
const phase6 = JSON.parse(fs.readFileSync(path.join(app, 'cleanup/verification.json'), 'utf8'));
const preserved = JSON.parse(fs.readFileSync(path.join(app, 'cleanup/preserved-before.json'), 'utf8'));
for (const [name, expected] of Object.entries(preserved.legal)) {
  if (createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') !== expected) errors.push({ kind: 'original legal text changed', name });
}
for (const [name, expected] of Object.entries(phase6.migrationSha256)) {
  const actual = createHash('sha256').update(fs.readFileSync(path.join(app, 'src/database/migrations', name))).digest('hex');
  if (actual !== expected) errors.push({ kind: 'applied migration changed', name });
}
const deletions = JSON.parse(fs.readFileSync(path.join(app, 'cleanup/deletions.json'), 'utf8'));
for (const entry of deletions.files) {
  const file = path.resolve(root, entry.path);
  if (!file.startsWith(root + path.sep)) throw Error('Invalid historical evidence path');
  if (fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === entry.sha256) errors.push({ kind: 'original deleted file remains', file: entry.path });
}
console.log(JSON.stringify({ sourceFiles: sources.length, imports: edges, externalImports: [...external].sort(),
  runtimeDependencies: Object.keys(manifest.dependencies).length, developmentDependencies: Object.keys(manifest.devDependencies).length,
  lockEntries: Object.keys(lock.packages).length, scannedRetainedFiles: files.length,
  migrationHashesMatchPhase6: !errors.some(e => e.kind === 'applied migration changed'), deletionEntriesChecked: deletions.files.length,
  originalLegalFilesChecked: Object.keys(preserved.legal).length,
  dynamicImportsForManualReview: dynamic, errors }, null, 2));
if (errors.length) process.exitCode = 1;
