import cors from 'cors';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const app = express();
const port = Number(process.env.PORT || 3001);
const maxFileSizeBytes = 50 * 1024 * 1024;
const maxBatchCount = 100;
const gzipAsync = promisify(gzip);

type UploadedFileRecord = {
  id: string;
  name: string;
  mimeType: string;
  originalSizeBytes: number;
  buffer: Buffer;
  createdAt: string;
};

type CompressedFileRecord = {
  id: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  compressedSizeBytes: number;
  originalSizeBytes: number;
  ratio: string;
  durationMs: number;
  createdAt: string;
};

type TaskStatusRecord = {
  id: string;
  progress: number;
  completed: number;
  failed: number;
  queued: number;
  currentFile: string;
};

const uploadStore = new Map<string, UploadedFileRecord>();
const compressedStore = new Map<string, CompressedFileRecord>();
const taskStore = new Map<string, TaskStatusRecord>();

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/webp',
  'image/avif'
]);

function isModelFile(name: string) {
  return /\.(glb|glm)$/i.test(name);
}

function isGlbFile(name: string) {
  return /\.glb$/i.test(name);
}

function isImageMimeType(mimeType: string) {
  return allowedMimeTypes.has(mimeType);
}

function isAllowedUploadFile(file: Express.Multer.File, normalizedName: string) {
  return isImageMimeType(file.mimetype) || isModelFile(normalizedName);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: maxBatchCount,
    fileSize: maxFileSizeBytes
  }
});

function formatSizeLabel(sizeBytes: number) {
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)}KB`;
  }

  return `${(sizeBytes / 1024 / 1024).toFixed(1)}MB`;
}

function getOutputMime(format: string) {
  switch (format.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    default:
      return 'image/jpeg';
  }
}

function getOutputExtension(format: string) {
  switch (format.toLowerCase()) {
    case 'png':
      return 'png';
    case 'webp':
      return 'webp';
    case 'avif':
      return 'avif';
    default:
      return 'jpg';
  }
}

function mapModeToQuality(mode: string, fallbackQuality: number) {
  if (mode === '高质量') {
    return 90;
  }

  if (mode === '平衡') {
    return 80;
  }

  if (mode === '高压缩') {
    return 60;
  }

  return fallbackQuality;
}

function normalizeUploadedFileName(name: string) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const roundTrip = Buffer.from(decoded, 'utf8').toString('latin1');

  // Convert only when name clearly comes from UTF-8 bytes interpreted as latin1.
  if (roundTrip === name && !decoded.includes('\ufffd')) {
    return decoded;
  }

  return name;
}

function toAsciiFallbackFileName(name: string) {
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return fallback.length > 0 ? fallback : 'download.bin';
}

function buildContentDisposition(fileName: string) {
  const asciiFallback = toAsciiFallbackFileName(fileName);
  const encodedUtf8Name = encodeURIComponent(fileName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8Name}`;
}

async function compressGlbBuffer(inputBuffer: Buffer) {
  const gltfPipelineModule = await import('gltf-pipeline');
  const processGlb =
    (gltfPipelineModule as { processGlb?: (input: Uint8Array, options: unknown) => Promise<{ glb?: Uint8Array }> }).processGlb ??
    (
      gltfPipelineModule as {
        default?: { processGlb?: (input: Uint8Array, options: unknown) => Promise<{ glb?: Uint8Array }> };
      }
    ).default?.processGlb;

  if (!processGlb) {
    throw new Error('gltf-pipeline processGlb 不可用');
  }

  const optimized = await processGlb(inputBuffer, {
    dracoOptions: {
      compressionLevel: 10,
      quantizePositionBits: 14,
      quantizeNormalBits: 10,
      quantizeTexcoordBits: 12,
      quantizeColorBits: 8,
      quantizeGenericBits: 12
    }
  });

  if (!optimized.glb || optimized.glb.byteLength === 0) {
    throw new Error('gltf-pipeline 输出为空');
  }

  return Buffer.from(optimized.glb);
}

app.use(cors());
app.use(express.json());

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', service: 'api-server' });
});

app.get('/api/history', (_request, response) => {
  const items = Array.from(compressedStore.values())
    .slice(-20)
    .reverse()
    .map((item) => ({
      id: item.id,
      name: item.fileName,
      sizeLabel: formatSizeLabel(item.compressedSizeBytes),
      createdAt: item.createdAt
    }));

  response.json({ items });
});

app.post('/api/upload', upload.array('files', maxBatchCount), (request, response) => {
  const files = request.files as Express.Multer.File[];

  if (!files || files.length === 0) {
    response.status(400).json({ message: '请选择至少一个文件。' });
    return;
  }

  if (files.length > maxBatchCount) {
    response.status(400).json({ message: `单次最多上传 ${maxBatchCount} 张图片。` });
    return;
  }

  const invalidType = files.find((file) => {
    const normalizedName = normalizeUploadedFileName(file.originalname);
    return !isAllowedUploadFile(file, normalizedName);
  });
  if (invalidType) {
    response.status(400).json({ message: `不支持的格式: ${normalizeUploadedFileName(invalidType.originalname)}` });
    return;
  }

  const items = files.map((file) => {
    const fileId = crypto.randomUUID();
    const normalizedName = normalizeUploadedFileName(file.originalname);
    uploadStore.set(fileId, {
      id: fileId,
      name: normalizedName,
      mimeType: file.mimetype,
      originalSizeBytes: file.size,
      buffer: file.buffer,
      createdAt: new Date().toISOString()
    });

    return {
      id: fileId,
      name: normalizedName,
      sizeLabel: formatSizeLabel(file.size),
      status: 'queued'
    };
  });

  response.status(201).json({ items });
});

app.post('/api/compress', async (request, response) => {
  const { fileIds, mode, quality, format } = request.body as {
    fileIds?: string[];
    mode?: string;
    quality?: number;
    format?: string;
  };

  if (!fileIds || fileIds.length === 0) {
    response.status(400).json({ message: '缺少待压缩文件。' });
    return;
  }

  const uploadRecords = fileIds
    .map((fileId) => uploadStore.get(fileId))
    .filter((item): item is UploadedFileRecord => Boolean(item));

  if (uploadRecords.length === 0) {
    response.status(404).json({ message: '未找到可压缩文件。' });
    return;
  }

  const outputFormat = format ? format.toLowerCase() : 'jpg';
  const taskId = `task-${Date.now()}`;
  const taskState: TaskStatusRecord = {
    id: taskId,
    progress: 0,
    completed: 0,
    failed: 0,
    queued: uploadRecords.length,
    currentFile: uploadRecords[0]?.name ?? '-'
  };
  taskStore.set(taskId, taskState);

  const targetQuality = Math.max(1, Math.min(100, mapModeToQuality(mode ?? '平衡', quality ?? 80)));
  const resultItems: Array<{
    fileId: string;
    resultId: string;
    status: 'done' | 'failed';
    compressedSizeLabel: string;
    originalSizeLabel: string;
    ratio: string;
    durationMs: number;
  }> = [];

  for (const record of uploadRecords) {
    const startedAt = Date.now();
    taskState.currentFile = record.name;

    try {
      let outputBuffer: Buffer;
      let resultMimeType = getOutputMime(outputFormat);
      let resultFileName: string;

      if (isModelFile(record.name)) {
        if (isGlbFile(record.name)) {
          try {
            const optimizedGlb = await compressGlbBuffer(record.buffer);
            outputBuffer = optimizedGlb.byteLength < record.buffer.byteLength ? optimizedGlb : record.buffer;
            resultMimeType = 'model/gltf-binary';
            resultFileName = record.name;
          } catch {
            outputBuffer = await gzipAsync(record.buffer);
            resultMimeType = 'application/gzip';
            resultFileName = `${record.name}.gz`;
          }
        } else {
          outputBuffer = await gzipAsync(record.buffer);
          resultMimeType = 'application/gzip';
          resultFileName = `${record.name}.gz`;
        }
      } else {
        const pipeline = sharp(record.buffer, { animated: true, limitInputPixels: false });

        if (outputFormat === 'png') {
          outputBuffer = await pipeline.png({ quality: targetQuality }).toBuffer();
        } else if (outputFormat === 'webp') {
          outputBuffer = await pipeline.webp({ quality: targetQuality }).toBuffer();
        } else if (outputFormat === 'avif') {
          outputBuffer = await pipeline.avif({ quality: targetQuality }).toBuffer();
        } else {
          outputBuffer = await pipeline.jpeg({ quality: targetQuality, mozjpeg: true }).toBuffer();
        }

        const outputExt = getOutputExtension(outputFormat);
        const nameWithoutExt = record.name.replace(/\.[^.]+$/, '');
        resultFileName = `${nameWithoutExt}.${outputExt}`;
      }

      const resultId = crypto.randomUUID();
      const compressedSizeBytes = outputBuffer.byteLength;
      const ratio = `${Math.max(0, Math.round((1 - compressedSizeBytes / record.originalSizeBytes) * 100))}%`;
      const durationMs = Date.now() - startedAt;

      compressedStore.set(resultId, {
        id: resultId,
        fileId: record.id,
        fileName: resultFileName,
        mimeType: resultMimeType,
        buffer: outputBuffer,
        compressedSizeBytes,
        originalSizeBytes: record.originalSizeBytes,
        ratio,
        durationMs,
        createdAt: new Date().toISOString()
      });

      resultItems.push({
        fileId: record.id,
        resultId,
        status: 'done',
        compressedSizeLabel: formatSizeLabel(compressedSizeBytes),
        originalSizeLabel: formatSizeLabel(record.originalSizeBytes),
        ratio,
        durationMs
      });

      taskState.completed += 1;
      taskState.queued -= 1;
      taskState.progress = Math.round((taskState.completed / uploadRecords.length) * 100);
    } catch (_error) {
      resultItems.push({
        fileId: record.id,
        resultId: '',
        status: 'failed',
        compressedSizeLabel: '-',
        originalSizeLabel: formatSizeLabel(record.originalSizeBytes),
        ratio: '0%',
        durationMs: Date.now() - startedAt
      });

      taskState.failed += 1;
      taskState.queued -= 1;
      taskState.progress = Math.round(((taskState.completed + taskState.failed) / uploadRecords.length) * 100);
    }
  }

  taskState.currentFile = '-';
  taskState.progress = 100;
  taskStore.set(taskId, taskState);

  response.status(200).json({
    taskId,
    summary: taskState,
    items: resultItems
  });
});

app.get('/api/task/:id/status', (request, response) => {
  const task = taskStore.get(request.params.id);
  if (!task) {
    response.status(404).json({ message: '任务不存在。' });
    return;
  }

  response.json(task);
});

app.get('/api/file/:id/download', (request, response) => {
  const compressed = compressedStore.get(request.params.id);
  if (!compressed) {
    response.status(404).json({ message: '压缩结果不存在。' });
    return;
  }

  response.setHeader('Content-Type', compressed.mimeType);
  response.setHeader('Content-Disposition', buildContentDisposition(compressed.fileName));
  response.send(compressed.buffer);
});

app.get('/api/file/:id/content', (request, response) => {
  const compressed = compressedStore.get(request.params.id);
  if (!compressed) {
    response.status(404).json({ message: '压缩结果不存在。' });
    return;
  }

  response.setHeader('Content-Type', compressed.mimeType);
  response.send(compressed.buffer);
});

app.post('/api/export/zip', async (request, response) => {
  const body = request.body as { resultIds?: string[] };
  const requestedIds = body.resultIds ?? [];

  const records = (requestedIds.length > 0
    ? requestedIds.map((id) => compressedStore.get(id)).filter((item): item is CompressedFileRecord => Boolean(item))
    : Array.from(compressedStore.values())
  ).slice(0, 500);

  if (records.length === 0) {
    response.status(400).json({ message: '没有可导出的压缩结果。' });
    return;
  }

  const fileName = `compressed-${Date.now()}.zip`;
  response.setHeader('Content-Type', 'application/zip');
  response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const archive = archiver('zip', {
    zlib: { level: 9 }
  });

  archive.on('error', () => {
    if (!response.headersSent) {
      response.status(500).json({ message: '打包失败。' });
    }
  });

  archive.pipe(response);
  records.forEach((item) => {
    archive.append(item.buffer, { name: item.fileName });
  });

  await archive.finalize();
});

app.delete('/api/history/:id', (request, response) => {
  const deleted = compressedStore.delete(request.params.id);
  if (!deleted) {
    response.status(404).json({ message: '历史记录不存在。' });
    return;
  }

  response.status(204).send();
});

app.delete('/api/history', (_request, response) => {
  compressedStore.clear();
  response.status(204).send();
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      response.status(400).json({ message: '单张图片不能超过 50MB。' });
      return;
    }

    response.status(400).json({ message: error.message });
    return;
  }

  response.status(500).json({ message: '服务器内部错误。' });
});

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
