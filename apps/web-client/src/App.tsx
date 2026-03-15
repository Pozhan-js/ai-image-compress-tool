import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type PageKey = 'workspace' | 'history' | 'settings';
type CompressionMode = '智能' | '高质量' | '平衡' | '高压缩' | '自定义';

type UploadItem = {
  id: string;
  name: string;
  sizeLabel: string;
  status: '排队中' | '处理中' | '已完成' | '失败';
  previewUrl: string;
  resultId?: string;
  compressedPreviewUrl?: string;
  originalSizeLabel?: string;
  compressedSizeLabel?: string;
  ratio?: string;
  durationMs?: number;
};

type HistoryItem = {
  id: string;
  name: string;
  sizeLabel: string;
  createdAt: string;
};

const navItems: Array<{ key: PageKey; label: string }> = [
  { key: 'workspace', label: '上传' },
  { key: 'history', label: '历史记录' },
  { key: 'settings', label: '设置' }
];

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

function isImageLikeFile(name: string) {
  return /\.(jpg|jpeg|png|gif|bmp|tif|tiff|webp|avif)$/i.test(name);
}

function createMockPreview(label: string, tone: string) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${tone}" />
          <stop offset="100%" stop-color="#f2e7d8" />
        </linearGradient>
      </defs>
      <rect width="600" height="400" fill="url(#g)" rx="28" />
      <circle cx="120" cy="112" r="44" fill="rgba(255,255,255,0.38)" />
      <path d="M80 320L218 188L318 274L412 150L540 320Z" fill="rgba(27,23,18,0.28)" />
      <text x="48" y="356" fill="#1c1712" font-size="30" font-family="Arial, sans-serif">${label}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function App() {
  const [activePage, setActivePage] = useState<PageKey>('workspace');
  const [mode, setMode] = useState<CompressionMode>('平衡');
  const [quality, setQuality] = useState(80);
  const [format, setFormat] = useState('JPG');
  const [keepExif, setKeepExif] = useState(true);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [notice, setNotice] = useState('请先上传图片，再点击开始压缩。');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastStartClickRef = useRef(0);
  const objectUrlsRef = useRef<string[]>([]);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0],
    [items, selectedId]
  );

  const progress = useMemo(() => {
    if (items.length === 0) {
      return 0;
    }

    const done = items.filter((item) => item.status === '已完成' || item.status === '失败').length;
    return Math.round((done / items.length) * 100);
  }, [items]);

  const counts = useMemo(() => {
    return {
      success: items.filter((item) => item.status === '已完成').length,
      failed: items.filter((item) => item.status === '失败').length,
      queued: items.filter((item) => item.status === '排队中').length,
      processing: items.filter((item) => item.status === '处理中').length
    };
  }, [items]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!isPreviewOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPreviewOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPreviewOpen]);

  const fetchHistoryItems = async () => {
    setIsHistoryLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/history`);
      if (!response.ok) {
        throw new Error('历史记录加载失败。');
      }

      const data = (await response.json()) as {
        items: Array<{ id: string; name: string; sizeLabel: string; createdAt?: string }>;
      };

      setHistoryItems(
        data.items.map((item) => ({
          id: item.id,
          name: item.name,
          sizeLabel: item.sizeLabel,
          createdAt: item.createdAt ?? '-'
        }))
      );
    } catch (_error) {
      setHistoryItems([]);
      setNotice('历史记录加载失败，请稍后重试。');
    } finally {
      setIsHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (activePage === 'history') {
      void fetchHistoryItems();
    }
  }, [activePage]);

  const handleSelectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    if (files.length > 100) {
      setNotice('单次最多上传 100 张图片。');
      event.target.value = '';
      return;
    }

    const oversized = files.find((file) => file.size > 50 * 1024 * 1024);
    if (oversized) {
      setNotice(`文件 ${oversized.name} 超过 50MB，请重新选择。`);
      event.target.value = '';
      return;
    }

    setIsUploading(true);
    setNotice('上传中...');

    const previewMap = files.map((file) => ({
      name: file.name,
      previewUrl: URL.createObjectURL(file)
    }));

    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    try {
      const response = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ message: '上传失败，请重试。' }));
        throw new Error(data.message ?? '上传失败，请重试。');
      }

      const data = (await response.json()) as {
        items: Array<{ id: string; name: string; sizeLabel: string; status: string }>;
      };

      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = previewMap.map((item) => item.previewUrl);

      const uploadedItems: UploadItem[] = data.items.map((item, index) => ({
        id: item.id,
        name: item.name,
        sizeLabel: item.sizeLabel,
        status: '排队中',
        previewUrl: previewMap[index]?.previewUrl ?? createMockPreview(item.name, '#c3aa8f')
      }));

      setItems(uploadedItems);
      setSelectedId(uploadedItems[0]?.id ?? '');
      setNotice(`上传完成，共 ${uploadedItems.length} 张，点击“开始压缩”执行任务。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败，请重试。';
      setNotice(message);
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const handleStartCompression = async () => {
    const now = Date.now();
    if (now - lastStartClickRef.current < 600) {
      return;
    }
    lastStartClickRef.current = now;

    if (items.length === 0) {
      setNotice('请先上传图片。');
      return;
    }

    setIsCompressing(true);
    setNotice('压缩进行中，请稍候...');
    setItems((previous) => previous.map((item) => ({ ...item, status: '处理中' })));

    try {
      const response = await fetch(`${API_BASE}/api/compress`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fileIds: items.map((item) => item.id),
          mode,
          quality,
          format,
          keepExif
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ message: '压缩失败，请重试。' }));
        throw new Error(data.message ?? '压缩失败，请重试。');
      }

      const data = (await response.json()) as {
        taskId: string;
        items: Array<{
          fileId: string;
          resultId: string;
          status: 'done' | 'failed';
          compressedSizeLabel: string;
          originalSizeLabel: string;
          ratio: string;
          durationMs: number;
        }>;
      };

      const resultMap = new Map(data.items.map((item) => [item.fileId, item]));

      setItems((previous) =>
        previous.map((item) => {
          const result = resultMap.get(item.id);
          if (!result) {
            return { ...item, status: '失败' };
          }

          if (result.status === 'failed') {
            return {
              ...item,
              status: '失败',
              originalSizeLabel: result.originalSizeLabel,
              compressedSizeLabel: result.compressedSizeLabel,
              ratio: result.ratio,
              durationMs: result.durationMs
            };
          }

          return {
            ...item,
            status: '已完成',
            resultId: result.resultId,
            compressedPreviewUrl: `${API_BASE}/api/file/${result.resultId}/content?ts=${Date.now()}`,
            originalSizeLabel: result.originalSizeLabel,
            compressedSizeLabel: result.compressedSizeLabel,
            ratio: result.ratio,
            durationMs: result.durationMs
          };
        })
      );

      setNotice(`压缩完成，任务 ${data.taskId} 已结束。`);
      void fetchHistoryItems();
    } catch (error) {
      const message = error instanceof Error ? error.message : '压缩失败，请重试。';
      setNotice(message);
      setItems((previous) => previous.map((item) => ({ ...item, status: '失败' })));
    } finally {
      setIsCompressing(false);
    }
  };

  const handleDownloadSelected = () => {
    if (!selectedItem?.resultId) {
      setNotice('当前文件还没有压缩结果可下载。');
      return;
    }

    window.open(`${API_BASE}/api/file/${selectedItem.resultId}/download`, '_blank');
  };

  const handleDownloadAllZip = async () => {
    const resultIds = items.map((item) => item.resultId).filter((id): id is string => Boolean(id));
    if (resultIds.length === 0) {
      setNotice('暂无可导出的压缩结果。');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/export/zip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ resultIds })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({ message: '批量导出失败。' }));
        throw new Error(data.message ?? '批量导出失败。');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `compressed-${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice(`批量导出完成，共 ${resultIds.length} 张。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '批量导出失败，请稍后再试。';
      setNotice(message);
    }
  };

  const handleHistoryDownload = (id: string) => {
    window.open(`${API_BASE}/api/file/${id}/download`, '_blank');
  };

  const handleHistoryDelete = async (id: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/history/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('删除失败');
      }

      await fetchHistoryItems();
      setNotice('已删除一条历史记录。');
    } catch (_error) {
      setNotice('删除历史记录失败，请稍后再试。');
    }
  };

  const handleHistoryClear = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/history`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('清空失败');
      }

      await fetchHistoryItems();
      setNotice('历史记录已清空。');
    } catch (_error) {
      setNotice('清空历史记录失败，请稍后重试。');
    }
  };

  const handleRemoveItem = (id: string) => {
    setItems((previous) => {
      const next = previous.filter((item) => item.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id ?? '');
        if (next.length === 0) {
          setIsPreviewOpen(false);
        }
      }
      return next;
    });
    setNotice('已移除 1 个文件。');
  };

  return (
    <div className="app-shell">
      <div className="window-frame">
        <header className="title-bar">
          <div className="title-brand">
            <div className="logo-mark">AI</div>
            <div>
              <p className="brand-title">AI 图片压缩工具</p>
              <p className="brand-subtitle">本地处理 · 批量压缩 · 效果对比</p>
            </div>
          </div>
          <nav className="main-nav">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={item.key === activePage ? 'nav-button active' : 'nav-button'}
                onClick={() => setActivePage(item.key)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="window-actions">
            <button type="button">最小化</button>
            <button type="button">关闭</button>
          </div>
        </header>

        <main className="page-content">
          {activePage === 'workspace' ? (
            <section className="workspace-page">
              <div className="panel home-panel">
                <div className="drop-zone" onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0}>
                  <div className="drop-zone-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" role="img" focusable="false">
                      <path d="M12 15V5" />
                      <path d="m8 9 4-4 4 4" />
                      <path d="M4 15v4h16v-4" />
                    </svg>
                  </div>
                  <p className="drop-zone-title">拖拽文件到这里，或点击选择文件</p>
                  <p className="drop-zone-subtitle">支持格式：JPG/JPEG、PNG、WEBP、BMP、GLB，单文件大小限制：50MB</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.webp,.avif,.glb,.glm"
                  multiple
                  hidden
                  onChange={handleSelectFiles}
                />

                <p className="notice-bar">{notice}</p>

                <div className="table-panel">
                  <div className="file-table-head">
                    <span>文件名</span>
                    <span>原始大小</span>
                    <span>压缩后</span>
                    <span>状态</span>
                    <span>操作</span>
                  </div>
                  <div className="file-table-body">
                    {items.length === 0 ? (
                      <div className="file-table-empty">暂无文件，请先上传图片。</div>
                    ) : (
                      items.map((item) => (
                        <div key={item.id} className={item.id === selectedId ? 'file-table-row active' : 'file-table-row'}>
                          <span className="col-name" title={item.name}>{item.name}</span>
                          <span>{item.originalSizeLabel ?? item.sizeLabel}</span>
                          <span>{item.compressedSizeLabel ?? '--'}</span>
                          <span className={item.status === '已完成' ? 'status-success' : item.status === '失败' ? 'status-failed' : ''}>{item.status}</span>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => {
                                setSelectedId(item.id);
                                setIsPreviewOpen(true);
                              }}
                            >
                              预览
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => {
                                if (!item.resultId) {
                                  setNotice('该文件暂无可下载结果。');
                                  return;
                                }
                                window.open(`${API_BASE}/api/file/${item.resultId}/download`, '_blank');
                              }}
                            >
                              下载
                            </button>
                            <button type="button" className="link-button danger" onClick={() => handleRemoveItem(item.id)}>删除</button>
                          </div>
                          <div className="row-progress" aria-hidden="true" />
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="workspace-footer">
                  <div className="action-row compact-row">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={handleStartCompression}
                      disabled={isUploading || isCompressing || items.length === 0}
                    >
                      {isCompressing ? '压缩中...' : '开始压缩'}
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setShowAdvanced((value) => !value)}>
                      高级设置
                    </button>
                    <button type="button" className="ghost-button" onClick={() => void handleDownloadAllZip()}>
                      全部下载
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setItems([]);
                        setSelectedId('');
                        setNotice('列表已清空。');
                      }}
                      disabled={isCompressing || items.length === 0}
                    >
                      清空列表
                    </button>
                  </div>
                  <p className="summary-text">默认压缩质量：{quality}% · 格式：{format} · EXIF：{keepExif ? '保留' : '移除'}</p>
                </div>

                {showAdvanced ? (
                  <div className="advanced-panel">
                    <div className="mode-group">
                      {(['智能', '高质量', '平衡', '高压缩', '自定义'] as CompressionMode[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          className={item === mode ? 'chip active' : 'chip'}
                          onClick={() => setMode(item)}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="control-grid">
                      <label className="field">
                        <span>质量</span>
                        <input type="range" min="0" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
                        <strong>{quality}</strong>
                      </label>
                      <label className="field">
                        <span>格式</span>
                        <select value={format} onChange={(event) => setFormat(event.target.value)}>
                          <option>JPG</option>
                          <option>PNG</option>
                          <option>WEBP</option>
                          <option>AVIF</option>
                        </select>
                      </label>
                      <label className="checkbox-field">
                        <input type="checkbox" checked={keepExif} onChange={(event) => setKeepExif(event.target.checked)} />
                        <span>保留 EXIF</span>
                      </label>
                    </div>
                  </div>
                ) : null}

                {isPreviewOpen ? (
                  <div className="preview-modal-mask" onClick={() => setIsPreviewOpen(false)}>
                    <div className="preview-modal" onClick={(event) => event.stopPropagation()}>
                      <div className="preview-modal-head">
                        <strong>预览图片</strong>
                        <button type="button" className="ghost-button" onClick={() => setIsPreviewOpen(false)}>关闭</button>
                      </div>
                      {selectedItem ? (
                        <>
                          <p className="preview-file-name" title={selectedItem.name}>{selectedItem.name}</p>
                          <div className="preview-modal-grid">
                            <div className="preview-box">
                              <span>原图</span>
                              {isImageLikeFile(selectedItem.name) ? (
                                <img src={selectedItem.previewUrl} alt={selectedItem.name} />
                              ) : (
                                <div className="preview-empty">该文件类型不支持图片预览，请直接压缩或下载查看。</div>
                              )}
                            </div>
                            <div className="preview-box">
                              <span>压缩后</span>
                              {selectedItem.compressedPreviewUrl && isImageLikeFile(selectedItem.name) ? (
                                <img src={selectedItem.compressedPreviewUrl} alt={`${selectedItem.name} 压缩后`} />
                              ) : (
                                <div className="preview-empty">当前文件暂无可视化预览，可通过下载按钮查看结果。</div>
                              )}
                            </div>
                          </div>
                        </>
                      ) : (
                        <p className="preview-empty">当前没有可预览的图片</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {activePage === 'history' ? (
            <section className="history-page panel history-panel">
              <h2>历史记录</h2>
              <div className="history-grid">
                {isHistoryLoading ? <p>历史记录加载中...</p> : null}
                {!isHistoryLoading && historyItems.length === 0 ? <p>暂无历史记录。</p> : null}
                {!isHistoryLoading
                  ? historyItems.map((item) => (
                      <article key={item.id} className="history-card">
                        <img className="history-thumb" src={`${API_BASE}/api/file/${item.id}/content`} alt={item.name} />
                        <strong>{item.name}</strong>
                        <span>{item.sizeLabel}</span>
                        <span>{item.createdAt && item.createdAt !== '-' ? new Date(item.createdAt).toLocaleString('zh-CN') : '-'}</span>
                        <div className="history-actions">
                          <button type="button" onClick={() => handleHistoryDownload(item.id)}>下载</button>
                          <button type="button" onClick={() => void handleHistoryDelete(item.id)}>删除</button>
                        </div>
                      </article>
                    ))
                  : null}
              </div>
              <div className="action-row single">
                <button type="button" className="ghost-button" onClick={() => void handleHistoryClear()} disabled={historyItems.length === 0 || isHistoryLoading}>
                  清空历史记录
                </button>
              </div>
            </section>
          ) : null}

          {activePage === 'settings' ? (
            <section className="settings-page panel settings-panel">
              <h2>设置</h2>
              <div className="settings-grid">
                <div className="settings-section">
                  <h3>通用设置</h3>
                  <p>主题：浅色 / 深色</p>
                  <p>语言：中文 / English</p>
                  <p>默认输出目录：/Users/.../Pictures</p>
                </div>
                <div className="settings-section">
                  <h3>压缩默认设置</h3>
                  <p>默认模式：平衡</p>
                  <p>默认格式：原格式</p>
                  <p>默认质量：80</p>
                </div>
                <div className="settings-section">
                  <h3>性能与隐私</h3>
                  <p>并发线程数：4</p>
                  <p>自动清理：开启</p>
                  <p>全部本地处理，不上传服务器</p>
                </div>
              </div>
              <div className="action-row single">
                <button type="button" className="primary-button">保存设置</button>
                <button type="button" className="ghost-button">恢复默认</button>
              </div>
            </section>
          ) : null}
        </main>

        <footer className="status-bar">
          <span>处理进度 {progress}%</span>
          <span>内存使用 320MB</span>
          <span>处理文件数 {items.length}</span>
          <span>版本信息 v0.1.0</span>
        </footer>
      </div>
    </div>
  );
}

export default App;
