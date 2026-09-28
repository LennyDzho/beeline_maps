import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const dataUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const errorModule = dataUrl(await compile("../app/lib/server/mobile/errors.ts"));
let source = await compile("../app/lib/server/mobile/media.ts");
source = source.replace('"cloudflare:workers"', JSON.stringify(dataUrl("export const env = {};")))
  .replace('"./context"', JSON.stringify(errorModule))
  .replace('"./state"', JSON.stringify(dataUrl("export const datasetVersionSql=''; export function assertMobileDataset() { throw new Error('Storage is not part of media stream unit tests'); } export function ownOrder() { throw new Error('Storage is not part of media stream unit tests'); }")));
const { checkedStream, mediaSignatureMatches } = await import(dataUrl(source));

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
async function validate(chunks, type = "image/png", size = png.length) {
  const readable = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return new Uint8Array(await new Response(readable.pipeThrough(checkedStream(type, size))).arrayBuffer());
}

test("MEDIA-01 verifies each supported media signature and rejects disguised content", () => {
  assert.equal(mediaSignatureMatches("image/png", png), true);
  assert.equal(mediaSignatureMatches("image/jpeg", Uint8Array.from([255, 216, 255])), true);
  assert.equal(mediaSignatureMatches("image/webp", new TextEncoder().encode("RIFF0000WEBP")), true);
  assert.equal(mediaSignatureMatches("video/mp4", new TextEncoder().encode("0000ftypisom")), true);
  assert.equal(mediaSignatureMatches("video/webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), true);
  assert.equal(mediaSignatureMatches("text/html", png), false);
  for (const mime of ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]) {
    assert.equal(mediaSignatureMatches(mime, new TextEncoder().encode("<script>evil</script>")), false, mime);
  }
});

test("MEDIA-02 fragmented headers and single-byte network chunks preserve the data", async () => {
  assert.deepEqual(await validate([png]), png);
  assert.deepEqual(await validate([...png].map((byte) => Uint8Array.of(byte))), png);
});

test("MEDIA-03 received body larger than declared size is rejected", async () => {
  await assert.rejects(validate([png, Uint8Array.of(1)]), (error) => error.status === 413);
});

test("MEDIA-04 incomplete stream or missing header is rejected", async () => {
  await assert.rejects(validate([png.slice(0, 10)]), (error) => error.status === 400);
  await assert.rejects(validate([png], "image/png", png.length + 10), (error) => error.status === 400);
});

test("MEDIA-05 MIME mismatch fails without passing the invalid chunk downstream", async () => {
  await assert.rejects(validate([png], "video/mp4"), (error) => error.status === 415);
});
