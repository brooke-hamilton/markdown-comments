import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import MarkdownIt from "markdown-it";
import reference from "../markdown-reference.mjs";

test("backported references preserve link destinations, titles, nesting and source maps", () => {
    const original = new MarkdownIt();
    const patched = new MarkdownIt();
    patched.block.ruler.at("reference", reference);
    for (const source of [
        '[link][ref]\n\n[ref]: https://example.com "Title"\n',
        '[multi line]\n\n[multi\n line]: /target\n',
        '[link][ref]\n\n[ref]: /target "A title\non another line"\n',
        '[escaped\\]][ref]\n\n[ref]: /target\n',
        '[link][ref]\n\n[ref]:\n  /target\n  "Title"\n',
        '> [link][ref]\n>\n> [ref]: /target "Title"\n',
        '- [link][ref]\n\n  [ref]: /target\n',
        '[link][ref]\n\n[ref]: /first\n[ref]: /second\n',
        '[link][ref]\n\n[ref]: /target "invalid trailing title" garbage\n',
        '[link][ref]\n\n[ref]: javascript:alert(1)\n',
    ]) {
        const expected = {}, actual = {};
        assert.deepEqual(patched.parse(source, actual), original.parse(source, expected), source);
        assert.deepEqual(actual, expected, source);
        assert.equal(patched.render(source), original.render(source), source);
    }
});

test("backported references enforce the 999-code-point label limit without rejecting valid Unicode", () => {
    const md = new MarkdownIt();
    md.block.ruler.at("reference", reference);
    for (const character of ["a", "\u{1f600}"]) {
        const label = character.repeat(999);
        assert.match(md.render(`[${label}]\n\n[${label}]: /target\n`), /<a href="\/target">/);
        const oversized = character.repeat(1000);
        assert.doesNotMatch(md.render(`[${oversized}]\n\n[${oversized}]: /target\n`), /<a /);
    }
});

test("rendering and source mapping finish within a bounded time for pathological references and HTML", async () => {
    const script = `
        import assert from "node:assert/strict";
        import { renderDocument, editingBlocks } from ${JSON.stringify(new URL("../review.mjs", import.meta.url).href)};
        const payloads = [
            '[a]: /u "' + 'x\\n'.repeat(200000),
            '[' + 'a\\n'.repeat(200000),
            '['.repeat(200000),
            ...['<!--', '<?x', '<!A', '<![CDATA['].map((opener) => 'x ' + opener.repeat(64000)),
        ];
        const timings = [];
        for (const source of payloads) {
            const start = performance.now();
            assert.ok(renderDocument(source).length > 0);
            const { blocks, tail } = editingBlocks(source);
            assert.equal(blocks.map((block) => block.prefix + block.source).join("") + tail, source);
            timings.push(performance.now() - start);
        }
        process.stdout.write(JSON.stringify(timings));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000 });
    const timings = JSON.parse(stdout);
    assert.equal(timings.length, 7);
    for (const duration of timings) assert.ok(duration < 5000, `Pathological input took ${duration} ms`);
});
