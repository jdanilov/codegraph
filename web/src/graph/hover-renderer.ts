/**
 * Hover chrome for a node label.
 *
 * Sigma's built-in hover renderer paints an opaque WHITE rounded box behind the
 * label — fine on its light default theme, unreadable on this one (light text
 * on a white chip). This draws the same affordance in the app's own palette:
 * a translucent dark chip with a hairline border, then delegates the text to
 * whatever label renderer is configured.
 */
import type { Attributes } from 'graphology-types';
import type { Settings } from 'sigma/settings';
import type { NodeDisplayData, PartialButFor } from 'sigma/types';

const CHIP_FILL = 'rgba(20, 25, 34, 0.94)';
const CHIP_BORDER = 'rgba(150, 175, 210, 0.35)';
const PADDING = 6;

export function drawNodeHover<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes,
>(
  context: CanvasRenderingContext2D,
  data: PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>,
  settings: Settings<N, E, G>
): void {
  const size = settings.labelSize;
  context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;

  context.save();
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 2;
  context.shadowBlur = 12;
  context.shadowColor = 'rgba(0, 0, 0, 0.55)';
  context.fillStyle = CHIP_FILL;
  context.strokeStyle = CHIP_BORDER;
  context.lineWidth = 1;

  if (typeof data.label === 'string' && data.label.length > 0) {
    const textWidth = context.measureText(data.label).width;
    const boxWidth = Math.round(textWidth + data.size + PADDING * 3);
    const boxHeight = Math.round(Math.max(size + PADDING, data.size * 2 + PADDING));
    const x = Math.round(data.x - data.size - PADDING);
    const y = Math.round(data.y - boxHeight / 2);
    roundedRect(context, x, y, boxWidth, boxHeight, boxHeight / 2);
  } else {
    context.beginPath();
    context.arc(data.x, data.y, data.size + PADDING / 2, 0, Math.PI * 2);
    context.closePath();
  }
  context.fill();
  context.shadowColor = 'transparent';
  context.stroke();
  context.restore();

  settings.defaultDrawNodeLabel(context, data, settings);
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.beginPath();
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
