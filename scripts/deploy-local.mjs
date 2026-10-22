import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeFiles = [
    "extension.mjs", "copilot-extension.json", "review.mjs", "markdown-reference.mjs", "server.mjs",
    "index.html", "style.css", "feedback.json", join("dist", "app.js"), join("dist", "app.css"),
    "package.json", "package-lock.json", "LICENSE", join("examples", "welcome.md"),
];
const managedPaths = [...runtimeFiles, "node_modules"];

async function exists(path) {
    try {
        return await lstat(path);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return undefined;
    }
}

function contains(parent, child) {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function canonical(path) {
    if (await exists(path)) return realpath(path);
    return join(await canonical(dirname(path)), relative(dirname(path), path));
}

async function rejectLinks(path) {
    for (let current = resolve(path); ; current = dirname(current)) {
        if ((await exists(current))?.isSymbolicLink()) throw new Error(`Deployment path must not contain a symbolic link or junction: ${current}`);
        if (dirname(current) === current) break;
    }
}

export function deploymentPaths({ env = process.env, home = homedir() } = {}) {
    const copilotHome = resolve(env.COPILOT_HOME || join(home, ".copilot"));
    return { copilotHome, target: join(copilotHome, "extensions", "markdown-comments") };
}

export async function validateDestination(source, target) {
    await rejectLinks(target);
    const [from, to] = await Promise.all([realpath(source), canonical(target)]);
    if (contains(from, to) || contains(to, from)) throw new Error(`Source and deployment destination must not overlap: ${source} -> ${target}`);
    const targetInfo = await exists(target);
    if (targetInfo && !targetInfo.isDirectory()) throw new Error(`Deployment destination is not a directory: ${target}`);
    for (const path of managedPaths) await rejectLinks(join(target, path));
}

export async function runNpm(args, { cwd, env = process.env, home = homedir() }) {
    const cli = env.npm_execpath || (process.platform === "win32" ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined);
    const command = cli ? process.execPath : "npm";
    const commandArgs = cli ? [cli, ...args] : args;
    await new Promise((resolvePromise, reject) => {
        const child = spawn(command, commandArgs, {
            cwd, stdio: "inherit", shell: false,
            env: { ...env, npm_config_userconfig: join(home, ".npmrc") },
        });
        child.once("error", (error) => reject(new Error(`Could not run npm ${args.join(" ")}: ${error.message}`, { cause: error })));
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`npm ${args.join(" ")} failed (${signal ? `signal ${signal}` : `exit ${code}`}).`));
        });
    });
}

export async function verifySnapshot(stage, { env = process.env } = {}) {
    for (const file of runtimeFiles) {
        if (!(await lstat(join(stage, file))).isFile()) throw new Error(`Missing runtime file: ${file}`);
    }
    // Import in a fresh process so validation cannot resolve dependencies from the source worktree.
    const script = `
        const { validateConfig } = await import(${JSON.stringify(pathToFileURL(join(stage, "review.mjs")).href)});
        await import(${JSON.stringify(pathToFileURL(join(stage, "server.mjs")).href)});
        const { readFile } = await import("node:fs/promises");
        validateConfig(JSON.parse(await readFile(${JSON.stringify(join(stage, "feedback.json"))}, "utf8")));
    `;
    await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            cwd: stage, stdio: "inherit", env: { ...env, NODE_PATH: "" }, shell: false,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolvePromise() :
            reject(new Error(`Staged runtime validation failed (${signal || code}).`)));
    });
}

export async function installSnapshot(stage, target, backup, { move = rename } = {}) {
    const changed = [];
    await mkdir(target, { recursive: true });
    try {
        for (const path of managedPaths) {
            const destination = join(target, path);
            const saved = join(backup, path);
            await mkdir(dirname(destination), { recursive: true });
            await mkdir(dirname(saved), { recursive: true });
            const entry = { destination, saved, hadPrevious: false, installed: false };
            changed.push(entry);
            if (await exists(destination)) {
                await move(destination, saved);
                entry.hadPrevious = true;
            }
            await move(join(stage, path), destination);
            entry.installed = true;
        }
    } catch (error) {
        const failures = [];
        for (const entry of changed.reverse()) {
            try {
                if (entry.installed) await rm(entry.destination, { recursive: true, force: true });
                if (entry.hadPrevious) await move(entry.saved, entry.destination);
            } catch (restoreError) {
                failures.push(restoreError);
            }
        }
        if (failures.length) {
            const failure = new AggregateError([error, ...failures], `Deployment and rollback failed. Recovery files: ${backup}. Original failure: ${error.message}. Rollback errors: ${failures.map((item) => item.message).join("; ")}`);
            failure.preserveRecovery = true;
            throw failure;
        }
        throw new Error(`Deployment failed; previous managed files restored: ${error.message}`, { cause: error });
    }
}

export async function deployLocal({
    source = sourceRoot, env = process.env, home = homedir(), log = console.log,
    npm = runNpm, verify = verifySnapshot, install = installSnapshot,
} = {}) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || major === 22 && minor < 12) throw new Error("Developer deployment requires Node.js 22.12.0 or later.");
    source = await realpath(source);
    const copilotHome = await canonical(deploymentPaths({ env, home }).copilotHome);
    const target = join(copilotHome, "extensions", "markdown-comments");
    await validateDestination(source, target);
    log(`Source worktree: ${source}`);
    log(`User extension: ${target}`);
    if (!(await exists(join(source, "node_modules")))?.isDirectory()) {
        throw new Error(`Source dependencies are missing. Run npm ci --userconfig "${join(home, ".npmrc")}" in "${source}", then retry.`);
    }
    await mkdir(copilotHome, { recursive: true });
    const lock = join(copilotHome, ".markdown-comments-deploy.lock");
    try {
        await mkdir(lock);
    } catch (error) {
        if (error.code === "EEXIST") throw new Error(`Another deployment is running or left a lock: ${lock}. Remove only this lock after confirming no deployment is active.`);
        throw error;
    }
    let workspace;
    let preserveRecovery = false;
    try {
        await npm(["run", "build"], { cwd: source, env, home });
        await npm(["test"], { cwd: source, env, home });
        workspace = await mkdtemp(join(copilotHome, ".markdown-comments-deploy-"));
        const stage = join(workspace, "snapshot");
        await mkdir(stage);
        for (const file of runtimeFiles) {
            const from = join(source, file);
            if (!(await lstat(from)).isFile()) throw new Error(`Runtime source must be a regular file: ${from}`);
            await mkdir(dirname(join(stage, file)), { recursive: true });
            await writeFile(join(stage, file), await readFile(from));
        }
        await npm(["ci", "--omit=dev"], { cwd: stage, env, home });
        await verify(stage, { env });
        await validateDestination(source, target);
        await install(stage, target, join(workspace, "previous"));
    } catch (error) {
        preserveRecovery = error.preserveRecovery === true;
        if (preserveRecovery) log(`Recovery required; retained deployment workspace ${workspace} and lock ${lock}.`);
        throw error;
    } finally {
        if (!preserveRecovery) {
            try {
                if (workspace) await rm(workspace, { recursive: true, force: true });
            } finally {
                await rmdir(lock);
            }
        }
    }
    log(`Deployed snapshot: ${target}`);
    log("Reload extensions in Copilot, inspect the user-scoped markdown-comments provider, then reopen the canvas. Other running sessions may need their own reload.");
    log(`Sample document: ${join(target, "examples", "welcome.md")}`);
    return target;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    deployLocal().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
