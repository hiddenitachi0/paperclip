import { describe, expect, it } from "vitest";
import { bufferSource, listZipEntries, readLines, readZipEntry, ZipFormatError } from "../services/trading-candle-zip.js";
import { buildZip } from "./helpers/zip-fixture.js";

async function readAll(zip: Buffer, name: string): Promise<string> {
  const source = bufferSource(zip);
  const entry = (await listZipEntries(source)).find((e) => e.name === name)!;
  const chunks: Buffer[] = [];
  for await (const chunk of readZipEntry(source, entry)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("trading candle zip reader (DUR-5007)", () => {
  const csv = Array.from({ length: 5000 }, (_, i) => `${1700000000 + i * 3600},1,2,0.5,1.5,10,3`).join("\n") + "\n";

  it("lists and reads deflated and stored entries", async () => {
    const zip = buildZip([
      { name: "XBTUSD_60.csv", data: csv },
      { name: "nested/ETHUSD_60.csv", data: "a,b\n", method: 0 },
    ]);
    const entries = await listZipEntries(bufferSource(zip));
    expect(entries.map((e) => e.name)).toEqual(["XBTUSD_60.csv", "nested/ETHUSD_60.csv"]);
    expect(await readAll(zip, "XBTUSD_60.csv")).toBe(csv);
    expect(await readAll(zip, "nested/ETHUSD_60.csv")).toBe("a,b\n");
  });

  it("reads archives that use ZIP64 end records", async () => {
    const zip = buildZip([{ name: "a.csv", data: "1,2\n3,4\n" }], { zip64: true });
    expect(await readAll(zip, "a.csv")).toBe("1,2\n3,4\n");
  });

  it("refuses a download that was altered (checksum) or cut short", async () => {
    const zip = buildZip([{ name: "a.csv", data: "hello,world\n", method: 0 }]);
    const tampered = Buffer.from(zip);
    tampered[30 + "a.csv".length] ^= 0xff;
    await expect(readAll(tampered, "a.csv")).rejects.toThrow(/checksum/);
    await expect(listZipEntries(bufferSource(zip.subarray(0, zip.length - 30)))).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("refuses an entry that inflates to more than it declares", async () => {
    const zip = buildZip([{ name: "a.csv", data: "x".repeat(10_000) }]);
    const source = bufferSource(zip);
    const [entry] = await listZipEntries(source);
    const lying = { ...entry!, uncompressedSize: 100 };
    await expect(async () => {
      for await (const _chunk of readZipEntry(source, lying)) void _chunk;
    }).rejects.toThrow(/larger than it declares/);
  });

  it("splits lines across chunk boundaries, with or without a final newline and CRLF", async () => {
    async function* chunks() {
      yield Buffer.from("1,2\r\n3,");
      yield Buffer.from("4\n5,6");
    }
    const lines: string[] = [];
    for await (const line of readLines(chunks())) lines.push(line);
    expect(lines).toEqual(["1,2", "3,4", "5,6"]);
  });
});
