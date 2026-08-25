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
   * Corner drag, in SCREEN px — which is also bubble px, since the frame is
   * fixed in screen space and the camera never scales it.
   */
  onResize(dx: number, dy: number): void;
  /**
   * The body scrolled — persisted, so a refresh comes back where you were.
   *
   * `programmatic` marks the echo of a scroll the CONTROLLER just made (the
   * centre-line rule re-anchoring the body after a text-scale change). The
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
/** Padding above the first source row and below the last — fixed, never zoomed. */
const BODY_PAD_PX = 6;
/**
 * How long after a programmatic scroll its own event is still recognisable as
 * one. Scroll events are delivered in the same turn as the write that caused
 * them, so this is an order of magnitude of slack rather than a guess.
 */
const SELF_SCROLL_MS = 50;
/** The gutter call marker (phase B2): a muted dot, an accent one under the pointer. */
const MARKER_PX = 5;
const MARKER_COLOR = `color-mix(in oklab, ${MUTED} 70%, transparent)`;
const MARKER_COLOR_HOT = 'var(--accent)';
const MARKER_COLOR_DEAD = `color-mix(in oklab, ${MUTED} 32%, transparent)`;

/**
 * What the body's geometry is, in UNSCALED CSS px — measured from the DOM, once
 * per content load, and handed to the controller so the call-tether anchor is
 * arithmetic rather than a per-frame layout read.
 */
export interface BubbleBodyGeometry {
  /** Top of the box to the first content pixel. Never zoomed — it is chrome. */
  headerHeight: number;
  /** The first row's own top offset inside the scrolling body. */
  padTop: number;
  /** Padding below the last row. */
  padBottom: number;
  /** One source row, top to top, **at text scale 1**. */
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
  /** The zoomed-out face: name, kind and LoC centred in the SAME frame. */
  private readonly label: HTMLDivElement;
  private readonly labelName: HTMLSpanElement;
  private readonly labelKind: HTMLSpanElement;
  private readonly labelLoc: HTMLSpanElement;
  private readonly callbacks: BubbleViewCallbacks;

  /** Gutter rows, so "scroll to line" is an offset the layout already knows. */
  private gutter: HTMLDivElement | null = null;
  private pre: HTMLPreElement | null = null;
  private code: HTMLElement | null = null;
  private firstLine = 1;
  private isLabel = false;
  private lastTransform = '';
  private width = 0;
  private height = 0;
  /** Multiplier the body's type is currently laid out at (B2.1). */
  private textScale = 1;
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
    this.root.addEventListener('pointerdown', () => this.callbacks.onRaise());

    // ---- the frame: header + source, at a size the camera never changes -----
    this.full = document.createElement('div');
    Object.assign(this.full.style, {
      position: 'relative',
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

    const header = (this.header = document.createElement('div'));
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
    this.body.addEventListener('scroll', () => {
      // A programmatic write's echo lands in the same turn as the write. The
      // window is generous by an order of magnitude and costs nothing if it is
      // wrong: the offset is reported either way, only the redraw is skipped.
      const programmatic = performance.now() - this.selfScrollAt < SELF_SCROLL_MS;
      this.selfScrollAt = 0;
      this.callbacks.onScroll(this.body.scrollTop, programmatic);
    });

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

    // ---- zoomed out: the same frame, saying what it is ----------------------
    // Centred on the WHOLE frame rather than on the body, so the block sits in
    // the middle of the box the user laid out. It is `pointer-events: none`,
    // which is what lets the header underneath stay a drag handle with working
    // buttons while it is up.
    this.label = document.createElement('div');
    Object.assign(this.label.style, {
      position: 'absolute',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '5px',
      padding: '8px 12px',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      textAlign: 'center',
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
    this.label.append(this.labelKind, this.labelName, this.labelLoc);

    this.full.append(header, this.body, this.label, grip);
    this.root.append(this.full);
    parent.append(this.root);
    this.applyBoxSize();
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
    this.pre = null;
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
      padding: '6px 6px 6px 8px',
      textAlign: 'right',
      color: `color-mix(in oklab, ${MUTED} 65%, transparent)`,
      font: this.codeFont(),
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
      font: this.codeFont(),
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
    this.pre = pre;
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
   * A marker's own size, in step with the type it annotates (B2.1).
   *
   * It rides a row whose height is the camera's now, so a fixed dot would
   * swallow a zoomed-out row and get lost in a zoomed-in one. The floor keeps
   * it clickable at the smallest readable type, and the ceiling keeps it
   * inside the gutter's own left padding, which is the only space it has.
   */
  private sizeMarker(marker: HTMLElement): void {
    const size = Math.min(7, Math.max(3, MARKER_PX * this.textScale));
    marker.style.width = `${size}px`;
    marker.style.height = `${size}px`;
    marker.style.marginTop = `${-size / 2}px`;
    marker.style.left = `${-(size + 1)}px`;
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
   * the next press anywhere. Its offsets are plain CSS px against the frame,
   * which is the whole benefit of a frame that never scales: screen px and box
   * px are the same px, so it lands beside its marker at any zoom.
   */
  private showPicker(line: number, callees: BubbleCallSite[], marker: HTMLElement): void {
    this.closePicker();
    const markerBox = marker.getBoundingClientRect();
    const rootBox = this.root.getBoundingClientRect();

    const picker = document.createElement('div');
    Object.assign(picker.style, {
      position: 'absolute',
      zIndex: '2',
      minWidth: '120px',
      maxWidth: '240px',
      maxHeight: '160px',
      overflowY: 'auto',
      padding: '3px',
      borderRadius: '6px',
      border: `1px solid ${BORDER}`,
      background: 'var(--surface)',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
      font: `500 11px/1.3 ${FONT_UI}`,
    });
    const left = Math.max(0, markerBox.left - rootBox.left + 12);
    const top = Math.max(0, markerBox.bottom - rootBox.top + 4);
    picker.style.left = `${Math.min(left, Math.max(0, this.width - 130))}px`;
    picker.style.top = `${Math.min(top, Math.max(0, this.height - 40))}px`;

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
        padding: '3px 6px',
        border: 'none',
        borderRadius: '4px',
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
    const scale = this.textScale > 0 ? this.textScale : 1;
    return {
      headerHeight: this.header.offsetHeight,
      padTop: first.offsetTop,
      padBottom: BODY_PAD_PX,
      // Reported at text scale 1: the anchor maths multiplies it back up by
      // whatever the text is being drawn at, so there is one row height in the
      // system rather than one per zoom level.
      lineHeight: measured / scale,
      lineCount: gutter.childElementCount,
      firstLine: this.firstLine,
    };
  }

  // -------------------------------------------------------------- geometry ---

  /**
   * The size of the frame, in CSS px — fixed in SCREEN space (B2.1).
   *
   * The camera does not appear here and never will: zooming moves a bubble,
   * it does not resize it. What the user dragged the corner to is what is on
   * screen at every zoom level.
   */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.applyBoxSize();
  }

  private applyBoxSize(): void {
    this.root.style.width = `${this.width}px`;
    this.root.style.height = `${this.height}px`;
  }

  private codeFont(): string {
    return `${CODE_PX * this.textScale}px/${LINE_HEIGHT} ${FONT_MONO}`;
  }

  /**
   * Zoom the TEXT — the only thing the camera changes inside the frame.
   *
   * Applied as a font size rather than as a transform, so the body reflows
   * into a scrollport that has not moved: zoomed out, the same box holds more
   * and smaller lines; zoomed in, fewer and larger ones. It is written only
   * when the quantised scale actually changes, because every write is a real
   * layout of every row.
   */
  setTextScale(scale: number): void {
    if (!(scale > 0) || scale === this.textScale) return;
    this.textScale = scale;
    const font = this.codeFont();
    if (this.gutter) this.gutter.style.font = font;
    if (this.pre) this.pre.style.font = font;
    // The gutter's call markers are body content too: they ride the rows.
    for (const marker of this.markers.values()) this.sizeMarker(marker);
  }

  /**
   * The per-frame call: where the bubble sits, and which face it is showing.
   *
   * This is deliberately the ONLY thing that happens to a bubble on a normal
   * frame — one string compare and (at most) one style write, no React, no
   * layout read, and nothing that touches the canvas or its snapshot. The
   * frame's own size is not in here at all, because it does not depend on the
   * camera.
   */
  place(x: number, y: number, label: boolean): void {
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
    const transform = `translate3d(${x}px, ${y}px, 0)`;
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
    if (row instanceof HTMLElement) this.setScrollTop(row.offsetTop);
  }

  /**
   * Scroll the body from code rather than from a gesture.
   *
   * Marked, so the scroll event it provokes is reported as the echo it is —
   * see {@link BubbleViewCallbacks.onScroll}.
   */
  setScrollTop(value: number): void {
    if (!Number.isFinite(value)) return;
    this.selfScrollAt = performance.now();
    this.body.scrollTop = value;
  }

  destroy(): void {
    this.renderSeq++;
    this.closePicker();
    this.markers.clear();
    this.root.remove();
  }
}
