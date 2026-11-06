import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const project = fileURLToPath(new URL("..", import.meta.url));

function dependencyPath(specifier, parent) {
  const exact = resolve(dirname(parent), specifier);
  const candidates = [
    exact,
    ...(exact.endsWith(".js") ? [exact.slice(0, -3) + ".ts", exact.slice(0, -3) + ".tsx"] : []),
    exact + ".ts",
    exact + ".tsx",
    exact + ".mjs",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found || relative(project, found).startsWith(".."))
    throw new Error(
      `Unresolved runtime dependency: ${specifier} from ${relative(project, parent)}`,
    );
  return found;
}

/** Match Vercel's per-file TypeScript emit, then run its ESM output with plain Node. */
export async function compileApiRuntime() {
  const config = ts.readConfigFile(resolve(project, "tsconfig.json"), ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, project);
  if (parsed.errors.length)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, "\n"));
  const directory = await mkdtemp(resolve(tmpdir(), "fathom-api-runtime-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(resolve(directory, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(resolve(project, "node_modules"), resolve(directory, "node_modules"), "dir");
    const entry = resolve(project, "api/[...path].ts");
    const queue = [entry];
    const visited = new Set();
    for (const path of queue) {
      if (visited.has(path)) continue;
      visited.add(path);
      const source = await readFile(path, "utf8");
      for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
        if (specifier.startsWith("@/"))
          throw new Error(`Unresolved runtime alias: ${specifier} from ${relative(project, path)}`);
        if (specifier.startsWith(".")) queue.push(dependencyPath(specifier, path));
      }
      const extension = extname(path);
      const output = resolve(directory, relative(project, path).replace(/\.tsx?$/, ".js"));
      await mkdir(dirname(output), { recursive: true });
      if (extension === ".ts" || extension === ".tsx") {
        const result = ts.transpileModule(source, {
          fileName: path,
          compilerOptions: {
            ...parsed.options,
            noEmit: false,
            declaration: false,
            declarationMap: false,
            sourceMap: false,
            inlineSourceMap: false,
          },
          reportDiagnostics: true,
        });
        const error = result.diagnostics?.find(
          (item) => item.category === ts.DiagnosticCategory.Error,
        );
        if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
        await writeFile(output, result.outputText);
      } else await writeFile(output, source);
    }
    // Preserve the server's filesystem migration fallback in the emitted layout.
    await cp(resolve(project, "migrations"), resolve(directory, "migrations"), { recursive: true });
    return {
      directory,
      entryURL: pathToFileURL(resolve(directory, "api/[...path].js")).href,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
