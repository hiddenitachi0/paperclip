import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import multer from "multer";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MEDIA_FOOTAGE_DEFAULTS,
  MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES,
  MEDIA_VIDEO_FILE_HARD_MAX_BYTES,
  readMediaFootageSettings,
  updateMediaFootageSettingsSchema,
} from "@paperclipai/shared";
import {
  isVideoContentType,
  maxBytesForContentType,
  normalizeVideoFileMaxBytes,
  parseVideoFileMaxBytes,
} from "../attachment-types.js";
import { HttpError } from "../errors.js";
import { contentDispositionHeader, parseByteRangeHeader, sendStoredObject } from "../http/byte-range.js";
import {
  assertLargeUploadIsVideo,
  discardUpload,
  receiveCompanyFileUpload,
  uploadLimitBytes,
} from "../http/file-uploads.js";
import type { CompanyFileLimits } from "../services/media-video-limits.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

/**
 * D18 (owner's decision, 27 Oct): long Media Studio videos must not be stopped by the
 * 25 MB file limit. Video files get their own per-file limit (2 GB by
 * default, at most 4 GB), are streamed to and from the server's disk
 * instead of being held in memory, and are served with byte ranges. Every
 * other kind of file keeps its old limit.
 */

const tempRoots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** The start of a real MP4 (an "ftyp" box), then filler: enough for the container sniff. */
function fakeMp4(size: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1")]);
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
  return Buffer.concat([head, body]).subarray(0, size);
}

describe("D18 limits: video files get their own, larger per-file limit", () => {
  it("defaults to 2 GB per video file, never above the 4 GB hard maximum", () => {
    expect(MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES).toBe(2 * 1024 ** 3);
    expect(MEDIA_VIDEO_FILE_HARD_MAX_BYTES).toBe(4 * 1024 ** 3);
    expect(parseVideoFileMaxBytes(undefined)).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
    expect(parseVideoFileMaxBytes("")).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
    expect(parseVideoFileMaxBytes("-5")).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
    expect(parseVideoFileMaxBytes("not a number")).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
    expect(parseVideoFileMaxBytes(String(1024 ** 3))).toBe(1024 ** 3);
    expect(parseVideoFileMaxBytes(String(10 * 1024 ** 4))).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
    expect(normalizeVideoFileMaxBytes(null)).toBe(MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES);
    expect(normalizeVideoFileMaxBytes(300 * 1024 * 1024)).toBe(300 * 1024 * 1024);
    expect(normalizeVideoFileMaxBytes(64 * 1024 ** 3)).toBe(MEDIA_VIDEO_FILE_HARD_MAX_BYTES);
  });

  it("gives the video limit to video files only; everything else keeps the attachment limit", () => {
    const limits = { attachmentMaxBytes: 25 * 1024 * 1024, videoFileMaxBytes: 2 * 1024 ** 3 };
    expect(isVideoContentType("video/mp4")).toBe(true);
    expect(isVideoContentType(" Video/QuickTime ")).toBe(true);
    expect(isVideoContentType("image/png")).toBe(false);
    expect(isVideoContentType("application/zip")).toBe(false);
    expect(isVideoContentType(null)).toBe(false);
    expect(maxBytesForContentType("video/mp4", limits)).toBe(2 * 1024 ** 3);
    expect(maxBytesForContentType("video/webm", limits)).toBe(2 * 1024 ** 3);
    expect(maxBytesForContentType("image/png", limits)).toBe(25 * 1024 * 1024);
    expect(maxBytesForContentType("application/pdf", limits)).toBe(25 * 1024 * 1024);
    // A video never gets less than it had before, even with a tiny video setting.
    expect(maxBytesForContentType("video/mp4", { attachmentMaxBytes: 50, videoFileMaxBytes: 10 })).toBe(50);
  });

  it("adds an editable per-company 'largest film or saved video' setting (2048 MB) and raises uploaded videos to 2 GB", () => {
    expect(MEDIA_FOOTAGE_DEFAULTS.maxVideoFileMb).toBe(2048);
    expect(MEDIA_FOOTAGE_DEFAULTS.maxVideoMb).toBe(2048);
    expect(MEDIA_FOOTAGE_DEFAULTS.maxPhotoMb).toBe(20);
    expect(readMediaFootageSettings(null).maxVideoFileMb).toBe(2048);
    expect(readMediaFootageSettings({ mediaVideoFileMaxMb: 500 }).maxVideoFileMb).toBe(500);
    // Stored nonsense falls back; stored values above the hard limit are capped.
    expect(readMediaFootageSettings({ mediaVideoFileMaxMb: "lots" }).maxVideoFileMb).toBe(2048);
    expect(readMediaFootageSettings({ mediaVideoFileMaxMb: 99_999 }).maxVideoFileMb).toBe(4096);
    expect(updateMediaFootageSettingsSchema.safeParse({ maxVideoFileMb: 4096 }).success).toBe(true);
    expect(updateMediaFootageSettingsSchema.safeParse({ maxVideoFileMb: 4097 }).success).toBe(false);
    expect(updateMediaFootageSettingsSchema.safeParse({ maxVideoFileMb: 0 }).success).toBe(false);
  });

  it("lets the server set a lower ceiling for every company (PAPERCLIP_VIDEO_FILE_MAX_BYTES)", async () => {
    const previous = process.env.PAPERCLIP_VIDEO_FILE_MAX_BYTES;
    process.env.PAPERCLIP_VIDEO_FILE_MAX_BYTES = String(1024 ** 3);
    vi.resetModules();
    try {
      const limits = await import("../services/media-video-limits.js");
      const attachmentTypes = await import("../attachment-types.js");
      expect(limits.instanceVideoFileMaxMb()).toBe(1024);
      expect(limits.mediaFootageHardLimits()).toMatchObject({ maxVideoMb: 1024, maxVideoFileMb: 1024, maxPhotoMb: 50 });
      const applied = limits.applyInstanceVideoCeiling(readMediaFootageSettings(null));
      expect(applied).toMatchObject({ maxVideoMb: 1024, maxVideoFileMb: 1024, maxPhotoMb: 20 });
      expect(attachmentTypes.normalizeVideoFileMaxBytes(null)).toBe(1024 ** 3);
      expect(attachmentTypes.normalizeVideoFileMaxBytes(3 * 1024 ** 3)).toBe(1024 ** 3);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_VIDEO_FILE_MAX_BYTES;
      else process.env.PAPERCLIP_VIDEO_FILE_MAX_BYTES = previous;
      vi.resetModules();
    }
  });
});

describe("D18 storage: putFileFromPath streams a file from disk into storage", () => {
  it("stores the file under the company prefix with the right size and sha256, and leaves the source in place", async () => {
    const root = await tempDir("paperclip-d18-storage-");
    const work = await tempDir("paperclip-d18-work-");
    const service = createStorageService(createLocalDiskStorageProvider(root));
    const content = fakeMp4(3 * 1024 * 1024 + 17); // several stream chunks
    const source = path.join(work, "film.mp4");
    await fs.writeFile(source, content);

    const stored = await service.putFileFromPath({
      companyId: "company-1",
      namespace: "video-storylines/s-1",
      originalFilename: "Min film.mp4",
      contentType: "Video/MP4",
      filePath: source,
      maxBytes: 4 * 1024 * 1024,
    });

    expect(stored.objectKey.startsWith("company-1/video-storylines/s-1/")).toBe(true);
    expect(stored.contentType).toBe("video/mp4");
    expect(stored.byteSize).toBe(content.length);
    expect(stored.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(Buffer.compare(await readAll((await service.getObject("company-1", stored.objectKey)).stream), content)).toBe(0);
    expect(await fs.readFile(source)).toHaveLength(content.length);
    // No temp files are left next to the stored object.
    expect((await listFiles(root)).filter((file) => file.includes(".tmp-"))).toEqual([]);
    // Company scoping still holds for streamed files.
    await expect(service.getObject("company-2", stored.objectKey)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a file over maxBytes (413), an empty file and a missing file, storing nothing", async () => {
    const root = await tempDir("paperclip-d18-storage-");
    const work = await tempDir("paperclip-d18-work-");
    const service = createStorageService(createLocalDiskStorageProvider(root));
    const big = path.join(work, "big.mp4");
    await fs.writeFile(big, fakeMp4(2048));
    const empty = path.join(work, "empty.mp4");
    await fs.writeFile(empty, Buffer.alloc(0));
    const base = { companyId: "company-1", namespace: "files", originalFilename: "x.mp4", contentType: "video/mp4" };

    await expect(service.putFileFromPath({ ...base, filePath: big, maxBytes: 1024 })).rejects.toMatchObject({ status: 413 });
    await expect(service.putFileFromPath({ ...base, filePath: empty })).rejects.toMatchObject({ status: 422 });
    await expect(service.putFileFromPath({ ...base, filePath: path.join(work, "nope.mp4") })).rejects.toMatchObject({ status: 422 });
    expect(await listFiles(root)).toEqual([]);
  });

  it("leaves no half-written file behind when the incoming stream fails", async () => {
    const root = await tempDir("paperclip-d18-storage-");
    const provider = createLocalDiskStorageProvider(root);
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(1024, 1));
        this.destroy(new Error("disk went away"));
      },
    });
    await expect(provider.putObject({ objectKey: "company-1/files/x.mp4", body: failing, contentType: "video/mp4", contentLength: 4096 })).rejects.toThrow(/disk went away/);
    expect(await listFiles(root)).toEqual([]);
  });
});

describe("D18 byte ranges", () => {
  it("parses single ranges and refuses what cannot be served", () => {
    expect(parseByteRangeHeader(undefined, 100)).toEqual({ kind: "none" });
    expect(parseByteRangeHeader("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseByteRangeHeader("bytes=90-", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseByteRangeHeader("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseByteRangeHeader("bytes=50-500", 100)).toEqual({ kind: "range", start: 50, end: 99 });
    expect(parseByteRangeHeader("bytes=100-", 100)).toEqual({ kind: "invalid" });
    expect(parseByteRangeHeader("bytes=0-1,5-6", 100)).toEqual({ kind: "invalid" });
    expect(parseByteRangeHeader("items=0-1", 100)).toEqual({ kind: "invalid" });
    expect(parseByteRangeHeader("bytes=9-3", 100)).toEqual({ kind: "invalid" });
  });

  it("writes a download name that survives quotes and Norwegian letters", () => {
    expect(contentDispositionHeader("attachment", 'Blåbær "film".mp4')).toBe(
      `attachment; filename="Bl_b_r film.mp4"; filename*=UTF-8''Bl%C3%A5b%C3%A6r%20%22film%22.mp4`,
    );
    expect(contentDispositionHeader("inline", "plain.mp4")).toBe(`inline; filename="plain.mp4"; filename*=UTF-8''plain.mp4`);
  });

  const body = Buffer.from("0123456789abcdefghij");
  const getObject = vi.fn(async (_companyId: string, _objectKey: string, options?: { range?: { start: number; end: number } }) => {
    const slice = options?.range ? body.subarray(options.range.start, options.range.end + 1) : body;
    return { stream: Readable.from(slice), contentLength: slice.length, contentType: "application/octet-stream" };
  });
  function app(byteSize: number | null) {
    const server = express();
    server.get("/film", (req, res, next) => {
      void sendStoredObject(req, res, next, { getObject } as never, {
        companyId: "company-1",
        objectKey: "company-1/film.mp4",
        byteSize,
        contentType: "video/mp4",
        fallbackContentType: "application/octet-stream",
      }).catch(next);
    });
    return server;
  }
  const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body?: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  };

  afterEach(() => getObject.mockClear());

  it("streams the whole file with Accept-Ranges when no range is asked for", async () => {
    const res = await request(app(body.length)).get("/film").buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-length"]).toBe(String(body.length));
    expect(Buffer.compare(res.body as Buffer, body)).toBe(0);
    expect(getObject).toHaveBeenCalledWith("company-1", "company-1/film.mp4");
  });

  it("serves just the asked-for bytes as 206 with Content-Range (seeking in a long film)", async () => {
    const res = await request(app(body.length)).get("/film").set("Range", "bytes=5-9").buffer(true).parse(binary);
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 5-9/${body.length}`);
    expect(res.headers["content-length"]).toBe("5");
    expect((res.body as Buffer).toString()).toBe("56789");
    expect(getObject).toHaveBeenCalledWith("company-1", "company-1/film.mp4", { range: { start: 5, end: 9 } });
  });

  it("answers 416 for a range it cannot serve, without reading storage", async () => {
    const res = await request(app(body.length)).get("/film").set("Range", "bytes=500-600");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${body.length}`);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("sends the whole file when the stored size is unknown (old rows)", async () => {
    const res = await request(app(null)).get("/film").set("Range", "bytes=5-9").buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe(String(body.length));
    expect(Buffer.compare(res.body as Buffer, body)).toBe(0);
  });
});

describe("D18 uploads: videos spill to disk past the ordinary limit; other files keep it", () => {
  let workDir = "";
  const previousWorkDir = process.env.PAPERCLIP_MEDIA_WORK_DIR;
  beforeAll(async () => {
    workDir = await tempDir("paperclip-d18-uploads-");
    process.env.PAPERCLIP_MEDIA_WORK_DIR = workDir;
  });
  afterAll(() => {
    if (previousWorkDir === undefined) delete process.env.PAPERCLIP_MEDIA_WORK_DIR;
    else process.env.PAPERCLIP_MEDIA_WORK_DIR = previousWorkDir;
  });

  const limits: CompanyFileLimits = { attachmentMaxBytes: 64, videoFileMaxBytes: 8 * 1024 * 1024 };
  function uploadApp() {
    const server = express();
    server.post("/upload", async (req, res) => {
      let file: Awaited<ReturnType<typeof receiveCompanyFileUpload>>;
      try {
        file = await receiveCompanyFileUpload(req, res, limits);
      } catch (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${uploadLimitBytes(err, limits)} bytes` });
          return;
        }
        res.status(500).json({ error: String(err) });
        return;
      }
      if (!file) {
        res.status(400).json({ error: "missing" });
        return;
      }
      let status = 200;
      let payload: Record<string, unknown>;
      try {
        await assertLargeUploadIsVideo(file, limits);
        const bytes = file.path ? await fs.readFile(file.path) : file.buffer!;
        payload = {
          inMemory: Boolean(file.buffer),
          onDisk: Boolean(file.path),
          insideWorkDir: file.path ? path.dirname(file.path) === workDir : null,
          size: file.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } catch (err) {
        status = err instanceof HttpError ? err.status : 500;
        payload = { error: (err as Error).message };
      } finally {
        // Like the real routes: the spool file is gone before the answer is sent.
        await discardUpload(file);
      }
      res.status(status).json(payload);
    });
    return server;
  }

  it("keeps a small file (any kind) in memory, as before", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", Buffer.from("tiny png bytes"), { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inMemory: true, onDisk: false, size: 14 });
  });

  it("refuses a non-video file over the ordinary limit, with the ordinary limit in the message", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", Buffer.alloc(200, 7), { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("File exceeds 64 bytes");
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it("streams a large video to a spool file in the media work folder, byte for byte", async () => {
    const video = fakeMp4(3 * 1024 * 1024 + 5);
    const res = await request(uploadApp()).post("/upload").attach("file", video, { filename: "film.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inMemory: false, onDisk: true, insideWorkDir: true, size: video.length });
    expect(res.body.sha256).toBe(createHash("sha256").update(video).digest("hex"));
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it("refuses a video over the video limit and removes what was spooled", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", fakeMp4(8 * 1024 * 1024 + 1), { filename: "long.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`File exceeds ${8 * 1024 * 1024} bytes`);
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it("refuses a large file that only claims to be a video", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", Buffer.alloc(4096, "x"), { filename: "notes.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("not a video");
    expect(await fs.readdir(workDir)).toEqual([]);
  });
});
