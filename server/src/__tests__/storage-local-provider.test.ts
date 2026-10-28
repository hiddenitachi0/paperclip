import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("local disk storage provider", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("round-trips bytes through storage service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = Buffer.from("hello image bytes", "utf8");
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: content,
    });

    const fetched = await service.getObject("company-1", stored.objectKey);
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    expect(stored.sha256).toHaveLength(64);
  });

  it("streams only requested byte ranges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.mp4",
      contentType: "video/mp4",
      body: Buffer.from("0123456789", "utf8"),
    });

    const fetched = await service.getObject("company-1", stored.objectKey, { range: { start: 2, end: 5 } });
    const fetchedBody = await readStreamToBuffer(fetched.stream);

    expect(fetchedBody.toString("utf8")).toBe("2345");
    expect(fetched.contentLength).toBe(4);
  });

  it("blocks cross-company object access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-a",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await expect(service.getObject("company-b", stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("delete is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    tempRoots.push(root);

    const service = createStorageService(createLocalDiskStorageProvider(root));
    const stored = await service.putFile({
      companyId: "company-1",
      namespace: "issues/issue-1",
      originalFilename: "demo.png",
      contentType: "image/png",
      body: Buffer.from("hello", "utf8"),
    });

    await service.deleteObject("company-1", stored.objectKey);
    await service.deleteObject("company-1", stored.objectKey);
    await expect(service.getObject("company-1", stored.objectKey)).rejects.toMatchObject({ status: 404 });
  });

  describe("putFileFromPath (D18: large files are streamed, never held in memory)", () => {
    async function setup() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
      tempRoots.push(root);
      const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-src-"));
      tempRoots.push(sourceDir);
      return { root, sourceDir, service: createStorageService(createLocalDiskStorageProvider(root)) };
    }

    it("streams a file from disk into storage with the right size and hash, and leaves the source in place", async () => {
      const { sourceDir, service } = await setup();
      // Several read-stream chunks (64 KiB each), so the copy really is streamed.
      const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
      content.write("MP4-HEADER", 0);
      const source = path.join(sourceDir, "video.mp4");
      await fs.writeFile(source, content);

      const stored = await service.putFileFromPath({
        companyId: "company-1",
        namespace: "code-renders",
        originalFilename: "Q3 orders.mp4",
        contentType: "Video/MP4",
        filePath: source,
        maxBytes: content.length,
      });

      expect(stored).toMatchObject({ contentType: "video/mp4", byteSize: content.length, originalFilename: "Q3 orders.mp4" });
      expect(stored.objectKey.startsWith("company-1/code-renders/")).toBe(true);
      expect(stored.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      const fetched = await readStreamToBuffer((await service.getObject("company-1", stored.objectKey)).stream);
      expect(fetched.equals(content)).toBe(true);
      expect((await fs.stat(source)).size).toBe(content.length);
    });

    it("refuses a file over maxBytes, an empty file and a missing one, storing nothing", async () => {
      const { root, sourceDir, service } = await setup();
      const big = path.join(sourceDir, "big.mp4");
      await fs.writeFile(big, Buffer.alloc(1025));
      const empty = path.join(sourceDir, "empty.mp4");
      await fs.writeFile(empty, Buffer.alloc(0));
      const base = { companyId: "company-1", namespace: "code-renders", originalFilename: "x.mp4", contentType: "video/mp4" };

      await expect(service.putFileFromPath({ ...base, filePath: big, maxBytes: 1024 })).rejects.toMatchObject({ status: 413 });
      await expect(service.putFileFromPath({ ...base, filePath: empty })).rejects.toMatchObject({ status: 422 });
      await expect(service.putFileFromPath({ ...base, filePath: path.join(sourceDir, "missing.mp4") })).rejects.toMatchObject({ status: 422 });
      await expect(service.putFileFromPath({ ...base, filePath: sourceDir })).rejects.toMatchObject({ status: 422 });
      expect(await fs.readdir(root)).toEqual([]);
    });

    it("the local provider writes a stream body to disk, and leaves no temp file when the stream breaks", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
      tempRoots.push(root);
      const provider = createLocalDiskStorageProvider(root);
      await provider.putObject({ objectKey: "c/ok.bin", body: Readable.from([Buffer.from("ab"), Buffer.from("cd")]), contentType: "application/octet-stream", contentLength: 4 });
      expect(await fs.readFile(path.join(root, "c", "ok.bin"), "utf8")).toBe("abcd");

      const broken = new Readable({
        read() {
          this.push(Buffer.from("half"));
          this.destroy(new Error("disk went away"));
        },
      });
      await expect(provider.putObject({ objectKey: "c/broken.bin", body: broken, contentType: "application/octet-stream", contentLength: 8 })).rejects.toThrow(/disk went away/);
      expect((await fs.readdir(path.join(root, "c"))).sort()).toEqual(["ok.bin"]);
    });
  });
});
