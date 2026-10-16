import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { parseBody } from '../validation.js';
import {
  aiAvailable,
  aiProviderView,
  createAiProvider,
  deleteAiProvider,
  getAiProvider,
  listAiProviders,
  reorderAiProviders,
  updateAiProvider,
} from '../services/ai/providers.js';
import { checkAiProvider } from '../services/ai/health.js';
import { aiUsageReport } from '../services/ai/usage.js';

// The admin page's AI section: mounted at /admin/ai behind requireAdmin (admin.routes.ts).
export const adminAiRouter = Router();

const notFound = (res: Response) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No AI provider with that id' } });

const listResponse = () => ({ providers: listAiProviders().map(aiProviderView), available: aiAvailable() });

const urlSchema = z
  .string({ required_error: 'Enter the URL', invalid_type_error: 'URL must be a string' })
  .trim()
  .max(2048, 'URL is too long (at most 2048 characters)')
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be a valid http or https URL');
const fields = {
  name: z.string({ required_error: 'Enter a name' }).trim().min(1, 'Enter a name').max(60, 'At most 60 characters'),
  baseUrl: urlSchema,
  apiKey: z
    .string({ required_error: 'Enter the API key' })
    .trim()
    .min(1, 'Enter the API key')
    .max(500, 'Key is too long'),
  model: z
    .string({ required_error: 'Enter the model' })
    .trim()
    .min(1, 'Enter the model')
    .max(200, 'At most 200 characters'),
  enabled: z.boolean({ invalid_type_error: 'enabled must be true or false' }),
};
const createSchema = z.object({ ...fields, enabled: fields.enabled.optional() });
const patchSchema = z
  .object({
    name: fields.name.optional(),
    baseUrl: fields.baseUrl.optional(),
    apiKey: fields.apiKey.optional(),
    model: fields.model.optional(),
    enabled: fields.enabled.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update' });
const orderSchema = z.object({ ids: z.array(z.string().uuid('Unknown provider id')).max(50) });

/** A new or changed provider is checked at once, so the page shows whether it works. */
const checkSoon = (id: string) => void checkAiProvider(id);

adminAiRouter.get('/providers', (_req, res) => {
  res.json(listResponse());
});

adminAiRouter.post('/providers', async (req, res) => {
  const body = parseBody(createSchema, req);
  const created = await createAiProvider(body);
  if (created.enabled) checkSoon(created.id);
  res.status(201).json(aiProviderView(created));
});

adminAiRouter.patch('/providers/:id', async (req, res) => {
  const current = getAiProvider(req.params.id);
  if (!current) return notFound(res);
  const body = parseBody(patchSchema, req);
  const setup = (['baseUrl', 'apiKey', 'model'] as const).some((k) => body[k] !== undefined && body[k] !== current[k]);
  const turnedOn = body.enabled === true && !current.enabled;
  const reset = setup || turnedOn ? { status: 'unknown', failures: 0, retryAt: null, lastError: null } : {};
  const updated = await updateAiProvider(current.id, { ...body, ...reset });
  if (updated && updated.enabled && (setup || turnedOn)) checkSoon(updated.id);
  res.json(aiProviderView(updated!));
});

adminAiRouter.delete('/providers/:id', async (req, res) => {
  if (!getAiProvider(req.params.id)) return notFound(res);
  await deleteAiProvider(req.params.id);
  res.json({ ok: true });
});

adminAiRouter.post('/providers/:id/check', async (req, res) => {
  const result = await checkAiProvider(req.params.id);
  if (!result) return notFound(res);
  res.json({ ...result, provider: aiProviderView(getAiProvider(req.params.id)!) });
});

adminAiRouter.put('/providers/order', async (req, res) => {
  const { ids } = parseBody(orderSchema, req);
  const current = listAiProviders().map((p) => p.id);
  const same =
    ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
  if (!same) {
    return res
      .status(400)
      .json({ error: { code: 'BAD_REQUEST', message: 'Send every provider id once, in the new order' } });
  }
  await reorderAiProviders(ids);
  res.json(listResponse());
});

/** GET /admin/analytics/ai?days= (mounted in admin.routes.ts with the other analytics). */
export const aiUsageHandler = async (req: Request, res: Response) => {
  const n = Number(req.query.days);
  const days = Number.isFinite(n) ? Math.min(90, Math.max(1, Math.round(n))) : 30;
  res.json(await aiUsageReport(days));
};
