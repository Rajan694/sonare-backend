import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { createApp } from '../../src/app.js';
import { createUser, isLocalTestHost } from '../factories.js';
import { Piped } from '../../src/upstream/piped.js';
import { CachedPiped, PermanentCache } from '../../src/services/cache.js';
import { CANONICAL_BARS, placeholderPeaks, resamplePeaks } from '../../src/services/peaks.js';

describe('Peaks API (GET & PUT /tracks/:id/peaks)', () => {
  const app = createApp();
  let mockAgent: MockAgent | null = null;
  const originalDispatcher = getGlobalDispatcher();

  const PINNED_8_BARS = [
    0.3, 0.3764484801310155, 0.7973107469500973, 0.5106853423154952, 1, 0.6851863099242606, 0.8997021298622712,
    0.7015426778913516,
  ];

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockAgent.enableNetConnect(isLocalTestHost);
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockAgent) {
      await mockAgent.close();
      mockAgent = null;
    }
    setGlobalDispatcher(originalDispatcher);
  });

  it('BE-PEAK-006: GET /tracks/:id/peaks with nothing cached returns placeholder:true and makes NO Piped calls', async () => {
    let pipedHttpCalls = 0;
    const pipedMock = mockAgent!.get('http://localhost:8090');
    pipedMock.intercept({ path: /.*/, method: () => true }).reply(() => {
      pipedHttpCalls++;
      return { statusCode: 500, data: {} };
    });

    const pipedSpy = vi.spyOn(Piped, 'getStream');
    const cachedPipedSpy = vi.spyOn(CachedPiped, 'getStream');

    const res = await request(app).get('/api/v1/tracks/yt:uncachedTrack123/peaks');

    expect(res.status).toBe(200);
    expect(res.body.placeholder).toBe(true);
    expect(Array.isArray(res.body.peaks)).toBe(true);
    expect(res.body.peaks).toHaveLength(CANONICAL_BARS);
    expect(res.body.peaks).toEqual(placeholderPeaks('yt:uncachedTrack123', CANONICAL_BARS));

    expect(pipedSpy).not.toHaveBeenCalled();
    expect(cachedPipedSpy).not.toHaveBeenCalled();
    expect(pipedHttpCalls).toBe(0);
  });

  it('BE-PEAK-007: PUT stores canonical 150 bars waveform then GET returns it resampled to 76 bars (max-pool check)', async () => {
    const { token } = await createUser();
    const trackId = 'yt:uploadTestTrack1';
    const rawId = 'uploadTestTrack1';

    // Canonical 150 bars array with known values
    const canonicalPeaks = Array.from({ length: CANONICAL_BARS }, (_, i) =>
      Number((Math.sin(i / 10) * 0.4 + 0.5).toFixed(4)),
    );

    const putRes = await request(app)
      .put(`/api/v1/tracks/${trackId}/peaks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ peaks: canonicalPeaks });

    expect(putRes.status).toBe(201);
    expect(putRes.body).toEqual({ stored: true });

    // Verify stored in PermanentCache
    const cached = await PermanentCache.getPeaks(rawId);
    expect(cached).toEqual(canonicalPeaks);

    // GET resampled to 76 bars
    const getRes = await request(app).get(`/api/v1/tracks/${trackId}/peaks?bars=76`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.placeholder).toBe(false);
    expect(getRes.body.peaks).toHaveLength(76);
    expect(getRes.body.peaks).toEqual(resamplePeaks(canonicalPeaks, 76));

    // Verify max-pool behavior on a specific segment
    // Bar 0 of 76 covers indices [0, 1) in 150: max is canonicalPeaks[0]
    // Bar 1 of 76 covers indices [1, 3) in 150: max is Math.max(canonicalPeaks[1], canonicalPeaks[2])
    expect(getRes.body.peaks[0]).toBe(canonicalPeaks[0]);
    expect(getRes.body.peaks[1]).toBe(Math.max(canonicalPeaks[1], canonicalPeaks[2]));
  });

  it('BE-PEAK-008: second PUT returns stored:false and first uploaded waveform stays unchanged', async () => {
    const { token } = await createUser();
    const trackId = 'yt:secondPutTrack1';

    const firstPeaks = Array.from({ length: CANONICAL_BARS }, () => 0.75);
    const secondPeaks = Array.from({ length: CANONICAL_BARS }, () => 0.25);

    const firstPut = await request(app)
      .put(`/api/v1/tracks/${trackId}/peaks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ peaks: firstPeaks });
    expect(firstPut.status).toBe(201);
    expect(firstPut.body).toEqual({ stored: true });

    const secondPut = await request(app)
      .put(`/api/v1/tracks/${trackId}/peaks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ peaks: secondPeaks });
    expect(secondPut.status).toBe(200);
    expect(secondPut.body).toEqual({ stored: false });

    // GET returns first peaks
    const getRes = await request(app).get(`/api/v1/tracks/${trackId}/peaks?bars=150`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.placeholder).toBe(false);
    expect(getRes.body.peaks).toEqual(firstPeaks);
  });

  it('BE-PEAK-009: PUT /tracks/:id/peaks requires authentication (401 without auth)', async () => {
    const peaks = Array.from({ length: CANONICAL_BARS }, () => 0.5);
    const res = await request(app).put('/api/v1/tracks/yt:unauthTrack1/peaks').send({ peaks });
    expect(res.status).toBe(401);
  });

  it('BE-PEAK-010: PUT /tracks/:id/peaks rejects invalid body (149 values, NaN, 1.5, negative, non-array) with 400', async () => {
    const { token } = await createUser();
    const auth = `Bearer ${token}`;

    // 149 values
    const res149 = await request(app)
      .put('/api/v1/tracks/yt:badTrack1/peaks')
      .set('Authorization', auth)
      .send({ peaks: Array.from({ length: 149 }, () => 0.5) });
    expect(res149.status).toBe(400);

    // 151 values
    const res151 = await request(app)
      .put('/api/v1/tracks/yt:badTrack1/peaks')
      .set('Authorization', auth)
      .send({ peaks: Array.from({ length: 151 }, () => 0.5) });
    expect(res151.status).toBe(400);

    // NaN in array
    const peaksNaN = Array.from({ length: 150 }, () => 0.5);
    peaksNaN[10] = NaN as unknown as number;
    const resNaN = await request(app)
      .put('/api/v1/tracks/yt:badTrack1/peaks')
      .set('Authorization', auth)
      .send({ peaks: peaksNaN });
    expect(resNaN.status).toBe(400);

    // Value > 1.0 (1.5)
    const peaks15 = Array.from({ length: 150 }, () => 0.5);
    peaks15[5] = 1.5;
    const res15 = await request(app)
      .put('/api/v1/tracks/yt:badTrack1/peaks')
      .set('Authorization', auth)
      .send({ peaks: peaks15 });
    expect(res15.status).toBe(400);

    // Value < 0 (-0.1)
    const peaksNeg = Array.from({ length: 150 }, () => 0.5);
    peaksNeg[5] = -0.1;
    const resNeg = await request(app)
      .put('/api/v1/tracks/yt:badTrack1/peaks')
      .set('Authorization', auth)
      .send({ peaks: peaksNeg });
    expect(resNeg.status).toBe(400);

    // Empty body
    const resEmpty = await request(app).put('/api/v1/tracks/yt:badTrack1/peaks').set('Authorization', auth).send({});
    expect(resEmpty.status).toBe(400);
  });

  it('BE-PEAK-011: GET /tracks/:id/peaks?bars=8 matches pinned placeholder literal', async () => {
    const res = await request(app).get('/api/v1/tracks/yt:NJAv_7lHUIU/peaks?bars=8');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      peaks: PINNED_8_BARS,
      placeholder: true,
    });
  });
});
