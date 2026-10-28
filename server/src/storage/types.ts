import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { Readable } from "node:stream";

export interface PutObjectInput {
  objectKey: string;
  /** A Buffer, or a stream of exactly contentLength bytes (a large file is never held in memory). */
  body: Buffer | Readable;
  contentType: string;
  contentLength: number;
}

export interface GetObjectInput {
  objectKey: string;
  range?: {
    start: number;
    end: number;
  };
}

export interface GetObjectResult {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface HeadObjectResult {
  exists: boolean;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface StorageProvider {
  id: StorageProviderId;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(input: GetObjectInput): Promise<GetObjectResult>;
  headObject(input: GetObjectInput): Promise<HeadObjectResult>;
  deleteObject(input: GetObjectInput): Promise<void>;
}

export interface PutFileInput {
  companyId: string;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
  body: Buffer;
}

/**
 * D18: a file already on the server's disk (an ffmpeg output, an upload
 * spooled to a temp file) is streamed into storage instead of being read
 * into memory first. The source file is left in place; the caller removes it.
 */
export interface PutFileFromPathInput {
  companyId: string;
  namespace: string;
  originalFilename: string | null;
  contentType: string;
  filePath: string;
  /** Refuse, before anything is stored, a file larger than this many bytes. */
  maxBytes?: number;
}

export interface PutFileResult {
  provider: StorageProviderId;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
}

export interface StorageService {
  provider: StorageProviderId;
  putFile(input: PutFileInput): Promise<PutFileResult>;
  /** Streams a file from the server's disk into storage (hashed on the way), never holding it whole in memory. */
  putFileFromPath(input: PutFileFromPathInput): Promise<PutFileResult>;
  getObject(companyId: string, objectKey: string, options?: Pick<GetObjectInput, "range">): Promise<GetObjectResult>;
  headObject(companyId: string, objectKey: string): Promise<HeadObjectResult>;
  deleteObject(companyId: string, objectKey: string): Promise<void>;
  /** Writes a derived object (e.g. a thumbnail) at a caller-chosen key inside the company prefix. */
  putObjectAt?(companyId: string, objectKey: string, body: Buffer, contentType: string): Promise<void>;
}
