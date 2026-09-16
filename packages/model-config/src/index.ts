import catalogData from './models.json' with { type: 'json' };
import type { ModelCatalog, ModelEntry } from '@promptslim/shared-types';

/**
 * Centralized model + pricing configuration.
 * This is the single source of truth for prices — UI components must never
 * hardcode pricing assumptions. To add a model, edit models.json only.
 */
export const catalog = catalogData as ModelCatalog;

export const models: ModelEntry[] = catalog.models;

export function getModel(id: string): ModelEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

export const defaultModelId = 'gpt-5.4';

export const providers: string[] = Array.from(new Set(catalog.models.map((m) => m.provider)));
