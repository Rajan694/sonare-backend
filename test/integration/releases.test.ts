import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminUser, createUser } from '../factories.js';
import { releasesDir } from '../../src/services/releases.js';

describe('App releases: admin upload, public list and download', () => {
  const app = createApp();

  afterAll(() => fs.rmSync(releasesDir(), { recursive: true, force: true }));

  function upload(token: string, query: Record<string, string>, body: Buffer) {
    return request(app)
      .post('/api/v1/admin/releases')
      .query(query)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
  }

  it('BE-REL-001: POST /api/v1/admin/releases stores the file with its size and sha256', async () => {
    const { token } = await createAdminUser();
    const body = Buffer.from('fake apk bytes');
    const res = await upload(token, { platform: 'android', version: '1.2.0', fileName: 'app-release.apk' }, body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      platform: 'android',
      format: 'apk',
      version: '1.2.0',
      fileName: 'app-release.apk',
      sizeBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    });
    expect(fs.existsSync(`${releasesDir()}/${res.body.id}.apk`)).toBe(true);
  });

  it('BE-REL-002: POST /api/v1/admin/releases rejects a file type the platform does not take', async () => {
    const { token } = await createAdminUser();
    const res = await upload(
      token,
      { platform: 'windows', version: '1.0.0', fileName: 'sonare.deb' },
      Buffer.from('x'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('.exe');
  });

  it('BE-REL-003: POST /api/v1/admin/releases rejects a bad version and an empty file', async () => {
    const { token } = await createAdminUser();
    const badVersion = await upload(
      token,
      { platform: 'linux', version: '../1', fileName: 'sonare.tar.gz' },
      Buffer.from('x'),
    );
    expect(badVersion.status).toBe(400);

    const empty = await upload(token, { platform: 'linux', version: '1.0.0', fileName: 'sonare.deb' }, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe('The file is empty');
  });

  it('BE-REL-004: POST /api/v1/admin/releases refuses files over RELEASE_MAX_MB with 413', async () => {
    const { token } = await createAdminUser();
    const res = await upload(
      token,
      { platform: 'windows', version: '1.0.0', fileName: 'sonare.exe' },
      Buffer.alloc(1024 * 1024 + 1),
    );
    expect(res.status).toBe(413);
    expect(fs.readdirSync(releasesDir()).filter((f) => f.startsWith('.upload-'))).toEqual([]);
  });

  it('BE-REL-005: POST /api/v1/admin/releases needs an admin token', async () => {
    const { token } = await createUser();
    const res = await upload(token, { platform: 'android', version: '1.0.0', fileName: 'a.apk' }, Buffer.from('x'));
    expect(res.status).toBe(401);
  });

  it('BE-REL-006: uploading the same platform, format and version again replaces the file', async () => {
    const { token } = await createAdminUser();
    const q = { platform: 'linux', version: '2.0.0', fileName: 'sonare.AppImage' };
    const first = await upload(token, q, Buffer.from('one'));
    const second = await upload(token, q, Buffer.from('second build'));

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.sizeBytes).toBe(12);
    const list = await request(app).get('/api/v1/admin/releases').set('Authorization', `Bearer ${token}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.accepts.linux).toContain('.deb');
  });

  it('BE-REL-007: GET /api/v1/releases lists the newest build of each platform and format', async () => {
    const { token } = await createAdminUser();
    await upload(token, { platform: 'android', version: '1.0.0', fileName: 'a.apk' }, Buffer.from('old'));
    await new Promise((r) => setTimeout(r, 10));
    await upload(token, { platform: 'android', version: '1.1.0', fileName: 'a.apk' }, Buffer.from('new'));
    await upload(token, { platform: 'windows', version: '1.0.0', fileName: 'Sonare Setup.exe' }, Buffer.from('w'));

    const res = await request(app).get('/api/v1/releases');
    expect(res.status).toBe(200);
    const byPlatform = Object.fromEntries(res.body.items.map((r: { platform: string }) => [r.platform, r]));
    expect(res.body.items).toHaveLength(2);
    expect(byPlatform.android.version).toBe('1.1.0');
    expect(byPlatform.windows.fileName).toBe('Sonare_Setup.exe');
    expect(byPlatform.android).not.toHaveProperty('downloads');
  });

  it('BE-REL-008: GET /api/v1/releases/:id/download serves the file and counts the download', async () => {
    const { token } = await createAdminUser();
    const body = Buffer.from('apk contents');
    const up = await upload(token, { platform: 'android', version: '1.0.0', fileName: 'sonare.apk' }, body);

    const res = await request(app)
      .get(`/api/v1/releases/${up.body.id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('sonare.apk');
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(Buffer.compare(res.body, body)).toBe(0);

    const list = await request(app).get('/api/v1/admin/releases').set('Authorization', `Bearer ${token}`);
    expect(list.body.items[0].downloads).toBe(1);
  });

  it('BE-REL-009: GET /api/v1/releases/:id/download answers 404 for an unknown id', async () => {
    const res = await request(app).get(`/api/v1/releases/${crypto.randomUUID()}/download`);
    expect(res.status).toBe(404);
    const bad = await request(app).get('/api/v1/releases/not-an-id/download');
    expect(bad.status).toBe(404);
  });

  it('BE-REL-010: DELETE /api/v1/admin/releases/:id removes the row and the file', async () => {
    const { token } = await createAdminUser();
    const up = await upload(token, { platform: 'linux', version: '1.0.0', fileName: 'sonare.deb' }, Buffer.from('d'));
    const file = `${releasesDir()}/${up.body.id}.deb`;
    expect(fs.existsSync(file)).toBe(true);

    const del = await request(app)
      .delete(`/api/v1/admin/releases/${up.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    expect(fs.existsSync(file)).toBe(false);

    const again = await request(app)
      .delete(`/api/v1/admin/releases/${up.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(404);
  });
});
