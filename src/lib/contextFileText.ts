/**
 * Text extraction for interview context files. Plain text and code are read as
 * they are; PDF and Word (.docx) are decoded locally — nothing is uploaded to
 * extract the text.
 */

export type ContextFileKind = "text" | "pdf" | "docx" | "unsupported";

const TEXT_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "ini",
  "env",
  "toml",
  "sql",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "swift",
  "scala",
  "dart",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "gradle",
  "dockerfile",
];

/** Formats that look like documents but cannot be read without conversion. */
const KNOWN_UNREADABLE_EXTENSIONS: Record<string, string> = {
  doc: "старый формат Word (.doc) — пересохраните как .docx или .pdf",
  rtf: "формат .rtf не поддерживается — сохраните как .docx или .pdf",
  pages: "формат Pages не поддерживается — экспортируйте в .pdf или .docx",
  odt: "формат .odt не поддерживается — сохраните как .docx или .pdf",
  key: "формат Keynote не поддерживается — экспортируйте в .pdf",
  ppt: "презентации не поддерживаются — экспортируйте в .pdf",
  pptx: "презентации не поддерживаются — экспортируйте в .pdf",
  xls: "таблицы не поддерживаются — сохраните как .csv",
  xlsx: "таблицы не поддерживаются — сохраните как .csv",
};

export const CONTEXT_FILE_ACCEPT = [
  ".pdf",
  ".docx",
  ...TEXT_EXTENSIONS.map((extension) => `.${extension}`),
].join(",");

/** Documents are heavier than source files, so they get their own size budget. */
export const CONTEXT_FILE_MAX_TEXT_BYTES = 512 * 1024;
export const CONTEXT_FILE_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Extracted text is capped so one long PDF cannot eat the whole prompt. */
export const CONTEXT_FILE_MAX_CHARS = 60000;

export function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === name.length - 1) {
    return "";
  }
  return name.slice(dotIndex + 1).toLowerCase();
}

export function classifyContextFile(file: File): ContextFileKind {
  const extension = getFileExtension(file.name);
  if (extension === "pdf" || file.type === "application/pdf") {
    return "pdf";
  }
  if (
    extension === "docx" ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (TEXT_EXTENSIONS.includes(extension)) {
    return "text";
  }
  if (extension in KNOWN_UNREADABLE_EXTENSIONS) {
    return "unsupported";
  }
  // Unknown extension but a text-ish mime type (e.g. a Dockerfile without one).
  return file.type.startsWith("text/") || file.type === "" ? "text" : "unsupported";
}

export function describeUnsupportedFile(file: File): string {
  const extension = getFileExtension(file.name);
  return KNOWN_UNREADABLE_EXTENSIONS[extension] ?? "формат не поддерживается";
}

export function maxBytesForKind(kind: ContextFileKind): number {
  return kind === "text" ? CONTEXT_FILE_MAX_TEXT_BYTES : CONTEXT_FILE_MAX_DOCUMENT_BYTES;
}

export async function extractContextFileText(
  file: File,
  kind: ContextFileKind = classifyContextFile(file),
): Promise<string> {
  switch (kind) {
    case "pdf":
      return normalize(await extractPdfText(file));
    case "docx":
      return normalize(await extractDocxText(file));
    case "text":
      return normalize(await readAsText(file));
    default:
      throw new Error(describeUnsupportedFile(file));
  }
}

function normalize(text: string): string {
  const collapsed = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return collapsed.length > CONTEXT_FILE_MAX_CHARS
    ? `${collapsed.slice(0, CONTEXT_FILE_MAX_CHARS)}\n\n[...текст обрезан]`
    : collapsed;
}

async function readAsText(file: File): Promise<string> {
  const text = await file.text();
  // A renamed binary reads as text without throwing; NUL bytes are the giveaway.
  if (text.includes(String.fromCharCode(0))) {
    throw new Error("файл не является текстом");
  }
  return text;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }
        pageText += item.str;
        if (item.hasEOL) {
          pageText += "\n";
        }
      }
      page.cleanup();
      const trimmed = pageText.trim();
      if (trimmed) {
        pages.push(trimmed);
      }
      if (pages.join("\n\n").length > CONTEXT_FILE_MAX_CHARS) {
        break;
      }
    }

    if (pages.length === 0) {
      throw new Error("в PDF нет текстового слоя (похоже на скан)");
    }
    return pages.join("\n\n");
  } finally {
    await document.destroy();
  }
}

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

/**
 * Loads the legacy pdf.js build lazily: it targets older engines than the
 * default one, and the module is only worth downloading when a PDF shows up.
 */
function loadPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfJsPromise) {
    pdfJsPromise = (async () => {
      const [pdfjs, worker] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<typeof import("pdfjs-dist")>,
        import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfJsPromise;
}

async function extractDocxText(file: File): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => entry.name === "word/document.xml",
  });
  const documentXml = zip["word/document.xml"];
  if (!documentXml) {
    throw new Error("не похоже на .docx");
  }
  const text = wordXmlToText(strFromU8(documentXml));
  if (!text.trim()) {
    throw new Error("документ пустой");
  }
  return text;
}

/**
 * Turns WordprocessingML into plain text: paragraphs and line breaks become
 * newlines, everything else is dropped. Enough for a résumé or a job posting.
 */
function wordXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}
