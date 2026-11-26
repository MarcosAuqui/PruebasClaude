const caption = document.getElementById('caption');
let captionH = 0;

api.onOverlayState(({ running, showCaption, captionH: h }) => {
  document.body.classList.toggle('running', running);
  document.body.classList.toggle('with-caption', showCaption);
  captionH = showCaption ? h : 0;
  caption.style.height = showCaption ? `${h - 6}px` : '0';
});

api.onCaption((text) => { caption.textContent = text || ''; });

// ---------- Redimensionado con tiradores propios ----------
document.querySelectorAll('.h').forEach((handle) => {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const dir = handle.dataset.dir;
    const sx = e.screenX;
    const sy = e.screenY;
    const start = {
      x: window.screenX, y: window.screenY,
      w: window.innerWidth, h: window.innerHeight,
    };

    const move = (ev) => {
      const dx = ev.screenX - sx;
      const dy = ev.screenY - sy;
      let { x, y, w, h } = start;
      if (dir.includes('e')) w += dx;
      if (dir.includes('s')) h += dy;
      if (dir.includes('w')) { w -= dx; x += dx; }
      if (dir.includes('n')) { h -= dy; y += dy; }
      // Mantener el borde opuesto fijo al llegar al mínimo
      const minW = 120;
      const minH = 50 + captionH;
      if (w < minW) { if (dir.includes('w')) x -= minW - w; w = minW; }
      if (h < minH) { if (dir.includes('n')) y -= minH - h; h = minH; }
      api.setBounds({ x, y, width: w, height: h });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
});
