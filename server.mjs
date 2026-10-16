import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReviewError } from "./review.mjs";

const files = {
    "": ["index.html", "text/html; charset=utf-8"],
    "app.js": ["dist/app.js", "text/javascript; charset=utf-8"],
    "style.css": ["style.css", "text/css; charset=utf-8"],
};

async function body(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) throw new ReviewError("Request exceeds 128 KiB.", 413);
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new ReviewError("Request must be valid JSON.");
    }
}

export async function startServer({ path, store }) {
    const token = randomBytes(32).toString("hex");
    let origin;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'");
        const json = (status, value) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(value));
        };
        try {
            if (req.headers.host !== new URL(origin).host || !req.url.startsWith(`/${token}/`)) {
                return json(404, { error: "Not found." });
            }
            const route = req.url.slice(token.length + 2).split("?")[0];
            if (req.method === "GET" && Object.hasOwn(files, route)) {
                const [file, type] = files[route];
                const content = await readFile(new URL(file, import.meta.url));
                res.writeHead(200, { "Content-Type": type });
                return res.end(content);
            }
            if (req.method === "GET" && route === "state") return json(200, await store.state(path));
            if (req.method === "POST" && ["comments", "resolve", "reopen"].includes(route)) {
                if (req.headers.origin !== origin || req.headers["content-type"]?.split(";")[0] !== "application/json") {
                    throw new ReviewError("Same-origin JSON requests are required.", 403);
                }
                const input = await body(req);
                if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewError("Expected a JSON object.");
                return json(200, route === "comments" ? await store.submit(path, input) :
                    route === "reopen" ? await store.reopen(path, input) : await store.resolve(path, input));
            }
            json(404, { error: "Not found." });
        } catch (error) {
            const status = error instanceof ReviewError ? error.status : error.code === "ENOENT" ? 404 : 500;
            json(status, { error: error.message });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        path, server, url: `${origin}/${token}/`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
