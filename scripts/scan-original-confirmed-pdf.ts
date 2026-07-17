import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export type ConfirmedMapping = {
  currentToken: string;
  genuineToken: string;
};

export type ScanComparisonPdfMetadata = {
  title: string;
  creator: string;
  subject: string;
  label: string;
};

export type ConfirmedPdfOptions = {
  outputDirectory: string;
  pdfPath?: string;
  projectRoot?: string;
};

export type ConfirmedPdfAggregate = {
  schemaVersion: 1;
  confirmedMappings: number;
  comparisonsPerPage: 2;
  pages: number;
  pdfBytes: number;
  pdfSha256: string;
  reportSha256: string;
  activationAuthorized: false;
};

function isWithin(path: string, root: string): boolean {
  const absolute = resolve(path);
  const base = resolve(root);
  return absolute === base || absolute.startsWith(`${base}${sep}`);
}

function pdfString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function writeScanComparisonPdf(
  path: string,
  mappings: ConfirmedMapping[],
  reviewDirectory: string,
  metadata: ScanComparisonPdfMetadata = {
    title: "Confirmed scan-original comparisons",
    creator: "Music Library local recovery review",
    subject: `${mappings.length} owner-confirmed mappings; visual review only`,
    label: "Confirmed comparisons",
  },
): Promise<number> {
  const comparisonsPerPage = 2;
  const pageCount = Math.ceil(mappings.length / comparisonsPerPage);
  const objectCount = 4 + pageCount * 4;
  const offsets = new Array<number>(objectCount + 1).fill(0);
  const handle = await open(path, "wx", 0o600);
  let position = 0;
  const write = async (contents: string | Buffer): Promise<void> => {
    const bytes = typeof contents === "string" ? Buffer.from(contents, "binary") : contents;
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, position);
      offset += result.bytesWritten;
      position += result.bytesWritten;
    }
  };
  const object = async (number: number, contents: string | Buffer): Promise<void> => {
    offsets[number] = position;
    await write(`${number} 0 obj\n`);
    await write(contents);
    await write("\nendobj\n");
  };
  try {
    await write(Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary"));
    await object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const pageObjects = Array.from({ length: pageCount }, (_, index) => 5 + index * 4);
    await object(2, `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] >>`);
    await object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    await object(4, `<< /Title (${pdfString(metadata.title)}) /Creator (${pdfString(metadata.creator)}) /Subject (${pdfString(metadata.subject)}) >>`);
    const pageWidth = 841.89;
    const pageHeight = 595.28;
    const imageHeight = 267.5;
    const imageWidth = 535;
    const imageX = (pageWidth - imageWidth) / 2;
    const imageY = [302.78, 20];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageObject = 5 + pageIndex * 4;
      const contentObject = pageObject + 1;
      const imageObjects = [pageObject + 2, pageObject + 3];
      const pageMappings = mappings.slice(pageIndex * comparisonsPerPage, pageIndex * comparisonsPerPage + comparisonsPerPage);
      const resources = pageMappings.map((_, index) => `/Im${index + 1} ${imageObjects[index]} 0 R`).join(" ");
      await object(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> /XObject << ${resources} >> >> /Contents ${contentObject} 0 R >>`);
      const first = pageIndex * comparisonsPerPage + 1;
      const last = first + pageMappings.length - 1;
      const label = `${metadata.label} ${first}-${last} of ${mappings.length}  |  Page ${pageIndex + 1} of ${pageCount}`;
      const drawing = [
        "BT /F1 9 Tf 20 578 Td",
        `(${pdfString(label)}) Tj ET`,
        ...pageMappings.flatMap((_, index) => [
          "q",
          `${imageWidth} 0 0 ${imageHeight} ${imageX.toFixed(2)} ${imageY[index].toFixed(2)} cm`,
          `/Im${index + 1} Do`,
          "Q",
        ]),
      ].join("\n");
      const contentBytes = Buffer.from(`${drawing}\n`, "ascii");
      await object(contentObject, Buffer.concat([
        Buffer.from(`<< /Length ${contentBytes.length} >>\nstream\n`, "ascii"),
        contentBytes,
        Buffer.from("endstream", "ascii"),
      ]));
      for (let index = 0; index < pageMappings.length; index += 1) {
        const token = pageMappings[index].currentToken;
        if (!/^current-\d{4}$/u.test(token)) throw new Error("invalid_confirmed_token");
        const bytes = await readFile(resolve(reviewDirectory, `${token}.jpg`));
        const metadata = await sharp(bytes).metadata();
        if (!metadata.width || !metadata.height || metadata.format !== "jpeg" || metadata.channels !== 3) {
          throw new Error("invalid_review_aid");
        }
        await object(imageObjects[index], Buffer.concat([
          Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${metadata.width} /Height ${metadata.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`, "ascii"),
          bytes,
          Buffer.from("\nendstream", "ascii"),
        ]));
      }
      if (pageMappings.length < comparisonsPerPage) {
        await object(imageObjects[1], "<< /Length 0 >>\nstream\n\nendstream");
      }
    }
    const xrefPosition = position;
    await write(`xref\n0 ${objectCount + 1}\n`);
    await write("0000000000 65535 f \n");
    for (let number = 1; number <= objectCount; number += 1) {
      await write(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
    }
    await write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return pageCount;
}

export async function generateConfirmedPdf(options: ConfirmedPdfOptions): Promise<ConfirmedPdfAggregate> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const outputDirectory = resolve(options.outputDirectory);
  const pdfPath = resolve(options.pdfPath ?? resolve(outputDirectory, "confirmed-final-review.pdf"));
  if (!isWithin(outputDirectory, resolve(projectRoot, "notes/private"))
    || !isWithin(pdfPath, resolve(projectRoot, "notes/private"))) {
    throw new Error("pdf_output_must_be_private");
  }
  const [reportBytes, confirmationBytes] = await Promise.all([
    readFile(resolve(outputDirectory, "match-report.json")),
    readFile(resolve(outputDirectory, "owner-confirmed-matches.json")),
  ]);
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const report = JSON.parse(reportBytes.toString("utf8")) as {
    decisions: Array<{ currentToken: string; genuineToken: string | null }>;
  };
  const confirmation = JSON.parse(confirmationBytes.toString("utf8")) as {
    schemaVersion: number;
    reportSha256: string;
    counts: { combinedConfirmed: number };
    confirmedMappings: ConfirmedMapping[];
    invariants: { activationAuthorized: boolean };
  };
  if (confirmation.schemaVersion !== 1 || confirmation.reportSha256 !== reportSha256
    || confirmation.counts.combinedConfirmed !== confirmation.confirmedMappings.length
    || confirmation.invariants.activationAuthorized !== false) {
    throw new Error("confirmed_pdf_binding_mismatch");
  }
  const byCurrent = new Map(report.decisions.map((decision) => [decision.currentToken, decision.genuineToken]));
  if (new Set(confirmation.confirmedMappings.map((item) => item.currentToken)).size
    !== confirmation.confirmedMappings.length) {
    throw new Error("confirmed_pdf_duplicate_current");
  }
  for (const mapping of confirmation.confirmedMappings) {
    if (byCurrent.get(mapping.currentToken) !== mapping.genuineToken) {
      throw new Error("confirmed_pdf_mapping_mismatch");
    }
  }
  await mkdir(dirname(pdfPath), { recursive: true });
  const temporary = `${pdfPath}.${process.pid}.temporary`;
  try {
    const pages = await writeScanComparisonPdf(
      temporary,
      confirmation.confirmedMappings,
      resolve(outputDirectory, "review"),
    );
    await rename(temporary, pdfPath);
    const [pdfStats, pdfSha256] = await Promise.all([stat(pdfPath), sha256File(pdfPath)]);
    return {
      schemaVersion: 1,
      confirmedMappings: confirmation.confirmedMappings.length,
      comparisonsPerPage: 2,
      pages,
      pdfBytes: pdfStats.size,
      pdfSha256,
      reportSha256,
      activationAuthorized: false,
    };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const aggregate = await generateConfirmedPdf({
    outputDirectory: resolve("notes/private/scan-original-recovery"),
  });
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;
if (isDirectRun) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "unexpected_error";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
