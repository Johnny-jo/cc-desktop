import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const MAX_ENTRIES = 60_000;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const configName = /^(?:(?:ts|js)config(?:\.[^.]+)*|package)\.json$/i;
const ignoredDirectories = new Set([
  "node_modules", "bower_components", "vendor", "dist", "dist-electron", "out", "build",
  "release", "coverage", "target", "tmp", "temp", "cache", "__pycache__", "venv",
  "test-results", "playwright-report", "storybook-static",
]);

const caseSensitive = process.platform !== "win32";
function key(file: string) {
  const absolute = path.resolve(file);
  return caseSensitive ? absolute : absolute.toLowerCase();
}

function readProjectFile(file: string, remainingBytes: number, reasons: Set<string>) {
  try {
    if (key(realpathSync.native(file)) !== key(file)) return;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const fd = openSync(file, flags);
    try {
      const opened = fstatSync(fd);
      const current = lstatSync(file);
      if (!current.isFile() || current.ino !== opened.ino || current.dev !== opened.dev || key(realpathSync.native(file)) !== key(file)) return;
      if (opened.size > MAX_FILE_BYTES) {
        reasons.add("Files larger than 1 MiB were skipped.");
        return;
      }
      if (opened.size > remainingBytes) {
        reasons.add("16 MiB source and configuration budget reached.");
        return "budget";
      }
      const buffer = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (offset !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        reasons.add("Files modified during indexing were skipped.");
        return;
      }
      return { size: opened.size, content: buffer.toString("utf8").replace(/^\uFEFF/, "") };
    } finally {
      closeSync(fd);
    }
  } catch {
    reasons.add("Some project files could not be read.");
    return;
  }
}

// Snapshot regular files once. The compiler and module/config resolution subsequently
// have access only to this map, including for absolute paths and triple-slash references.
function snapshot(root: string) {
  const files = new Map<string, { file: string; content: string }>();
  const sources: string[] = [];
  const directories = new Set<string>();
  const reasons = new Set<string>();
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  let exhausted = false;
  for (let i = 0; i < pending.length && !exhausted; i++) {
    const dir = pending[i];
    try {
      if (key(realpathSync.native(dir)) !== key(dir)) {
        if (i === 0) reasons.add("The bound project root changed before indexing.");
        continue;
      }
      const handle = opendirSync(dir);
      directories.add(key(dir));
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (++entries > MAX_ENTRIES || files.size >= MAX_FILES) {
            reasons.add("Directory entry or file-count limit reached.");
            exhausted = true;
            break;
          }
          const name = entry.name;
          if (name.startsWith(".") || name.startsWith("~") || entry.isSymbolicLink()) continue;
          const file = path.join(dir, name);
          if (entry.isDirectory()) {
            if (!ignoredDirectories.has(name.toLowerCase())) pending.push(file);
            continue;
          }
          if (!entry.isFile() || /\.(?:min|bundle|tmp|temp|bak)\.[cm]?[jt]sx?$/i.test(name)) continue;
          const source = sourceExtension.test(name);
          if (!source && !configName.test(name)) continue;
          const result = readProjectFile(file, MAX_TOTAL_BYTES - bytes, reasons);
          if (result === "budget") {
            exhausted = true;
            break;
          }
          if (!result) continue;
          files.set(key(file), { file, content: result.content });
          if (source) sources.push(file);
          bytes += result.size;
        }
      } finally {
        handle.closeSync();
      }
    } catch {
      reasons.add("Some project directories could not be read.");
    }
  }
  return { files, sources, directories, reasons };
}

export function loadCodeSymbolProject(root: string) {
  const { files, sources, directories, reasons } = snapshot(root);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    allowJs: true, checkJs: true, noLib: true, noEmit: true, types: [], skipLibCheck: true,
  };
  // Load only the ES library and its references from the app's own compiler.
  // Project imports, lib directives and tsconfigs never choose a disk path here.
  const libDir = path.dirname(ts.getDefaultLibFilePath(options));
  const libraries = new Map<string, string>();
  const names = new Set(["esnext"]);
  for (const name of names) {
    if (!/^(?:es(?:5|20\d\d|next)(?:\.[a-z0-9]+)*|decorators(?:\.legacy)?)$/.test(name)) continue;
    const file = path.join(libDir, "lib." + name + ".d.ts");
    try {
      const content = readFileSync(file, "utf8");
      libraries.set(key(file), content);
      for (const ref of ts.preProcessFile(content, false).libReferenceDirectives) names.add(ref.fileName);
    } catch {
      reasons.add("The application's TypeScript standard library could not be fully loaded.");
    }
  }
  const virtualFs = {
    fileExists: (file: string) => files.has(key(file)),
    readFile: (file: string) => files.get(key(file))?.content,
    directoryExists: (directory: string) => directories.has(key(directory)),
    getDirectories: () => [],
    getCurrentDirectory: () => root,
  };
  const configCache = new Map<string, ts.CompilerOptions>();
  const resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const localPackages = new Map<string, { directory: string; hasExports: boolean } | null>();
  for (const { file, content } of files.values()) {
    if (path.basename(file) !== "package.json") continue;
    try {
      const manifest = JSON.parse(content);
      if (typeof manifest?.name !== "string") continue;
      const pkg = { directory: path.dirname(file), hasExports: manifest.exports != null };
      localPackages.set(manifest.name, localPackages.has(manifest.name) ? null : pkg);
    } catch {
      reasons.add("A local package manifest could not be read.");
    }
  }
  const localPackageCache = ts.createModuleResolutionCache(root, key, options);
  function optionsForDirectory(directory: string): ts.CompilerOptions {
    const directoryKey = key(directory);
    const cached = configCache.get(directoryKey);
    if (cached) return cached;
    const config = ["tsconfig.json", "jsconfig.json"].map(name => path.join(directory, name)).find(virtualFs.fileExists);
    let result = options;
    if (config) {
      // Read JSON config/extends from the snapshot. Import only options that affect
      // paths, never plugins, file lists, type roots, external libraries or emit options.
      const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, {
        ...virtualFs, useCaseSensitiveFileNames: caseSensitive, readDirectory: () => [],
        onUnRecoverableConfigFileDiagnostic: () => reasons.add("A project configuration could not be read."),
      });
      if (parsed) {
        if (parsed.errors.some(error => error.code !== 18002 && error.code !== 18003)) {
          reasons.add("Some project configuration or inherited settings could not be resolved.");
        }
        // TS also stores the origin of inherited paths without a baseUrl on its
        // parsed options. Retain that field when passing options to its resolver.
        result = {
          ...options, baseUrl: parsed.options.baseUrl, paths: parsed.options.paths,
          pathsBasePath: parsed.options.pathsBasePath, rootDirs: parsed.options.rootDirs,
        };
      }
    } else if (directoryKey !== key(root) && directories.has(key(path.dirname(directory)))) {
      result = optionsForDirectory(path.dirname(directory));
    }
    configCache.set(directoryKey, result);
    return result;
  }
  const host: ts.CompilerHost = {
    ...virtualFs,
    getSourceFile(fileName, languageVersion) {
      const text = libraries.get(key(fileName)) ?? virtualFs.readFile(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    resolveModuleNameLiterals(literals, containingFile) {
      const config = optionsForDirectory(path.dirname(containingFile));
      let cache = resolutionCaches.get(config);
      if (!cache) {
        cache = ts.createModuleResolutionCache(root, key, config);
        resolutionCaches.set(config, cache);
      }
      return literals.map(({ text }) => {
        const resolved = ts.resolveModuleName(text, containingFile, config, virtualFs, cache);
        if (resolved.resolvedModule) return resolved;
        const packageName = /^(?:@[^/]+\/)?[^./][^/]*/.exec(text)?.[0];
        const pkg = packageName && localPackages.get(packageName);
        if (!pkg) return resolved;
        // TS resolves package self-references using its own exports/conditions logic.
        // For legacy packages, a relative lookup honors types/main and index files.
        const subpath = text.slice(packageName.length);
        const specifier = pkg.hasExports ? text : "." + subpath;
        return ts.resolveModuleName(specifier, path.join(pkg.directory, "__symbol_index__.ts"), options, virtualFs, localPackageCache);
      });
    },
    getCanonicalFileName: key,
    useCaseSensitiveFileNames: () => caseSensitive,
    getNewLine: () => "\n",
    writeFile: () => { throw Error("Read-only symbol index."); },
    getDefaultLibFileName: () => "",
  };
  const program = ts.createProgram([...libraries.keys(), ...sources.sort()], options, host);
  const projectSources = sources.map(file => program.getSourceFile(file)).filter(source => source !== undefined);
  return { checker: program.getTypeChecker(), projectSources, reasons, indexedFiles: projectSources.length };
}
