import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { sourceRoot } from "./deploy-local.mjs";

export const extensionPath = join(".github", "extensions", "markdown-comments");

export function pluginVersion(version, sourceCommit) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
        throw new Error("Release requires a MAJOR.MINOR.PATCH version and a full source commit SHA.");
    }
    return `${version}+${sourceCommit.slice(0, 7)}`;
}

async function licenseNotices(results) {
    const packages = new Set();
    for (const result of results) {
        for (const input of Object.keys(result.metafile.inputs)) {
            const parts = input.replaceAll("\\", "/").split("/");
            const index = parts.lastIndexOf("node_modules");
            if (index < 0) continue;
            packages.add(parts.slice(0, index + (parts[index + 1].startsWith("@") ? 3 : 2)).join("/"));
        }
    }
    const notices = [];
    for (const path of [...packages].sort()) {
        const root = resolve(sourceRoot, path);
        const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        notices.push(`${metadata.name}@${metadata.version} (${metadata.license || "see package license"})`);
        const files = (await readdir(root)).filter((name) => /^(license|licence|copying|notice)([.-]|$)/i.test(name));
        for (const file of files.sort()) notices.push(await readFile(join(root, file), "utf8"));
    }
    return `${notices.join("\n\n")}\n`;
}

export async function buildRelease({ outputRoot, sourceCommit }) {
    const plugin = JSON.parse(await readFile(join(sourceRoot, "scripts", "plugin.json"), "utf8"));
    const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
    plugin.version = pluginVersion(pkg.version, sourceCommit);
    outputRoot = resolve(outputRoot);
    // Refuse to overwrite an existing directory, including a checkout or installed extension.
    await mkdir(outputRoot);
    const extension = join(outputRoot, extensionPath);
    await mkdir(join(extension, "dist"), { recursive: true });
    for (const file of ["extension.mjs", "copilot-extension.json", "server.mjs", "index.html", "style.css", "feedback.json", "LICENSE", join("examples", "welcome.md")]) {
        await mkdir(dirname(join(extension, file)), { recursive: true });
        await cp(join(sourceRoot, file), join(extension, file));
    }
    const results = await Promise.all([
        build({
            absWorkingDir: sourceRoot, entryPoints: ["ui.mjs"], bundle: true, format: "esm",
            outdir: join(extension, "dist"), entryNames: "app", metafile: true,
        }),
        build({
            absWorkingDir: sourceRoot, entryPoints: ["review.mjs"], bundle: true, format: "esm",
            platform: "node", target: "node22", outfile: join(extension, "review.mjs"), metafile: true,
        }),
    ]);
    await writeFile(join(extension, "THIRD-PARTY-NOTICES.txt"), await licenseNotices(results));
    await writeFile(join(outputRoot, "plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
    await cp(join(sourceRoot, "LICENSE"), join(outputRoot, "LICENSE"));
    const marketplace = JSON.parse(await readFile(join(sourceRoot, ".github", "plugin", "marketplace.json"), "utf8"));
    marketplace.plugins = [{ ...plugin, source: "./" }];
    await mkdir(join(outputRoot, ".github", "plugin"), { recursive: true });
    await writeFile(join(outputRoot, ".github", "plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
    return extension;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    buildRelease({
        outputRoot: process.argv[2] || join(sourceRoot, "release"),
        sourceCommit: process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    }).then((extension) => console.log(`Built plugin: ${extension}`)).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
