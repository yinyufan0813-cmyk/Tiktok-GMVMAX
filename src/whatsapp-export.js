import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"]);

main().catch((error) => {
  console.error(`[WhatsApp Export] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printHelp();
    return;
  }

  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output || "./whatsapp-export-output");
  const imageMode = args.imageMode || "ocr";

  await fs.mkdir(outputDir, { recursive: true });

  const workDir = path.join(outputDir, ".work");
  await fs.mkdir(workDir, { recursive: true });

  const exports = await discoverExports(inputDir, workDir);
  if (exports.length === 0) {
    throw new Error(`No WhatsApp export .zip, folder, or .txt files found in ${inputDir}`);
  }

  const canOcr = imageMode === "ocr" && (await commandExists("tesseract"));
  const chats = [];

  for (const item of exports) {
    console.log(`[WhatsApp Export] Reading ${item.name}`);
    const chat = await parseChatExport(item, { imageMode, canOcr });
    chats.push(chat);
  }

  const result = {
    exportedAt: new Date().toISOString(),
    inputDir,
    imageMode,
    imageRecognition: imageMode === "ocr" ? (canOcr ? "tesseract" : "unavailable") : "disabled",
    chats
  };

  const jsonPath = path.join(outputDir, "whatsapp-groups.json");
  const csvPath = path.join(outputDir, "whatsapp-messages.csv");

  await fs.writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, toCsv(chats), "utf8");

  console.log(`[WhatsApp Export] Wrote ${jsonPath}`);
  console.log(`[WhatsApp Export] Wrote ${csvPath}`);
  if (imageMode === "ocr" && !canOcr) {
    console.log("[WhatsApp Export] Image OCR skipped because tesseract is not installed or not in PATH.");
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--input" || arg === "-i") args.input = argv[++index];
    else if (arg === "--output" || arg === "-o") args.output = argv[++index];
    else if (arg === "--image-mode") args.imageMode = argv[++index];
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run whatsapp-export -- --input ./exports --output ./whatsapp-export-output

Options:
  -i, --input        Directory containing WhatsApp exported .zip files, folders, or .txt files
  -o, --output       Output directory. Default: ./whatsapp-export-output
  --image-mode      ocr or none. Default: ocr

Notes:
  Export each WhatsApp group chat with media from WhatsApp first, then place all export ZIPs here.
  Image OCR uses the local "tesseract" command when available.
`);
}

async function discoverExports(inputDir, workDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const exports = [];

  for (const entry of entries) {
    const fullPath = path.join(inputDir, entry.name);
    if (entry.isDirectory()) {
      exports.push({ name: entry.name, root: fullPath });
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
      const target = path.join(workDir, sanitizeName(entry.name.replace(/\.zip$/i, "")));
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      await execFileAsync("unzip", ["-qq", fullPath, "-d", target]);
      exports.push({ name: entry.name, root: target });
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      exports.push({ name: entry.name, root: inputDir, chatFile: fullPath });
    }
  }

  return exports;
}

async function parseChatExport(item, options) {
  const files = await listFiles(item.root);
  const chatFile = item.chatFile || files.find((file) => path.basename(file).toLowerCase() === "_chat.txt") || files.find((file) => file.toLowerCase().endsWith(".txt"));
  if (!chatFile) {
    throw new Error(`No chat .txt file found in ${item.name}`);
  }

  const mediaFiles = new Map();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      mediaFiles.set(path.basename(file), file);
    }
  }

  const text = await fs.readFile(chatFile, "utf8");
  const messages = parseMessages(text);

  for (const message of messages) {
    const imageNames = findReferencedImages(message.text, mediaFiles);
    message.images = [];

    for (const imageName of imageNames) {
      const imagePath = mediaFiles.get(imageName);
      const image = {
        fileName: imageName,
        path: imagePath,
        text: "",
        status: "not_processed"
      };

      if (options.imageMode === "ocr" && options.canOcr) {
        const ocr = await readImageText(imagePath);
        image.text = ocr.text;
        image.status = ocr.status;
      } else if (options.imageMode === "ocr") {
        image.status = "ocr_unavailable";
      } else {
        image.status = "disabled";
      }

      message.images.push(image);
    }
  }

  return {
    name: deriveChatName(item, chatFile),
    source: item.name,
    chatFile,
    messageCount: messages.length,
    imageCount: messages.reduce((sum, message) => sum + message.images.length, 0),
    messages
  };
}

async function listFiles(root) {
  const result = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

function parseMessages(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const messages = [];
  let current = null;

  for (const line of lines) {
    const parsed = parseMessageStart(line);
    if (parsed) {
      if (current) messages.push(current);
      current = {
        timestamp: parsed.timestamp,
        sender: parsed.sender,
        text: parsed.text,
        images: []
      };
    } else if (current && line.trim()) {
      current.text += `\n${line}`;
    }
  }

  if (current) messages.push(current);
  return messages;
}

function parseMessageStart(line) {
  const patterns = [
    /^\[(?<date>.+?),\s(?<time>.+?)\]\s(?:(?<sender>.*?):\s)?(?<text>.*)$/,
    /^(?<date>\d{1,4}[/-]\d{1,2}[/-]\d{1,4}),\s(?<time>.+?)\s-\s(?:(?<sender>.*?):\s)?(?<text>.*)$/
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.groups) {
      return {
        timestamp: `${match.groups.date}, ${match.groups.time}`,
        sender: match.groups.sender || "system",
        text: match.groups.text || ""
      };
    }
  }

  return null;
}

function findReferencedImages(text, mediaFiles) {
  const found = new Set();
  for (const fileName of mediaFiles.keys()) {
    if (text.includes(fileName)) found.add(fileName);
  }

  const attachedMatches = text.matchAll(/<attached:\s*([^>]+)>/gi);
  for (const match of attachedMatches) {
    const fileName = path.basename(match[1].trim());
    if (mediaFiles.has(fileName)) found.add(fileName);
  }

  return [...found];
}

async function readImageText(imagePath) {
  try {
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng+chi_sim+chi_tra"], {
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      status: "ok",
      text: stdout.trim()
    };
  } catch (error) {
    return {
      status: `ocr_failed: ${error.message}`,
      text: ""
    };
  }
}

async function commandExists(command) {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

function deriveChatName(item, chatFile) {
  const base = path.basename(item.name).replace(/\.(zip|txt)$/i, "");
  if (base && base !== "_chat") return base;
  return path.basename(path.dirname(chatFile));
}

function sanitizeName(value) {
  return value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "export";
}

function toCsv(chats) {
  const rows = [["chat", "timestamp", "sender", "message", "image_files", "image_text"]];
  for (const chat of chats) {
    for (const message of chat.messages) {
      rows.push([
        chat.name,
        message.timestamp,
        message.sender,
        message.text,
        message.images.map((image) => image.fileName).join("; "),
        message.images.map((image) => image.text).filter(Boolean).join("\n---\n")
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const normalized = String(value ?? "").replace(/\r?\n/g, "\n");
  return `"${normalized.replace(/"/g, '""')}"`;
}
