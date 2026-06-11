function polarPoint(cx, cy, r, angleDeg) {
  const angle = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

function polygonPoints(cx, cy, radius, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const angle = i * (360 / count);
    const p = polarPoint(cx, cy, radius, angle);
    pts.push(`${p.x},${p.y}`);
  }
  return pts.join(' ');
}

function dataPoints(cx, cy, radius, values, maxVal) {
  const count = values.length;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const angle = i * (360 / count);
    const r = radius * (values[i] / maxVal);
    pts.push(polarPoint(cx, cy, r, angle));
  }
  return pts;
}

function labelOffset(label) {
  if (label === 'Formatting') {
    return { x: 8, y: -2 };
  }

  if (label === 'Efficiency') {
    return { x: 12, y: 4 };
  }

  return { x: 0, y: 0 };
}

function renderRadarChart(el) {
  const values = (el.dataset.values || '').split(',').map(v => Number(v.trim()));
  const labels = (el.dataset.labels || '').split(',').map(v => v.trim());
  const size = 340;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 86;
  const labelRadius = radius + 24;
  const maxVal = 5;
  const levels = 5;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'radar-svg');

  for (let l = 1; l <= levels; l++) {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', polygonPoints(cx, cy, radius * (l / levels), values.length));
    poly.setAttribute('class', 'radar-grid');
    svg.appendChild(poly);
  }

  for (let i = 0; i < values.length; i++) {
    const p = polarPoint(cx, cy, radius, i * (360 / values.length));
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', cx);
    line.setAttribute('y1', cy);
    line.setAttribute('x2', p.x);
    line.setAttribute('y2', p.y);
    line.setAttribute('class', 'radar-axis');
    svg.appendChild(line);

    const lp = polarPoint(cx, cy, labelRadius, i * (360 / values.length));
    const label = labels[i] || '';
    const offset = labelOffset(label);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', lp.x + offset.x);
    text.setAttribute('y', lp.y + offset.y);
    text.setAttribute('text-anchor', lp.x < cx - 6 ? 'end' : lp.x > cx + 6 ? 'start' : 'middle');
    text.setAttribute('dominant-baseline', lp.y < cy ? 'auto' : 'hanging');
    text.textContent = label;
    svg.appendChild(text);
  }

  const pts = dataPoints(cx, cy, radius, values, maxVal);
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
  polygon.setAttribute('class', 'radar-fill');
  svg.appendChild(polygon);

  pts.forEach(p => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
    c.setAttribute('r', 4.2);
    c.setAttribute('class', 'radar-point');
    svg.appendChild(c);
  });

  el.innerHTML = '';
  el.appendChild(svg);
}

document.querySelectorAll('.radar-chart').forEach(renderRadarChart);
