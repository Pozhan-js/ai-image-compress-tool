export type CompressionMode = 'smart' | 'high-quality' | 'balanced' | 'high-compress' | 'custom';

export interface UploadItem {
  id: string;
  name: string;
  sizeLabel: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  previewUrl?: string;
}

export interface CompressionStats {
  originalSize: string;
  compressedSize: string;
  ratio: string;
  duration: string;
}

export interface HistoryRecord {
  id: string;
  name: string;
  sizeLabel: string;
  createdAt: string;
}
