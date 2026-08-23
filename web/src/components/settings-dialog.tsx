/**
 * Settings — the small floating dialog behind the gear.
 *
 * Backed by `GET/PUT /api/settings` (`~/.codegraph/ui.json`, per USER not per
 * project). Three fields today: the editor command template used by "jump to
 * editor", and the API key + model the question box will use in a later phase.
 *
 * The API key is never echoed back in full — the server returns a mask. So the
 * field starts holding that mask and is only ever PUT when the user actually
 * edits it; an untouched form round-trips without touching the stored key.
 *
 * The form is only rendered once the current settings have loaded (`loading`),
 * so nothing the user picks can be overwritten by a late GET — the ONE way the
 * state changes is a click. Which is why the `<label>`-forwarding bug fixed in
 * {@link Field} was enough to lose a Graph-order choice on its own.
 */
import { useEffect, useState } from 'react';
import { Check, Loader2, Settings as SettingsIcon, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toSortMode, type SortMode } from '@/graph/sunburst';
import { fetchSettings, saveSettings, type SettingsView } from '@/lib/api';

/** The two disk orders, with the one-line explanation each needs. */
const SORT_MODES: Array<{ value: SortMode; label: string; hint: string }> = [
  { value: 'structural', label: 'structural', hint: 'folders A→Z, symbols in declaration order' },
  { value: 'size', label: 'size', hint: 'largest first' },
];

/** Shown under the editor field — the two templates people actually use. */
const EDITOR_EXAMPLES = ['cursor -g {file}:{line}', 'code -g {file}:{line}'];

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
  /** Applied live to the canvas as the user picks it, before any save. */
  onSortModeChange?(mode: SortMode): void;
}

export function SettingsDialog({ open, onClose, onSortModeChange }: SettingsDialogProps) {
  const [editorCommand, setEditorCommand] = useState('');
  const [model, setModel] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('structural');
  const [apiKey, setApiKey] = useState('');
  /** True once the user types in the key field — only then is the key sent. */
  const [keyDirty, setKeyDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (view: SettingsView): void => {
    setEditorCommand(view.editorCommand ?? '');
    setModel(view.model ?? '');
    setSortMode(toSortMode(view.sortMode));
    setApiKey(view.anthropicApiKey ?? '');
    setKeyDirty(false);
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    setLoading(true);
    let live = true;
    void fetchSettings()
      .then((view) => {
        if (live) apply(view);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string | null> = {
        editorCommand: editorCommand.trim() || null,
        model: model.trim() || null,
        sortMode,
      };
      // Omitting the key leaves the stored one alone; sending "" clears it.
      if (keyDirty) patch['anthropicApiKey'] = apiKey.trim() || null;
      const view = await saveSettings(patch);
      apply(view);
      // Re-publish the PERSISTED order, not the one that was clicked: after a
      // save the disk, the dialog and `~/.codegraph/ui.json` must agree, and
      // this is the only place all three are known at once.
      onSortModeChange?.(toSortMode(view.sortMode));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="w-[min(32rem,92vw)] p-5" data-testid="settings-dialog">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <SettingsIcon className="h-3.5 w-3.5 text-accent" /> Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {loading ? (
          <p className="mt-4 flex items-center gap-2 text-[11px] text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> loading…
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <Field
              label="Editor command"
              hint={`Used by "jump to editor". e.g. ${EDITOR_EXAMPLES.join('  ·  ')}`}
            >
              <input
                value={editorCommand}
                onChange={(event) => setEditorCommand(event.target.value)}
                placeholder={EDITOR_EXAMPLES[0]}
                data-testid="settings-editor-command"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-background/60 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
              />
            </Field>

            <Field
              group
              label="Graph order"
              hint="How siblings are arranged around the disk. The wedge size is always the share of lines of code — this only changes the order."
            >
              <div className="flex gap-1.5">
                {SORT_MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setSortMode(option.value);
                      onSortModeChange?.(option.value);
                    }}
                    data-testid={`settings-sort-${option.value}`}
                    title={option.hint}
                    className={
                      sortMode === option.value
                        ? 'rounded-md border border-accent bg-accent/15 px-2.5 py-1 text-xs text-foreground'
                        : 'rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="Anthropic API key"
              hint="Stored in ~/.codegraph/ui.json (0600) and never sent back in full."
            >
              <input
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setKeyDirty(true);
                }}
                placeholder="sk-ant-…"
                data-testid="settings-api-key"
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-md border border-border bg-background/60 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
              />
            </Field>

            <Field label="Model" hint="Model id used by the question box.">
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="claude-sonnet-4-5"
                data-testid="settings-model"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-background/60 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-accent"
              />
            </Field>

            {error ? <p className="text-[11px] text-red-400">{error}</p> : null}

            <div className="flex items-center justify-end gap-3">
              {saved ? (
                <span className="flex items-center gap-1 text-[11px] text-accent">
                  <Check className="h-3 w-3" /> saved
                </span>
              ) : null}
              <Button size="sm" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button size="sm" onClick={() => void submit()} disabled={saving} data-testid="settings-save">
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * One labelled row of the form.
 *
 * `group` is load-bearing, and is the fix for "Save resets the Graph order"
 * (round 2). A `<label>` forwards every click that does not land on interactive
 * content to its **first labelable descendant** — so with the two order buttons
 * wrapped in a label, clicking the caption, the hint, or any of the empty row
 * beside the buttons synthesised a click on the FIRST button (`structural`) and
 * silently threw the user's choice away. Save then honestly persisted what the
 * form now held. A group of buttons is not a labelled control: it renders as a
 * plain `<div role="group">` with a caption, and only a genuine single-input
 * field keeps the `<label>` (where the click-to-focus behaviour is the point).
 */
function Field({
  label,
  hint,
  group,
  children,
}: {
  label: string;
  hint: string;
  /** True when `children` is a set of controls rather than one input. */
  group?: boolean;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className="text-[11px] font-medium">{label}</span>
      {children}
      <span className="text-[10px] text-muted">{hint}</span>
    </>
  );
  if (group) {
    return (
      <div className="flex flex-col gap-1" role="group" aria-label={label}>
        {body}
      </div>
    );
  }
  return <label className="flex flex-col gap-1">{body}</label>;
}
