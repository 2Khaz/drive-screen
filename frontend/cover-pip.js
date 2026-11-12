// The native audio element keeps its original playback path. A silent canvas
// video carries the cover image into PiP, avoiding audio decoding/re-encoding
// and avoiding duplicate audio output through Web Audio.
export class CoverPip {
  constructor(video, image) {
    this.video = video; this.image = image;
    this.canvas = document.createElement('canvas'); this.canvas.width = 960; this.canvas.height = 540;
    this.context = this.canvas.getContext('2d');
    image.addEventListener('load', () => this.draw());
  }
  draw() {
    const { context: ctx, canvas, image } = this;
    ctx.fillStyle = '#15111f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (image.complete && image.naturalWidth) {
      const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    } else { ctx.fillStyle = '#c6b5ff'; ctx.font = '100px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('♫', canvas.width / 2, canvas.height / 2 + 35); }
    this.stream?.getVideoTracks()[0]?.requestFrame?.();
  }
  start() {
    if (this.stream || !this.canvas.captureStream) return;
    this.oldMuted = this.video.muted;
    this.draw(); this.stream = this.canvas.captureStream(1);
    this.video.srcObject = this.stream; this.video.controls = false; this.video.muted = true;
    this.video.play().catch(() => {});
    this.draw(); this.timer = setInterval(() => this.draw(), 1000);
  }
  stop() {
    if (!this.stream) return;
    clearInterval(this.timer);
    this.stream.getTracks().forEach(track => track.stop()); this.stream = null;
    this.video.pause(); this.video.srcObject = null; this.video.controls = true; this.video.muted = this.oldMuted;
  }
}
