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
  /**
   * Corner drag, in SCREEN px.
   *
   * Screen px are FRAME px only at camera 1 (B2.3: the frame is a world object
   * and is drawn at the camera's own scale in both directions). The controller
   * divides by that scale, so the box always grows under the cursor at exactly
   * the cursor's speed.
   */
  onResize(dx: number, dy: number): void;
  /**
   * The body scrolled, in FRAME px — persisted, so a refresh comes back where
   * you were.
   *
   * `programmatic` marks the echo of a scroll the CONTROLLER just made (the
   * centre-line rule re-anchoring the body after a font re-write). The
   * position is still reported, so state never drifts from the DOM, but a
   * scroll nobody performed must not dirty the scene: doing so would take the
   * canvas off its blit for the whole of a wheel gesture.
   */
  onScroll(scrollTop: number, programmatic: boolean): void;
  /** "expand to file" / "back to the symbol". */
  onToggleExpand(): void;
  /** Open the node's file at its first line in the configured editor. */
  onOpenInEditor(): void;
  /**
   * A gutter call marker was used: open this callee as a bubble of its own
   * (phase B2). The line is a REAL file line, the same one the gutter prints.
   */
  onOpenCallee(line: number, calleeId: string): void;
}

/**
 * One callee reachable from a displayed line (phase B2).
 *
 * `available` is false for a node the index knows by name but has no source
 * for — an unresolved or external target. Such an entry is still LISTED, dim
 * and inert: "this line calls that, and there is nothing to open" is an answer,
 * where hiding it would silently under-report what the line does.
 */
export interface BubbleCallSite {
  id: string;
  name: string;
  kind: string;
  available: boolean;
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
/** Padding above the first source row and below the last, in FRAME px. */
const BODY_PAD_PX = 6;

/**
 * The frame's LAYOUT scale, as a custom property every length in the frame is
 * written through (B2.3).
 *
 * A bubble is drawn at the camera's scale in both directions now, and above
 * camera 1 a composited `scale()` would upscale a raster made at 1× — legible
 * geometry, blurred type. So the frame is LAID OUT larger instead (`font-size`
 * and every other length multiplied by this) and the root transform is divided
 * by exactly the same number: the picture on screen is unchanged and the text
 * is rasterised at the size it is actually being read at.
 *
 * It is one custom property rather than forty style writes on purpose. Every
 * length inside the frame is authored once, at construction, as
 * `calc(Npx * var(--cg-bubble-layout))`; a re-layout is then a SINGLE property
 * write on the root and the whole subtree follows it — header, gutter, type,
 * markers, paddings, borders and the grip together, so the frame stays exactly
 * self-similar at every scale.
 */
const LAYOUT_VAR = '--cg-bubble-layout';

/**
 * `n` FRAME px, as the CSS length the DOM is laid out at.
 *
 * The fallback in the `var()` is load-bearing: some of these lengths sit
 * inside shorthands (`border`, `box-shadow`), and a shorthand whose
 * substitution fails drops the whole declaration — a frame with no border at
 * all. With the fallback the worst case is a frame laid out at 1, which is
 * exactly what it was before this round.
 */
function layoutPx(n: number): string {
  return `calc(${n}px * var(${LAYOUT_VAR}, 1))`;
}

/**
 * Type, as LONGHANDS rather than as the `font` shorthand.
 *
 * Deliberate: a shorthand carrying a `var()` is substituted and re-parsed at
 * computed-value time, and a substitution that fails takes every font property
 * with it — while `font: <calc>/<line-height>` is exactly the corner of the
 * shorthand grammar engines have historically disagreed about. Longhands have
 * neither problem: each one stands or falls alone, and there is no `/` to
 * parse.
 */
function typeStyle(
  weight: string | null,
  sizePx: number,
  lineHeight: string,
  family: string,
  scaled = true
): Record<string, string> {
  const style: Record<string, string> = {
    fontSize: scaled ? layoutPx(sizePx) : `${sizePx}px`,
    lineHeight,
    fontFamily: family,
  };
  if (weight) style.fontWeight = weight;
  return style;
}

/**
 * How long after a programmatic scroll its own event is still recognisable as
 * one. Scroll events are delivered in the same turn as the write that caused
 * them, so this is an order of magnitude of slack rather than a guess.
 */
const SELF_SCROLL_MS = 50;
/** The gutter call marker (phase B2): a muted dot, an accent one under the pointer. */
const MARKER_PX = 5;
/** The gap between a marker and the gutter's own text, in FRAME px. */
const MARKER_GAP_PX = 1;
const MARKER_COLOR = `color-mix(in oklab, ${MUTED} 70%, transparent)`;
const MARKER_COLOR_HOT = 'var(--accent)';
const MARKER_COLOR_DEAD = `color-mix(in oklab, ${MUTED} 32%, transparent)`;

/**
 * What the body's geometry is, in FRAME px — measured from the DOM, once per
 * content load, and handed to the controller so the call-tether anchor is
 * arithmetic rather than a per-frame layout read.
 *
 * FRAME px is the unit of everything that crosses this class's boundary (the
 * one exception is a pointer delta, which is screen px because a pointer is).
 * The DOM inside is laid out at frame px × the layout scale and drawn at
 * frame px × the camera, so every read here divides by whichever of the two
 * the number it read is in.
 */
export interface BubbleBodyGeometry {
  /** Top of the box to the first content pixel. */
  headerHeight: number;
  /** The first row's own top offset inside the scrolling body. */
  padTop: number;
  /** Padding below the last row. */
  padBottom: number;
  /** One source row, top to top, in frame px — the same number at every zoom. */
  lineHeight: number;
  /** Rows currently rendered. */
  lineCount: number;
  /** Real file line of the first row. */
  firstLine: number;
}

export class BubbleView {
  readonly root: HTMLDivElement;
  private readonly full: HTMLDivElement;
  private readonly headerName: HTMLSpanElement;
  private readonly headerKind: HTMLSpanElement;
  private readonly headerLoc: HTMLSpanElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;
  /** The zoomed-out face: name, kind and LoC centred on the SAME frame. */
  private readonly label: HTMLDivElement;
  /** The label's own content — the part that is a handle rather than a backdrop. */
  private readonly labelInner: HTMLDivElement;
  private readonly labelName: HTMLSpanElement;
  private readonly labelKind: HTMLSpanElement;
  private readonly labelLoc: HTMLSpanElement;
  private readonly callbacks: BubbleViewCallbacks;

  /** Gutter rows, so "scroll to line" is an offset the layout already knows. */
  private gutter: HTMLDivElement | null = null;
  private code: HTMLElement | null = null;
  private firstLine = 1;
  private isLabel = false;
  private lastTransform = '';
  /**
   * The scale the root's transform currently carries (`frameScale / fontScale`).
   *
   * Also the gate on the label's counter-scale, which is `1 / this`: the two
   * are written together or not at all, so the label can never be cancelling a
   * transform the root is no longer wearing.
   */
  private currentRootScale = 1;
  private width = 0;
  private height = 0;
  /**
   * What the camera is drawing the whole frame at right now — `camera.scale`
   * itself (B2.3).
   *
   * A bubble is a world object: on screen it is its frame px times this, at
   * every zoom, exactly like a disk. So a screen px and a frame px are the
   * same px only at camera 1, and everything here that reads the DOM in SCREEN
   * units (a measured row, a marker's position) divides by it to get back to
   * frame units.
   */
  private frameScale = 1;
  /**
   * What the frame is LAID OUT at (B2.3) — 1 at and below camera 1, and the
   * camera's own scale (quantised, capped) above it.
   *
   * Invisible in the picture: the root transform is divided by exactly this,
   * so the composed on-screen size is `frame px × frameScale` whatever it is.
   * All it decides is the size the type is RASTERISED at. It also means the
   * DOM's own layout px are frame px × this, so every read of `offsetTop` /
   * `offsetHeight` / `scrollTop` divides by it and every write multiplies.
   */
  private fontScale = 1;
  /** Rising per render, so a highlighter that lands late cannot paint a stale body. */
  private renderSeq = 0;
  /**
   * `performance.now()` of the last scroll this view was TOLD to make.
   *
   * The DOM's own scroll event cannot say who caused it, so the controller's
   * re-anchoring writes and the user's wheel are told apart by time: an event
   * arriving in the same turn as a programmatic write is that write's echo.
   */
  private selfScrollAt = 0;
  /** Gutter call markers by REAL file line (phase B2). */
  private readonly markers = new Map<number, HTMLElement>();
  /** The open callee picker, and the listener that dismisses it. */
  private picker: HTMLDivElement | null = null;
  private dismissPicker: ((event: PointerEvent) => void) | null = null;

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
    // Defined before anything under it is styled: every length in the frame is
    // written through this property, and one that resolved to nothing would
    // take its whole shorthand with it.
    this.root.style.setProperty(LAYOUT_VAR, '1');
    this.root.addEventListener('pointerdown', () => this.callbacks.onRaise());

    // ---- the frame: header + source, at the size the user dragged it to -----
    this.full = document.createElement('div');
    Object.assign(this.full.style, {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      boxSizing: 'border-box',
      width: '100%',
      height: '100%',
      borderRadius: layoutPx(8),
      border: `${layoutPx(1)} solid ${BORDER}`,
      background: SURFACE,
      backdropFilter: `blur(${layoutPx(6)})`,
      color: 'var(--foreground)',
      overflow: 'hidden',
      boxShadow: `0 ${layoutPx(10)} ${layoutPx(30)} rgba(0, 0, 0, 0.45)`,
    });

    const header = (this.header = document.createElement('div'));
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: layoutPx(6),
      padding: `${layoutPx(4)} ${layoutPx(6)}`,
      borderBottom: `${layoutPx(1)} solid ${BORDER}`,
      ...typeStyle('500', 11, '1.2', FONT_UI),
      cursor: 'grab',
      userSelect: 'none',
      flex: '0 0 auto',
    });

    this.headerKind = document.createElement('span');
    Object.assign(this.headerKind.style, {
      padding: `${layoutPx(1)} ${layoutPx(5)}`,
      borderRadius: '999px',
      border: `${layoutPx(1)} solid ${BORDER}`,
      color: MUTED,
      fontSize: layoutPx(9),
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
    Object.assign(this.headerLoc.style, {
      color: MUTED,
      fontSize: layoutPx(10),
      whiteSpace: 'nowrap',
    });

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
    this.body.addEventListener('scroll', () => {
      // A programmatic write's echo lands in the same turn as the write. The
      // window is generous by an order of magnitude and costs nothing if it is
      // wrong: the offset is reported either way, only the redraw is skipped.
      const programmatic = performance.now() - this.selfScrollAt < SELF_SCROLL_MS;
      this.selfScrollAt = 0;
      // `scrollTop` is layout px; everything outside this class is frame px.
      this.callbacks.onScroll(this.body.scrollTop / this.fontScale, programmatic);
    });

    const grip = document.createElement('div');
    Object.assign(grip.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: layoutPx(14),
      height: layoutPx(14),
      cursor: 'nwse-resize',
      background:
        'linear-gradient(135deg, transparent 45%, color-mix(in oklab, var(--muted) 70%, transparent) 45%, color-mix(in oklab, var(--muted) 70%, transparent) 55%, transparent 55%)',
    });
    this.bindDrag(grip, (dx, dy) => this.callbacks.onResize(dx, dy));

    // ---- zoomed out: the same frame, saying what it is ----------------------
    // Centred on the WHOLE frame rather than on the body, so the block sits in
    // the middle of the box the user laid out.
    //
    // B2.2: it is a child of the ROOT rather than of the frame, and it
    // counter-scales — the frame shrinks with the world now, and a name that
    // shrank with it would be exactly the thing the label exists to avoid. The
    // `1 / rootScale` here cancels the root's own transform, so the label reads
    // at a fixed screen size at every zoom; the frame's `overflow: hidden` is
    // not above it any more, so at deep zoom-out it is allowed to be bigger
    // than the box it names, the way a disk's label is.
    //
    // Its own lengths are deliberately NOT written through the layout scale
    // (B2.3): they are already fixed on screen by the counter-scale, and
    // laying them out larger would only cancel out again. The label is only
    // ever shown below camera 0.5, where the layout scale is 1 regardless.
    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      // The backdrop is inert: it covers the frame (and, counter-scaled, rather
      // more than the frame), and a handle that big would eat the canvas
      // around a tiny bubble. Only the content inside it takes the pointer.
      pointerEvents: 'none',
      textAlign: 'center',
      // Deliberately NOT clipped. At deep zoom-out the block is taller than the
      // speck it names, and cutting it off there would leave a zoomed-out
      // workspace of unreadable slivers — which is the one thing the label
      // exists to prevent. A disk's labels overrun their wedge for the same
      // reason.
      overflow: 'visible',
    });

    // The part that IS the affordance: at low zoom the header is scaled down to
    // a couple of pixels, so the label carries the drag and the close instead.
    // A bubble you cannot move or shut at low zoom would be a trap — B2.1 kept
    // the header for exactly that reason, and this keeps the promise a
    // different way now that the header shrinks.
    this.labelInner = document.createElement('div');
    Object.assign(this.labelInner.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '5px',
      padding: '8px 12px',
      maxWidth: '100%',
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      cursor: 'grab',
      overflow: 'hidden',
    });
    this.labelKind = document.createElement('span');
    Object.assign(this.labelKind.style, {
      padding: '1px 6px',
      borderRadius: '999px',
      border: `1px solid ${BORDER}`,
      color: MUTED,
      font: `500 9px/1.4 ${FONT_UI}`,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    });
    this.labelName = document.createElement('span');
    Object.assign(this.labelName.style, {
      maxWidth: '100%',
      color: 'var(--foreground)',
      font: `600 13px/1.25 ${FONT_UI}`,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    this.labelLoc = document.createElement('span');
    Object.assign(this.labelLoc.style, {
      color: MUTED,
      font: `10px/1.2 ${FONT_UI}`,
      whiteSpace: 'nowrap',
    });
    const labelClose = this.makeButton(
      '×',
      'Close this bubble',
      () => this.callbacks.onClose(),
      false
    );
    this.labelInner.append(this.labelKind, this.labelName, this.labelLoc, labelClose);
    this.label.append(this.labelInner);
    this.bindDrag(this.labelInner, (dx, dy) => this.callbacks.onMove(dx, dy));

    this.full.append(header, this.body, grip);
    this.root.append(this.full, this.label);
    parent.append(this.root);
    this.applyBoxSize();
  }

  /**
   * A header button — `scaled` for the ones inside the frame, plain for the
   * label's own close, which is fixed on screen like the rest of the label.
   */
  private makeButton(
    glyph: string,
    title: string,
    onClick: () => void,
    scaled = true
  ): HTMLButtonElement {
    const px = (n: number): string => (scaled ? layoutPx(n) : `${n}px`);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.title = title;
    button.setAttribute('aria-label', title);
    Object.assign(button.style, {
      flex: '0 0 auto',
      width: px(16),
      height: px(16),
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      border: 'none',
      borderRadius: px(4),
      background: 'transparent',
      color: MUTED,
      ...typeStyle('500', 12, '1', FONT_UI, scaled),
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
    this.labelKind.textContent = header.kind;
    this.labelName.textContent = header.name;
    this.labelName.title = header.name;
    this.labelLoc.textContent = `${header.loc} loc`;
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
    this.markers.clear();
    this.closePicker();
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
      padding: `${layoutPx(BODY_PAD_PX)} ${layoutPx(6)} ${layoutPx(BODY_PAD_PX)} ${layoutPx(8)}`,
      textAlign: 'right',
      color: `color-mix(in oklab, ${MUTED} 65%, transparent)`,
      ...this.codeFont(),
      userSelect: 'none',
      background: SURFACE,
      borderRight: `${layoutPx(1)} solid color-mix(in oklab, ${BORDER} 60%, transparent)`,
    });
    for (let i = 0; i < lines.length; i++) {
      const number = document.createElement('div');
      number.textContent = String(content.startLine + i);
      gutter.append(number);
    }

    const pre = document.createElement('pre');
    Object.assign(pre.style, {
      margin: '0',
      padding: `${layoutPx(BODY_PAD_PX)} ${layoutPx(10)}`,
      flex: '1 1 auto',
      whiteSpace: 'pre',
      ...this.codeFont(),
    });
    const code = document.createElement('code');
    code.className = 'hljs-code';
    code.innerHTML = escapeHtml(content.text);
    pre.append(code);

    row.append(gutter, pre);
    this.body.append(row);
    if (content.truncated) {
      const cut = this.notice('truncated', 'var(--accent)', false);
      cut.style.padding = `0 ${layoutPx(10)} ${layoutPx(6)}`;
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
      gap: layoutPx(6),
      margin: '0',
      padding: layoutPx(10),
      color,
      ...typeStyle(null, 11, '1.4', FONT_UI),
    });
    if (spinner) {
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: layoutPx(9),
        height: layoutPx(9),
        borderRadius: '999px',
        border: `${layoutPx(1.5)} solid color-mix(in oklab, ${MUTED} 55%, transparent)`,
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

  // ------------------------------------------------------- call markers ---

  /**
   * Put a marker in the gutter of every displayed line that calls something
   * (phase B2) — the tracing loop's entry point.
   *
   * Deliberately the quietest affordance the view has: a 5px dot in the
   * gutter's own padding, muted like the line numbers it sits beside, brighter
   * under the pointer. The callees are on its `title`, which is the same
   * hover idiom the header's buttons use, so nothing new has to be learnt and
   * nothing is painted that the eye has to skip over while reading code.
   *
   * The whole map is applied at once, after a content load: the gutter rows are
   * the layout the marker rides, so a marker cannot exist before them and must
   * be rebuilt whenever they are.
   */
  setCallSites(sites: ReadonlyMap<number, BubbleCallSite[]>): void {
    this.closePicker();
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    const gutter = this.gutter;
    if (!gutter || sites.size === 0) return;

    for (const [line, callees] of sites) {
      if (callees.length === 0) continue;
      const row = gutter.children[line - this.firstLine];
      if (!(row instanceof HTMLElement)) continue;
      const openable = callees.filter((callee) => callee.available);
      const names = callees.map((callee) => callee.name).join(', ');

      const marker = document.createElement('span');
      Object.assign(marker.style, {
        position: 'absolute',
        top: '50%',
        borderRadius: '999px',
        background: openable.length > 0 ? MARKER_COLOR : MARKER_COLOR_DEAD,
        cursor: openable.length > 0 ? 'pointer' : 'default',
      });
      this.sizeMarker(marker);
      marker.title =
        openable.length > 0
          ? `calls ${names} — click to open`
          : `calls ${names} — no source in the index`;
      marker.addEventListener('pointerenter', () => {
        if (openable.length > 0) marker.style.background = MARKER_COLOR_HOT;
      });
      marker.addEventListener('pointerleave', () => {
        marker.style.background = openable.length > 0 ? MARKER_COLOR : MARKER_COLOR_DEAD;
      });
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onMarkerClick(line, callees, marker);
      });
      row.style.position = 'relative';
      row.append(marker);
      this.markers.set(line, marker);
    }
  }

  /**
   * A marker's own size — a constant number of FRAME px (B2.3).
   *
   * It rides a row, and a row is now a fixed number of frame px at every zoom
   * (the whole frame scales as one thing), so the dot that annotates it is
   * fixed too. B2.1's floor and ceiling were there because the type changed
   * size INSIDE a frame that did not; nothing does that any more, so they are
   * gone rather than ported. Written through the layout scale like every other
   * length in the frame, which is why nothing has to re-write it on a zoom.
   */
  private sizeMarker(marker: HTMLElement): void {
    marker.style.width = layoutPx(MARKER_PX);
    marker.style.height = layoutPx(MARKER_PX);
    marker.style.marginTop = layoutPx(-MARKER_PX / 2);
    marker.style.left = layoutPx(-(MARKER_PX + MARKER_GAP_PX));
  }

  /** One callee opens straight away; several ask which one. */
  private onMarkerClick(line: number, callees: BubbleCallSite[], marker: HTMLElement): void {
    const openable = callees.filter((callee) => callee.available);
    if (openable.length === 0) return; // The title already says why. Never an error.
    if (openable.length === 1) {
      this.callbacks.onOpenCallee(line, openable[0]!.id);
      return;
    }
    this.showPicker(line, callees, marker);
  }

  /**
   * The multi-callee picker: a minimal list beside the marker.
   *
   * The app's own popover lives in React and this overlay is imperative, so
   * this is hand-rolled to the same rules the rest of the bubble follows —
   * inline styles against the app's CSS variables, no transition, dismissed by
   * the next press anywhere. It is a child of the frame, so it positions in
   * LAYOUT px: its own lengths go through the layout scale like the rest of
   * the frame, and the two SCREEN measurements it starts from are divided by
   * the root's transform (B2.3) rather than by the camera, because that is the
   * factor standing between a client rect and a layout offset.
   */
  private showPicker(line: number, callees: BubbleCallSite[], marker: HTMLElement): void {
    this.closePicker();
    const font = this.fontScale;
    const root = this.rootScale();
    const markerBox = marker.getBoundingClientRect();
    const rootBox = this.root.getBoundingClientRect();

    const picker = document.createElement('div');
    Object.assign(picker.style, {
      position: 'absolute',
      zIndex: '2',
      minWidth: layoutPx(120),
      maxWidth: layoutPx(240),
      maxHeight: layoutPx(160),
      overflowY: 'auto',
      padding: layoutPx(3),
      borderRadius: layoutPx(6),
      border: `${layoutPx(1)} solid ${BORDER}`,
      background: 'var(--surface)',
      boxShadow: `0 ${layoutPx(10)} ${layoutPx(30)} rgba(0, 0, 0, 0.45)`,
      ...typeStyle('500', 11, '1.3', FONT_UI),
    });
    const left = Math.max(0, (markerBox.left - rootBox.left) / root + 12 * font);
    const top = Math.max(0, (markerBox.bottom - rootBox.top) / root + 4 * font);
    picker.style.left = `${Math.min(left, Math.max(0, (this.width - 130) * font))}px`;
    picker.style.top = `${Math.min(top, Math.max(0, (this.height - 40) * font))}px`;

    for (const callee of callees) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.textContent = callee.name;
      entry.title = callee.available
        ? `${callee.kind} — open as a bubble`
        : `${callee.kind} — no source in the index`;
      Object.assign(entry.style, {
        display: 'block',
        width: '100%',
        padding: `${layoutPx(3)} ${layoutPx(6)}`,
        border: 'none',
        borderRadius: layoutPx(4),
        background: 'transparent',
        color: callee.available ? 'var(--foreground)' : MUTED,
        font: 'inherit',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: callee.available ? 'pointer' : 'default',
      });
      if (callee.available) {
        entry.addEventListener('pointerenter', () => {
          entry.style.background = 'color-mix(in oklab, var(--border) 60%, transparent)';
        });
        entry.addEventListener('pointerleave', () => {
          entry.style.background = 'transparent';
        });
        entry.addEventListener('click', (event) => {
          event.stopPropagation();
          this.closePicker();
          this.callbacks.onOpenCallee(line, callee.id);
        });
      }
      picker.append(entry);
    }

    this.root.append(picker);
    this.picker = picker;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && picker.contains(event.target)) return;
      this.closePicker();
    };
    this.dismissPicker = dismiss;
    // Capture, so a press that the canvas or another bubble swallows still
    // closes this: a menu that outlives the gesture that left it is a bug.
    document.addEventListener('pointerdown', dismiss, true);
  }

  private closePicker(): void {
    if (this.dismissPicker) {
      document.removeEventListener('pointerdown', this.dismissPicker, true);
      this.dismissPicker = null;
    }
    this.picker?.remove();
    this.picker = null;
  }

  /**
   * The body's measured geometry, or `null` while there is no source in it.
   *
   * Read ONCE per content load (the controller caches it): a call tether's
   * anchor is then pure arithmetic over these numbers, and a frame never
   * touches the DOM to find out where a line is.
   */
  bodyGeometry(): BubbleBodyGeometry | null {
    const gutter = this.gutter;
    if (!gutter || gutter.childElementCount === 0) return null;
    const first = gutter.children[0];
    if (!(first instanceof HTMLElement)) return null;
    const second = gutter.children[1];
    // Sub-pixel on purpose: `offsetTop` is rounded to whole px, and dividing a
    // rounded row height by the scale it was measured at is how a base metric
    // picks up a few percent of error that then multiplies by the line number.
    const firstRect = first.getBoundingClientRect();
    const measured =
      second instanceof HTMLElement
        ? second.getBoundingClientRect().top - firstRect.top
        : firstRect.height;
    if (!(measured > 0)) return null;
    // Two DOM units, two divisors, and which one applies is decided by what
    // the property answers in (B2.3). `getBoundingClientRect` is SCREEN px —
    // frame px through BOTH the layout scale and the root's transform, whose
    // product is exactly the frame scale — so a row divides by that one
    // number. `offsetHeight` / `offsetTop` are LAYOUT px, which a transform
    // does not touch, so they divide by the layout scale alone.
    const frame = this.frameScale > 0 ? this.frameScale : 1;
    const font = this.fontScale > 0 ? this.fontScale : 1;
    return {
      headerHeight: this.header.offsetHeight / font,
      padTop: first.offsetTop / font,
      padBottom: BODY_PAD_PX,
      // In frame px, which is the same number at every zoom: the whole frame
      // scales as one thing, so a row is a fixed share of the box that holds
      // it and there is one row height in the system rather than one per zoom.
      lineHeight: measured / frame,
      lineCount: gutter.childElementCount,
      firstLine: this.firstLine,
    };
  }

  // -------------------------------------------------------------- geometry ---

  /**
   * The size of the frame, in FRAME px — the user's own number, drawn through
   * the camera's scale (B2.3).
   *
   * The camera does not appear here: it is a transform on the root, applied in
   * {@link place}. What the user dragged the corner to is the box's size in
   * the WORLD; on screen it is that times the camera, in both directions, the
   * way a disk is.
   */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.applyBoxSize();
  }

  /**
   * The root's own box, in the LAYOUT px the frame is currently laid out at.
   *
   * Frame px × the layout scale — the other half of the deal the root
   * transform (`frameScale / fontScale`) makes: multiply the two and the box
   * on screen is frame px × frameScale, whatever the layout scale happens to
   * be.
   */
  private applyBoxSize(): void {
    this.root.style.width = `${this.width * this.fontScale}px`;
    this.root.style.height = `${this.height * this.fontScale}px`;
  }

  /** The source's own type. Frame px, so it scales with everything around it. */
  private codeFont(): Record<string, string> {
    return typeStyle(null, CODE_PX, LINE_HEIGHT, FONT_MONO);
  }

  /** What the root's transform scales by, as the controller last computed it. */
  private rootScale(): number {
    return this.currentRootScale;
  }

  /**
   * Re-lay the frame at a new size of type — the crisp half of B2.3's zoom.
   *
   * The transform is what zooms a bubble frame by frame, and a composited
   * transform upscales a raster made at the old scale: smooth, and above
   * camera 1 visibly soft. So when the camera SETTLES the controller hands the
   * frame the scale it is actually being read at, the whole subtree is laid
   * out that much larger through one custom property — type, chrome, paddings,
   * borders and markers together — and the root's transform is divided by the
   * same number. Nothing moves on screen; the glyphs are simply rasterised at
   * the size they are being read at.
   *
   * A real layout of every row, so it is written only when the quantised scale
   * changes, and only on a settled camera: a wheel gesture pays none of it.
   */
  setFontScale(scale: number): void {
    if (!(scale > 0) || scale === this.fontScale) return;
    this.fontScale = scale;
    this.root.style.setProperty(LAYOUT_VAR, String(scale));
    // The box is in frame px and the DOM is in layout px, so the two writes
    // that bridge them go together: a size that lagged the property by a frame
    // would draw the frame at the wrong aspect for that frame.
    this.applyBoxSize();
  }

  /**
   * The per-frame call: where the bubble sits, how big the camera is drawing
   * it, and which face it is showing.
   *
   * This is deliberately the ONLY thing that happens to a bubble on a normal
   * frame — one string compare and (at most) one style write, no React, no
   * layout read, and nothing that touches the canvas or its snapshot. The
   * frame's own `width`/`height` are still not in here, because they change
   * only on a resize or a re-layout: what the camera changes is the `scale()`
   * those px are drawn through (B2.3), which is a composited transform and
   * reflows nothing.
   */
  place(x: number, y: number, label: boolean, frameScale: number, rootScale: number): void {
    this.frameScale = Number.isFinite(frameScale) && frameScale > 0 ? frameScale : 1;
    // What the camera asks for, less what this frame's layout has already
    // taken — computed by the controller, from the same helper the canvas
    // reasons about, so there is exactly one division in the system.
    const root = Number.isFinite(rootScale) && rootScale > 0 ? rootScale : 1;
    if (root !== this.currentRootScale) {
      this.currentRootScale = root;
      // Cancel the root's transform for the label only, so the one thing on a
      // zoomed-out bubble that has to stay readable does.
      this.label.style.transform = root === 1 ? 'none' : `scale(${1 / root})`;
    }
    if (label !== this.isLabel) {
      this.isLabel = label;
      // Under a label there is no gutter on screen, so a picker hanging off
      // one would be a menu attached to nothing.
      if (label) this.closePicker();
      this.label.style.display = label ? 'flex' : 'none';
      // `visibility`, not `display`: the body keeps its layout box, so its
      // scroll offset, any selection in it and its measured geometry all
      // survive a round trip across the threshold untouched.
      this.body.style.visibility = label ? 'hidden' : 'visible';
    }
    const transform =
      root === 1
        ? `translate3d(${x}px, ${y}px, 0)`
        : `translate3d(${x}px, ${y}px, 0) scale(${root})`;
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
    // `offsetTop` is layout px, and this class hands out frame px.
    if (row instanceof HTMLElement) this.setScrollTop(row.offsetTop / this.fontScale);
  }

  /**
   * Scroll the body from code rather than from a gesture, in FRAME px.
   *
   * Marked, so the scroll event it provokes is reported as the echo it is —
   * see {@link BubbleViewCallbacks.onScroll}.
   */
  setScrollTop(value: number): void {
    if (!Number.isFinite(value)) return;
    this.selfScrollAt = performance.now();
    this.body.scrollTop = value * this.fontScale;
  }

  destroy(): void {
    this.renderSeq++;
    this.closePicker();
    this.markers.clear();
    this.root.remove();
  }
}
