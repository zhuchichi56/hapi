import type { CodexModelsResponse, CodexModelSummary } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { getErrorMessage } from './rpcResponses';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ListCodexModelsRequest {
    includeHidden?: boolean;
}

export type ListCodexModelsResponse = CodexModelsResponse;

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSupportedReasoningEfforts(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const efforts = value
        .map((entry) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const reasoningEffort = asNonEmptyString((entry as { reasoningEffort?: unknown }).reasoningEffort);
            return reasoningEffort;
        })
        .filter((entry): entry is string => entry !== null);

    return efforts.length > 0 ? efforts : undefined;
}

// The Codex model catalog advertises which service tiers are available for a
// model in the *current* account/auth context — e.g. an API-key session or a
// plan without Fast credits simply won't list a Fast tier. We surface the tier
// id AND display name as lowercased search tokens so the web can gate the
// Fast-mode toggle on real availability. The Fast tier's catalog id is
// `'priority'` but its name is `'Fast'`, so capturing the name is what lets a
// `/fast/i` match recognise it. (See OpenAI Codex speed docs: Fast maps to the
// request value `priority`.)
function normalizeServiceTiers(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const tokens = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const record = entry as { id?: unknown; name?: unknown };
        const id = asNonEmptyString(record.id);
        const name = asNonEmptyString(record.name);
        if (id) tokens.add(id.toLowerCase());
        if (name) tokens.add(name.toLowerCase());
    }

    return tokens.size > 0 ? [...tokens] : undefined;
}

function normalizeModel(entry: unknown): CodexModelSummary | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const record = entry as Record<string, unknown>;
    const id = asNonEmptyString(record.id) ?? asNonEmptyString(record.model);
    if (!id) {
        return null;
    }

    return {
        id,
        displayName: asNonEmptyString(record.displayName) ?? id,
        isDefault: record.isDefault === true,
        defaultReasoningEffort: asNonEmptyString(record.defaultReasoningEffort),
        defaultServiceTier: asNonEmptyString(record.defaultServiceTier),
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(record.supportedReasoningEfforts),
        serviceTiers: normalizeServiceTiers(record.serviceTiers)
    };
}

async function listCopilotProxyModels(): Promise<CodexModelSummary[]> {
    const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    const config = Bun.TOML.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    if (config.model_provider !== 'copilot') return [];

    const providers = config.model_providers as Record<string, { base_url?: string }> | undefined;
    const baseUrl = providers?.copilot?.base_url;
    if (!baseUrl) return [];

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) return [];
    const catalog = await response.json() as { data?: unknown[] };
    return (catalog.data ?? [])
        .map(normalizeModel)
        .filter((model): model is CodexModelSummary => model?.id === 'gpt-6.1-sol');
}

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    const client = new CodexAppServerClient();

    try {
        await client.connect();
        await client.initialize({
            clientInfo: {
                name: 'hapi-codex-models',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        const response = await client.listModels({ includeHidden });
        const models = Array.isArray(response.data)
            ? response.data.map(normalizeModel).filter((model): model is CodexModelSummary => model !== null)
            : [];

        // Codex App Server can lag behind a custom provider's live model catalog.
        // Only add the requested model when the active local Copilot proxy advertises it.
        const proxyModels = await listCopilotProxyModels().catch(() => []);
        return [...models, ...proxyModels.filter((model) => !models.some((entry) => entry.id === model.id))];
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Codex models'));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
