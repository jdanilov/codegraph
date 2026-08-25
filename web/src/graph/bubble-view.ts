/**
 * One code bubble's DOM — the view half of phase B1.
 *
 * A bubble is a block of source pinned to the workspace, and it is **DOM, not
 * canvas**: text has to be selectable, scrollable and syntax-coloured, and none
 * of those are things a 2D context does well. It therefore lives in an overlay
 * above the canvas, and the controller owns exactly one thing about it per
 * frame — a CSS transform. Nothing here reads the camera, computes geometry or
 * touches the canvas; nothing in the controller builds an element.
 *
 * It is hand-rolled rather than a React root per bubble for the same reason the
 * canvas is hand-rolled: the controller is imperative and already owns its own
 * `<canvas>`, so an imperative sibling is the smaller seam. Styling is inline
 * (against the app's own CSS variables) so a bubble cannot depend on a utility
 * class surviving the CSS pipeline — the one class it does use, `hljs-code`, is
 * the source view's own theme, which is exactly the point: the two views colour
 * code identically.
 */
import { escapeHtml, highlightWith, loadHighlighter } from '@/lib/highlight';

/** What the view reports back. Every callback is a user gesture, never a frame. */
export interface BubbleViewCallbacks {
  /** The `×`. */
  onClose(): void;
  /** A press anywhere in the bubble — raises it above its siblings. */
  onRaise(): void;
  /** Header drag, in SCREEN px. The controller converts to world units. */
  onMove(dx: number, dy: number): void;
  /** Corner drag, in SCREEN px. The controller converts to bubble units. */
  onResize(dx: number, dy: number): void;
  /** The body scrolled — persisted, so a refresh comes back where you were. */
  onScroll(scrollTop: number): void;
  /** "expand to file" / "back to the symbol". */
  onToggleExpand(): void;
  /** Open the node's file at its first line in the configured editor. */
  onOpenInEditor(): void;
}

/** The header's fixed facts. `loc` is the span's own line count. */
export interface BubbleHeader {
  name: string;
  kind: string;
  loc: number;
  /** Symbol bubbles can grow into their whole file; a file bubble cannot. */
  canExpand: boolean;
  expanded: boolean;
}

/** Source, or the reason there isn't any yet. */
export type BubbleContent =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: string; startLine: number; text: string; truncated: boolean };

const SURFACE = 'color-mix(in oklab, var(--surface) 92%, transparent)';
const BORDER = 'var(--border)';
const MUTED = 'var(--muted)';
const FONT_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const FONT_UI = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const LINE_HEIGHT = '1.55';
const CODE_PX = 11;

export class BubbleView {
  readonly root: HTMLDivElement;
  private readonly full: HTMLDivElement;
  private readonly chip: HTMLDivElement;
  private readonly headerName: HTMLSpanElement;
  private readonly headerKind: HTMLSpanElement;
  private readonly headerLoc: HTMLSpanElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private readonly chipLabel: HTMLSpanElement;
  private readonly callbacks: BubbleViewCallbacks;

  /** Gutter rows, so "scroll to line" is an offset the layout already knows. */
  private gutter: HTMLDivElement | null = null;
  private code: HTMLElement | null = null;
  private firstLine = 1;
  private isChip = false;
  private lastTransform = '';
  private width = 0;
  private height = 0;
  /** Rising per render, so a highlighter that lands late cannot paint a stale body. */
  private renderSeq = 0;

  constructor(parent: HTMLElement, callbacks: BubbleViewCallbacks) {
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      pointerEvents: 'auto',
      willChange: 'transform',
    });
    this.root.addEventListener('pointerdown', () => this.callbacks.onRaise());

    // ---- collapsed: the title chip -----------------------------------------
    this.chip = document.createElement('div');
    Object.assign(this.chip.style, {
      display: 'none',
      alignItems: 'center',
      gap: '6px',
      boxSizing: 'border-box',
      padding: '0 8px',
      borderRadius: '6px',
      border: `1px solid ${BORDER}`,
      background: SURFACE,
      backdropFilter: 'blur(4px)',
      color: 'var(--foreground)',
      font: `500 11px/1 ${FONT_UI}`,
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      cursor: 'grab',
      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
    });
    this.chipLabel = document.createElement('span');
    Object.assign(this.chipLabel.style, {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      flex: '1 1 auto',
    });
    this.chip.append(this.chipLabel);
    this.root.append(this.chip);
    this.bindDrag(this.chip, (dx, dy) => this.callbacks.onMove(dx, dy));

    // ---- expanded: header + source -----------------------------------------
    this.full = document.createElement('div');
    Object.assign(this.full.style, {
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      width: '100%',
      height: '100%',
      borderRadius: '8px',
      border: `1px solid ${BORDER}`,
      background: SURFACE,
      backdropFilter: 'blur(6px)',
      color: 'var(--foreground)',
      overflow: 'hidden',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '4px 6px',
      borderBottom: `1px solid ${BORDER}`,
      font: `500 11px/1.2 ${FONT_UI}`,
      cursor: 'grab',
      userSelect: 'none',
      flex: '0 0 auto',
    });

    this.headerKind = document.createElement('span');
    Object.assign(this.headerKind.style, {
      padding: '1px 5px',
      borderRadius: '999px',
      border: `1px solid ${BORDER}`,
      color: MUTED,
      fontSize: '9px',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    });

    this.headerName = document.createElement('span');
    Object.assign(this.headerName.style, {
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });

    this.headerLoc = document.createElement('span');
    Object.assign(this.headerLoc.style, { color: MUTED, fontSize: '10px', whiteSpace: 'nowrap' });

    this.expandButton = this.makeButton('⤢', 'Expand to the whole file', () =>
      this.callbacks.onToggleExpand()
    );
    const openButton = this.makeButton('↗', 'Open in your editor', () =>
      this.callbacks.onOpenInEditor()
    );
    const closeButton = this.makeButton('×', 'Close this bubble', () => this.callbacks.onClose());

    header.append(
      this.headerKind,
      this.headerName,
      this.headerLoc,
      this.expandButton,
      openButton,
      closeButton
    );
    this.bindDrag(header, (dx, dy) => this.callbacks.onMove(dx, dy));

    this.body = document.createElement('div');
    Object.assign(this.body.style, {
      flex: '1 1 auto',
      minHeight: '0',
      overflow: 'auto',
      overscrollBehavior: 'contain',
      background: 'transparent',
    });
    // The wheel belongs to whatever is under the pointer. Inside a bubble that
    // is the bubble, and the canvas must not zoom underneath it.
    this.body.addEventListener('wheel', (event) => event.stopPropagation());
    this.body.addEventListener('scroll', () => this.callbacks.onScroll(this.body.scrollTop));

    const grip = document.createElement('div');
    Object.assign(grip.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: '14px',
      height: '14px',
      cursor: 'nwse-resize',
      background:
        'linear-gradient(135deg, transparent 45%, color-mix(in oklab, var(--muted) 70%, transparent) 45%, color-mix(in oklab, var(--muted) 70%, transparent) 55%, transparent 55%)',
    });
    this.bindDrag(grip, (dx, dy) => this.callbacks.onResize(dx, dy));

    this.full.append(header, this.body, grip);
    this.root.append(this.full);
    parent.append(this.root);
  }

  private makeButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.title = title;
    button.setAttribute('aria-label', title);
    Object.assign(button.style, {
      flex: '0 0 auto',
      width: '16px',
      height: '16px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      border: 'none',
      borderRadius: '4px',
      background: 'transparent',
      color: MUTED,
      font: `500 12px/1 ${FONT_UI}`,
      cursor: 'pointer',
    });
    button.addEventListener('pointerenter', () => {
      button.style.color = 'var(--foreground)';
      button.style.background = 'color-mix(in oklab, var(--border) 60%, transparent)';
    });
    button.addEventListener('pointerleave', () => {
      button.style.color = MUTED;
      button.style.background = 'transparent';
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /**
   * A press-drag on `handle`, reported as SCREEN deltas.
   *
   * The pointer is captured for the whole gesture, so it survives the cursor
   * crossing the canvas (which has pointer handlers of its own) and a release
   * outside the window — the same treatment the shell's column resizer gets.
   */
  private bindDrag(handle: HTMLElement, onDelta: (dx: number, dy: number) => void): void {
    let last: { x: number; y: number } | null = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest('button')) return;
      last = { x: event.clientX, y: event.clientY };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!last) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
      onDelta(dx, dy);
    });
    const end = (event: PointerEvent): void => {
      if (!last) return;
      last = null;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // --------------------------------------------------------------- content ---

  setHeader(header: BubbleHeader): void {
    this.headerKind.textContent = header.kind;
    this.headerName.textContent = header.name;
    this.headerName.title = header.name;
    this.headerLoc.textContent = `${header.loc} loc`;
    this.expandButton.style.display = header.canExpand ? 'inline-flex' : 'none';
    this.expandButton.title = header.expanded ? 'Back to the symbol' : 'Expand to the whole file';
    this.expandButton.textContent = header.expanded ? '⤡' : '⤢';
    this.chipLabel.textContent = `${header.name} · ${header.kind} · ${header.loc} loc`;
    this.chipLabel.title = this.chipLabel.textContent;
  }

  /**
   * Replace the body.
   *
   * Loading and failure are states of the BUBBLE, never of the canvas: a fetch
   * that 404s prints a muted line inside the box the user dragged out and
   * nothing else changes, which is the difference between "this one file could
   * not be read" and "the view broke".
   */
  setContent(content: BubbleContent): void {
    const seq = ++this.renderSeq;
    this.gutter = null;
    this.code = null;
    this.body.replaceChildren();

    if (content.status === 'loading') {
      this.body.append(this.notice('loading…', MUTED, true));
      return;
    }
    if (content.status === 'error') {
      this.body.append(this.notice(content.message, '#f87171', false));
      return;
    }

    this.firstLine = content.startLine;
    const lines = content.text.split('\n');

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'flex-start', minWidth: 'min-content' });

    const gutter = document.createElement('div');
    Object.assign(gutter.style, {
      position: 'sticky',
      left: '0',
      zIndex: '1',
      flex: '0 0 auto',
      padding: '6px 6px 6px 8px',
      textAlign: 'right',
      color: `color-mix(in oklab, ${MUTED} 65%, transparent)`,
      font: `${CODE_PX}px/${LINE_HEIGHT} ${FONT_MONO}`,
      userSelect: 'none',
      background: SURFACE,
      borderRight: `1px solid color-mix(in oklab, ${BORDER} 60%, transparent)`,
    });
    for (let i = 0; i < lines.length; i++) {
      const number = document.createElement('div');
      number.textContent = String(content.startLine + i);
      gutter.append(number);
    }

    const pre = document.createElement('pre');
    Object.assign(pre.style, {
      margin: '0',
      padding: '6px 10px',
      flex: '1 1 auto',
      whiteSpace: 'pre',
      font: `${CODE_PX}px/${LINE_HEIGHT} ${FONT_MONO}`,
    });
    const code = document.createElement('code');
    code.className = 'hljs-code';
    code.innerHTML = escapeHtml(content.text);
    pre.append(code);

    row.append(gutter, pre);
    this.body.append(row);
    if (content.truncated) {
      const cut = this.notice('truncated', 'var(--accent)', false);
      cut.style.padding = '0 10px 6px';
      this.body.append(cut);
    }
    this.gutter = gutter;
    this.code = code;

    // The highlighter is a lazy chunk; the escaped text above is what shows
    // until it lands, so a bubble is readable from the first frame either way.
    const { file, text } = content;
    void loadHighlighter().then((engine) => {
      if (seq !== this.renderSeq || !this.code) return;
      const html = highlightWith(engine, text, file);
      if (html) this.code.innerHTML = html;
    });
  }

  private notice(text: string, color: string, spinner: boolean): HTMLParagraphElement {
    const paragraph = document.createElement('p');
    Object.assign(paragraph.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      margin: '0',
      padding: '10px',
      color,
      font: `11px/1.4 ${FONT_UI}`,
    });
    if (spinner) {
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '9px',
        height: '9px',
        borderRadius: '999px',
        border: `1.5px solid color-mix(in oklab, ${MUTED} 55%, transparent)`,
        borderTopColor: 'var(--accent)',
        // Animations are untouched by the app's transition-free rule: spinners
        // still spin (phase F).
        animation: 'codegraph-bubble-spin 0.9s linear infinite',
      });
      paragraph.append(dot);
    }
    paragraph.append(document.createTextNode(text));
    return paragraph;
  }

  // -------------------------------------------------------------- geometry ---

  /** The size of the EXPANDED box, in unscaled CSS px. */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (!this.isChip) this.applyBoxSize();
  }

  private applyBoxSize(): void {
    this.root.style.width = `${this.width}px`;
    this.root.style.height = `${this.height}px`;
  }

  /** The chip's own size — it is fixed, not a scaled-down bubble. */
  setChipSize(width: number, height: number): void {
    this.chip.style.width = `${width}px`;
    this.chip.style.height = `${height}px`;
  }

  /**
   * The per-frame call: where the bubble sits and how big it reads.
   *
   * This is deliberately the ONLY thing that happens to a bubble on a normal
   * frame — one string compare and (at most) one style write, no React, no
   * layout read, and nothing that touches the canvas or its snapshot.
   */
  place(x: number, y: number, scale: number, chip: boolean): void {
    if (chip !== this.isChip) {
      this.isChip = chip;
      this.chip.style.display = chip ? 'flex' : 'none';
      this.full.style.display = chip ? 'none' : 'flex';
      // The chip carries its own size; the root must stop claiming the box's
      // dimensions while it is collapsed, and take them back on the way out.
      // The BODY is never re-created either way, so its scroll position — and
      // any selection in it — survives a round trip across the threshold.
      if (chip) {
        this.root.style.width = 'auto';
        this.root.style.height = 'auto';
      } else {
        this.applyBoxSize();
      }
    }
    const transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      this.root.style.transform = transform;
    }
  }

  setZ(z: number): void {
    this.root.style.zIndex = String(z);
  }

  /** Scroll so a real FILE line sits at the top of the body. */
  scrollToLine(line: number): void {
    const gutter = this.gutter;
    if (!gutter) return;
    const index = Math.max(0, Math.min(gutter.childElementCount - 1, line - this.firstLine));
    const row = gutter.children[index];
    if (row instanceof HTMLElement) this.body.scrollTop = row.offsetTop;
  }

  setScrollTop(value: number): void {
    this.body.scrollTop = value;
  }

  destroy(): void {
    this.renderSeq++;
    this.root.remove();
  }
}
