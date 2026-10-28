import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MEDIA_FOOTAGE_DEFAULTS,
  MEDIA_STUDIO_PLUGIN_KEY,
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
import {
  tryTakeUploadSlot,
  UPLOADS_IN_FLIGHT_PER_COMPANY,
  uploadSlotsInUse,
  withUploadSlot,
} from "../services/company-upload-slots.js";
import type { CompanyFileLimits } from "../services/media-video-limits.js";
import { companyFileLimits, largeVideoAttachmentsOptedIn, verifyVideoBuffer } from "../services/media-video-limits.js";
import { checkFfmpegAvailable, sniffVideoContainer, verifyVideoFile } from "../services/video-ffmpeg.js";
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

const hasFfmpeg = await checkFfmpegAvailable(true);

/** Passes the 4-byte container sniff ("free" at offset 4) but is not a video at all (security review F3). */
function fakeContainer(size: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x08]), Buffer.from("free", "latin1")]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), "x")]).subarray(0, size);
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

  const limits: CompanyFileLimits = { attachmentMaxBytes: 64, videoFileMaxBytes: 8 * 1024 * 1024, storageQuotaBytes: 1024 ** 3 };
  /** Stands in for ffprobe where the test is about spooling, not about the video check (F3 has its own tests below). */
  const probeSaysVideo = async () => true;
  function uploadApp(verify: (filePath: string) => Promise<boolean> = probeSaysVideo, companyId = "company-1") {
    const server = express();
    server.post("/upload", async (req, res) => {
      let file: Awaited<ReturnType<typeof receiveCompanyFileUpload>>;
      try {
        file = await receiveCompanyFileUpload(req, res, limits, companyId);
      } catch (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${uploadLimitBytes(err, limits)} bytes` });
          return;
        }
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
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
        await assertLargeUploadIsVideo(file, limits, verify);
        const bytes = file.path ? await fs.readFile(file.path) : file.buffer!;
        payload = {
          inMemory: Boolean(file.buffer),
          onDisk: Boolean(file.path),
          insideWorkDir: file.path ? path.dirname(file.path) === workDir : null,
          size: file.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          slotsInUse: uploadSlotsInUse(companyId),
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

  it("keeps a small file (any kind) in memory, as before, without taking an upload slot", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", Buffer.from("tiny png bytes"), { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ inMemory: true, onDisk: false, size: 14, slotsInUse: 0 });
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
    // It held one of the company's upload slots while it was handled (F2), and gave it back.
    expect(res.body).toMatchObject({ inMemory: false, onDisk: true, insideWorkDir: true, size: video.length, slotsInUse: 1 });
    expect(res.body.sha256).toBe(createHash("sha256").update(video).digest("hex"));
    expect(await fs.readdir(workDir)).toEqual([]);
    expect(uploadSlotsInUse("company-1")).toBe(0);
  });

  it("refuses a video over the video limit and removes what was spooled", async () => {
    const res = await request(uploadApp()).post("/upload").attach("file", fakeMp4(8 * 1024 * 1024 + 1), { filename: "long.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`File exceeds ${8 * 1024 * 1024} bytes`);
    expect(await fs.readdir(workDir)).toEqual([]);
    expect(uploadSlotsInUse("company-1")).toBe(0);
  });

  it("refuses a large file that only claims to be a video", async () => {
    const res = await request(uploadApp(verifyVideoFile)).post("/upload").attach("file", Buffer.alloc(4096, "x"), { filename: "notes.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("not a video");
    expect(await fs.readdir(workDir)).toEqual([]);
    expect(uploadSlotsInUse("company-1")).toBe(0);
  });

  it("F3: refuses a fake container that passes the 4-byte sniff (a 'free' box, then anything) once ffprobe has read it", async () => {
    const fake = fakeContainer(4096);
    expect(sniffVideoContainer(fake)).toBe("mov"); // the old check alone would have let it in
    const res = await request(uploadApp(verifyVideoFile)).post("/upload").attach("file", fake, { filename: "film.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("not a video");
    expect(await fs.readdir(workDir)).toEqual([]);
    expect(uploadSlotsInUse("company-1")).toBe(0);
  });

  it("F2: asks a third large upload from the same company to wait (429), spooling nothing; small files and other companies go on", async () => {
    const held = Array.from({ length: UPLOADS_IN_FLIGHT_PER_COMPANY }, () => tryTakeUploadSlot("company-1"));
    expect(held.every(Boolean)).toBe(true);
    try {
      const busy = await request(uploadApp()).post("/upload").attach("file", fakeMp4(64 * 1024), { filename: "film.mp4", contentType: "video/mp4" });
      expect(busy.status).toBe(429);
      expect(busy.body.error).toContain("Other uploads for this company are still going");
      expect(await fs.readdir(workDir)).toEqual([]);
      expect(uploadSlotsInUse("company-1")).toBe(UPLOADS_IN_FLIGHT_PER_COMPANY);

      // A file within the ordinary limit never needs a slot.
      const small = await request(uploadApp()).post("/upload").attach("file", Buffer.from("tiny"), { filename: "a.txt", contentType: "text/plain" });
      expect(small.status).toBe(200);
      // Another company has its own slots.
      const other = await request(uploadApp(probeSaysVideo, "company-2")).post("/upload").attach("file", fakeMp4(64 * 1024), { filename: "film.mp4", contentType: "video/mp4" });
      expect(other.status).toBe(200);
      expect(uploadSlotsInUse("company-2")).toBe(0);
    } finally {
      for (const release of held) release?.();
    }
    const after = await request(uploadApp()).post("/upload").attach("file", fakeMp4(64 * 1024), { filename: "film.mp4", contentType: "video/mp4" });
    expect(after.status).toBe(200);
    expect(uploadSlotsInUse("company-1")).toBe(0);
  });
  it("F2: a client that goes away mid-upload gives back its upload slot and leaves nothing on disk", async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const handled: string[] = [];
    const server = express();
    server.post("/upload", async (req, res) => {
      try {
        const file = await receiveCompanyFileUpload(req, res, limits, "company-gone");
        handled.push("received");
        await discardUpload(file);
      } catch (err) {
        handled.push(String(err));
      }
      if (!res.headersSent && !res.destroyed) res.status(499).end();
    });
    const http = createServer(server);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    try {
      const { port } = http.address() as { port: number };
      const boundary = "----paperclip-d18-test";
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="film.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
        "latin1",
      );
      const { request: httpRequest } = await import("node:http");
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(head.length + 4 * 1024 * 1024) },
      });
      req.on("error", () => undefined);
      req.write(head);
      req.write(fakeMp4(256 * 1024));
      // Past the ordinary limit: it is being spooled and holds a slot.
      await vi.waitFor(async () => {
        expect(uploadSlotsInUse("company-gone")).toBe(1);
        expect(await fs.readdir(workDir)).toHaveLength(1);
      });
      req.destroy();
      await vi.waitFor(async () => {
        expect(uploadSlotsInUse("company-gone")).toBe(0);
        expect(await fs.readdir(workDir)).toEqual([]);
      });
      expect(handled).not.toContain("received");
    } finally {
      http.close();
    }
  });
});

describe("D18 security review F2: at most a few large uploads per company at once", () => {
  it("hands out UPLOADS_IN_FLIGHT_PER_COMPANY slots per company; giving one back twice frees it once", async () => {
    expect(UPLOADS_IN_FLIGHT_PER_COMPANY).toBe(2);
    const first = tryTakeUploadSlot("slots-co");
    const second = tryTakeUploadSlot("slots-co");
    expect(first && second).toBeTruthy();
    expect(tryTakeUploadSlot("slots-co")).toBeNull();
    expect(uploadSlotsInUse("slots-co")).toBe(2);
    first!();
    first!();
    expect(uploadSlotsInUse("slots-co")).toBe(1);
    await expect(withUploadSlot("slots-co", async () => uploadSlotsInUse("slots-co"))).resolves.toBe(2);
    second!();
    expect(uploadSlotsInUse("slots-co")).toBe(0);
  });

  it("withUploadSlot answers 429 when the company's slots are taken, and frees its slot when the work fails", async () => {
    const held = [tryTakeUploadSlot("slots-co-2"), tryTakeUploadSlot("slots-co-2")];
    await expect(withUploadSlot("slots-co-2", async () => "never")).rejects.toMatchObject({ status: 429 });
    held.forEach((release) => release?.());
    await expect(withUploadSlot("slots-co-2", async () => Promise.reject(new Error("storage failed")))).rejects.toThrow("storage failed");
    expect(uploadSlotsInUse("slots-co-2")).toBe(0);
  });
});

describe("D18 security review F1: large videos on tasks and in Files only where the operator and Media Studio allow them", () => {
  const MB = 1024 * 1024;
  const previousOptIn = process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
  afterEach(() => {
    if (previousOptIn === undefined) delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
    else process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = previousOptIn;
  });

  /** A stand-in for the one Media Studio settings query: plugins joined to the company's settings row. */
  function fakeDb(rows: Array<{ status: string; enabled: boolean; settingsJson: Record<string, unknown> }>) {
    const select = vi.fn(() => {
      const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, limit: async () => rows };
      return chain;
    });
    return { select } as unknown as Parameters<typeof companyFileLimits>[0] & { select: typeof select };
  }
  const company = { attachmentMaxBytes: 10 * MB };
  const ordinary = { attachmentMaxBytes: 10 * MB, videoFileMaxBytes: 10 * MB, storageQuotaBytes: null };
  const mediaStudioOn = { status: "ready", enabled: true, settingsJson: { mediaVideoFileMaxMb: 500, mediaStorageQuotaBytes: 10 * 1024 ** 3 } };

  it("is off unless the operator opts in with PAPERCLIP_LARGE_VIDEO_ATTACHMENTS", () => {
    for (const value of ["true", "1", "yes", "on", " TRUE "]) expect(largeVideoAttachmentsOptedIn({ PAPERCLIP_LARGE_VIDEO_ATTACHMENTS: value })).toBe(true);
    for (const value of [undefined, "", "false", "0", "no", "2gb"]) expect(largeVideoAttachmentsOptedIn({ PAPERCLIP_LARGE_VIDEO_ATTACHMENTS: value })).toBe(false);
  });

  it("keeps the ordinary limit for every file when the operator has not opted in, even with Media Studio on", async () => {
    delete process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS;
    const db = fakeDb([mediaStudioOn]);
    expect(await companyFileLimits(db, "company-1", company, { kind: "upload" })).toEqual(ordinary);
    expect(maxBytesForContentType("video/mp4", ordinary)).toBe(10 * MB);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("keeps the ordinary limit for a company without Media Studio, even when the operator opted in", async () => {
    process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
    // No Media Studio settings row: the company never set Media Studio up (or the plugin is not installed).
    expect(await companyFileLimits(fakeDb([]), "company-1", company, { kind: "upload" })).toEqual(ordinary);
    // Installed but switched off on this server, or switched off for this company.
    expect(await companyFileLimits(fakeDb([{ ...mediaStudioOn, status: "disabled" }]), "company-1", company, { kind: "upload" })).toEqual(ordinary);
    expect(await companyFileLimits(fakeDb([{ ...mediaStudioOn, status: "uninstalled" }]), "company-1", company, { kind: "upload" })).toEqual(ordinary);
    expect(await companyFileLimits(fakeDb([{ ...mediaStudioOn, enabled: false }]), "company-1", company, { kind: "upload" })).toEqual(ordinary);
  });

  it("gives videos the company's Media Studio limit, counted against its storage limit, when both allow it", async () => {
    process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
    const limits = await companyFileLimits(fakeDb([mediaStudioOn]), "company-1", company, { kind: "upload" });
    expect(limits).toEqual({ attachmentMaxBytes: 10 * MB, videoFileMaxBytes: 500 * MB, storageQuotaBytes: 10 * 1024 ** 3 });
    expect(maxBytesForContentType("video/mp4", limits)).toBe(500 * MB);
    // Every other kind of file keeps the ordinary limit.
    expect(maxBytesForContentType("application/zip", limits)).toBe(10 * MB);
    // Media Studio's defaults when its settings say nothing about it: 2 GB, 5 GB of storage.
    const defaults = await companyFileLimits(fakeDb([{ status: "ready", enabled: true, settingsJson: {} }]), "company-1", company, { kind: "upload" });
    expect(defaults).toMatchObject({ videoFileMaxBytes: MEDIA_VIDEO_FILE_DEFAULT_MAX_BYTES, storageQuotaBytes: MEDIA_FOOTAGE_DEFAULTS.storageQuotaBytes });
  });

  it("lets only Media Studio itself save large videos through the plugin host", async () => {
    process.env.PAPERCLIP_LARGE_VIDEO_ATTACHMENTS = "true";
    const db = fakeDb([mediaStudioOn]);
    expect(await companyFileLimits(db, "company-1", company, { kind: "plugin", pluginKey: "some-other-plugin" })).toEqual(ordinary);
    expect(db.select).not.toHaveBeenCalled();
    expect(await companyFileLimits(db, "company-1", company, { kind: "plugin", pluginKey: MEDIA_STUDIO_PLUGIN_KEY })).toMatchObject({ videoFileMaxBytes: 500 * MB });
  });
});

describe("D18 security review F3: a large video must really be a video (ffprobe on the local file)", () => {
  const exec = promisify(execFile);
  const previousWorkDir = process.env.PAPERCLIP_MEDIA_WORK_DIR;
  const previousFfprobe = process.env.PAPERCLIP_FFPROBE_PATH;
  afterEach(() => {
    if (previousWorkDir === undefined) delete process.env.PAPERCLIP_MEDIA_WORK_DIR;
    else process.env.PAPERCLIP_MEDIA_WORK_DIR = previousWorkDir;
    if (previousFfprobe === undefined) delete process.env.PAPERCLIP_FFPROBE_PATH;
    else process.env.PAPERCLIP_FFPROBE_PATH = previousFfprobe;
  });

  it("refuses a fake container that passes the 4-byte sniff, a non-video and a missing file (with or without ffprobe on this host)", async () => {
    const dir = await tempDir("paperclip-d18-probe-");
    const fake = path.join(dir, "fake.mp4");
    await fs.writeFile(fake, fakeContainer(64 * 1024));
    const text = path.join(dir, "notes.mp4");
    await fs.writeFile(text, Buffer.alloc(4096, "x"));
    expect(await verifyVideoFile(fake)).toBe(false);
    expect(await verifyVideoFile(text)).toBe(false);
    expect(await verifyVideoFile(path.join(dir, "missing.mp4"))).toBe(false);
  });

  /** A stand-in ffprobe that records how it was run and answers as told. */
  async function fakeFfprobe(dir: string, script: string): Promise<{ bin: string; argsFile: string }> {
    const bin = path.join(dir, "ffprobe");
    const argsFile = path.join(dir, "args.txt");
    await fs.writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n${script}\n`, { mode: 0o755 });
    return { bin, argsFile };
  }
  async function loadVerifier(bin: string) {
    process.env.PAPERCLIP_FFPROBE_PATH = bin;
    vi.resetModules();
    try {
      return (await import("../services/video-ffmpeg.js")).verifyVideoFile;
    } finally {
      vi.resetModules();
    }
  }
  const videoJson = JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "30/1", avg_frame_rate: "30/1" }], format: { duration: "12.5" } });
  const audioOnlyJson = JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "12.5" } });

  it("asks ffprobe to read the local file only, as the sniffed container, and accepts it only with a picture stream", async () => {
    const dir = await tempDir("paperclip-d18-fakeprobe-");
    const file = path.join(dir, "film.mp4");
    await fs.writeFile(file, fakeMp4(4096));

    const accepting = await fakeFfprobe(dir, `echo '${videoJson}'`);
    expect(await (await loadVerifier(accepting.bin))(file)).toBe(true);
    const args = (await fs.readFile(accepting.argsFile, "utf8")).trim().split("\n");
    expect(args).toEqual(["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-show_streams", "-show_format", "-of", "json", file]);

    const audioOnly = await fakeFfprobe(dir, `echo '${audioOnlyJson}'`);
    expect(await (await loadVerifier(audioOnly.bin))(file)).toBe(false);

    const failing = await fakeFfprobe(dir, "echo 'moov atom not found' >&2; exit 1");
    expect(await (await loadVerifier(failing.bin))(file)).toBe(false);

    const garbage = await fakeFfprobe(dir, "echo 'not json'");
    expect(await (await loadVerifier(garbage.bin))(file)).toBe(false);
  });

  it("refuses the file when ffprobe runs out of time, or is not installed", async () => {
    const dir = await tempDir("paperclip-d18-slowprobe-");
    const file = path.join(dir, "film.mp4");
    await fs.writeFile(file, fakeMp4(4096));
    const slow = await fakeFfprobe(dir, `sleep 5; echo '${videoJson}'`);
    const verify = await loadVerifier(slow.bin);
    const started = Date.now();
    expect(await verify(file, { timeoutMs: 300 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);

    const missing = await loadVerifier(path.join(dir, "no-such-ffprobe"));
    expect(await missing(file)).toBe(false);
  });

  it("checks a video held in memory from a work file that is removed again; a non-video is refused without writing anything", async () => {
    const workDir = await tempDir("paperclip-d18-bufferprobe-");
    process.env.PAPERCLIP_MEDIA_WORK_DIR = workDir;
    const seen: string[] = [];
    const verify = async (filePath: string) => {
      seen.push(filePath);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      return false;
    };
    expect(await verifyVideoBuffer(Buffer.alloc(4096, "x"), verify)).toBe(false);
    expect(seen).toEqual([]);
    expect(await verifyVideoBuffer(fakeContainer(4096), verify)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0]!)).toBe(workDir);
    expect(await fs.readdir(workDir)).toEqual([]);
    // With the real check, the fake container is refused too.
    expect(await verifyVideoBuffer(fakeContainer(4096))).toBe(false);
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  (hasFfmpeg ? it : it.skip)("accepts a real MP4 and a real WebM (needs ffmpeg on this host)", async () => {
    const dir = await tempDir("paperclip-d18-realprobe-");
    const mp4 = path.join(dir, "real.mp4");
    const webm = path.join(dir, "real.webm");
    const source = ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5"];
    await exec("ffmpeg", [...source, "-pix_fmt", "yuv420p", mp4]);
    await exec("ffmpeg", [...source, "-c:v", "libvpx", "-b:v", "100k", webm]).catch(() => undefined);
    expect(await verifyVideoFile(mp4)).toBe(true);
    // This ffmpeg may be built without a WebM encoder; check WebM only when it made one.
    const hasWebm = await fs.stat(webm).then(() => true, () => false);
    if (hasWebm) expect(await verifyVideoFile(webm)).toBe(true);
    process.env.PAPERCLIP_MEDIA_WORK_DIR = dir;
    expect(await verifyVideoBuffer(await fs.readFile(mp4))).toBe(true);
    // The work file made for the check is gone again.
    expect((await fs.readdir(dir)).sort()).toEqual(hasWebm ? ["real.mp4", "real.webm"] : ["real.mp4"]);
  });
});
