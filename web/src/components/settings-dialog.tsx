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
 */
import { useEffect, useState } from 'react';
import { Check, Loader2, Settings as SettingsIcon, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchSettings, saveSettings, type SettingsView } from '@/lib/api';

/** Shown under the editor field — the two templates people actually use. */
const EDITOR_EXAMPLES = ['cursor -g {file}:{line}', 'code -g {file}:{line}'];

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [editorCommand, setEditorCommand] = useState('');
  const [model, setModel] = useState('');
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
      };
      // Omitting the key leaves the stored one alone; sending "" clears it.
      if (keyDirty) patch['anthropicApiKey'] = apiKey.trim() || null;
      apply(await saveSettings(patch));
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
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
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
            className="rounded p-1 text-muted transition-colors hover:text-foreground"
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium">{label}</span>
      {children}
      <span className="text-[10px] text-muted">{hint}</span>
    </label>
  );
}
