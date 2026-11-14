import { api } from './transport.js';

export const defaultCover = new URL('./cover.webp', location.href).href;

export class CoverImages {
  constructor(image, onChange) { this.image = image; this.onChange = onChange; this.version = 0; }
  set(blob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = blob ? URL.createObjectURL(blob) : null;
    this.image.src = this.url || defaultCover;
    this.onChange(this.image.src, blob?.type || 'image/png');
  }
  async load(file) {
    const version = ++this.version;
    this.set(null);
    if (!file.coverVersion) return;
    const blob = await api(`audio-covers/${file.id}`, { responseType: 'blob' });
    if (this.version === version) this.set(blob);
  }
  async save(file, selected) {
    if (!['image/jpeg','image/png','image/webp'].includes(selected.type) || selected.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 JPG, PNG, WebP 이미지를 선택해 주세요.');
    const url = URL.createObjectURL(selected);
    const image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('이미지를 읽지 못했습니다.')); image.src = url; });
      const canvas = document.createElement('canvas');
      let size = 768, blob;
      for (let attempt = 0; attempt < 5; attempt++) {
        const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#15111f'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(image,0,0,canvas.width,canvas.height);
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
        if (blob && blob.size <= 80 * 1024) break;
        size = Math.floor(size * 0.75);
      }
      if (!blob || blob.size > 80 * 1024) throw new Error('이미지가 너무 복잡합니다. 더 작은 이미지를 선택해 주세요.');
      const data = new Uint8Array(await blob.arrayBuffer());
      let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
      const saved = await api(`audio-covers/${file.id}`, { method:'PUT', data:{image:btoa(binary)} });
      file.coverVersion = saved.coverVersion;
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }
}
