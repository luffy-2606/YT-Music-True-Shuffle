/**
 * YouTube Music internal API (Innertube) client.
 *
 * Reverse-engineered from YouTube Music's own network traffic.
 * See RESEARCH.md for a detailed breakdown of how each endpoint works.
 *
 * Key endpoints used:
 *   POST /youtubei/v1/browse                 — fetch playlist tracks (+ pagination)
 *   POST /youtubei/v1/browse/edit_playlist   — reorder / remove / add tracks
 */

import { logger } from '../utils/logger';
import { generateSAPIHASH } from '../utils/crypto';
import { getSapisid, retry, sleep, safeJsonParse } from '../utils/dom';
import type {
  BrowseResponse,
  EditPlaylistResponse,
  InnertubeContext,
  PlaylistEditAction,
  PlaylistTrack,
  YtCfgData,
} from './types';

const BASE_URL = 'https://music.youtube.com/youtubei/v1';

/**
 * Sentinel value YouTube Music uses internally for tracks whose setVideoId
 * could not be resolved at render time. If this leaks into our actions array
 * it causes an immediate HTTP 400 INVALID_ARGUMENT from edit_playlist.
 */
const PLACEHOLDER_SET_VIDEO_ID = 'to_be_updated_by_client';

/**
 * Fallback values used when ytcfg extraction fails.
 * The API key is the public WEB_REMIX key — it is NOT a secret.
 */
const FALLBACK = {
  API_KEY: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-KKTKVNF0A',
  CLIENT_VERSION: '1.20240101.01.00',
  CLIENT_NAME: 'WEB_REMIX',
  CLIENT_ID: '67', // Numeric ID for WEB_REMIX
} as const;

const FALLBACK_CONTEXT: InnertubeContext = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.01.00',
    hl: 'en',
    gl: 'US',
    platform: 'DESKTOP',
    originalUrl: 'https://music.youtube.com/',
  },
  user: {
    lockedSafetyMode: false,
  },
  request: {
    useSsl: true,
  },
};

/** Minimum ms between individual API requests (≈5 req/sec). */
const REQUEST_GAP_MS = 200;

// ─────────────────────────────────────────────────────────────────────────────

export class YtMusicApiClient {
  private cfg: Partial<YtCfgData> = {};
  private lastRequestAt = 0;

  // ─── Initialisation ─────────────────────────────────────────────────────

  /**
   * Initialise the API client by reading ytcfg from the page.
   *
   * WHY THIS MATTERS FOR WRITE OPERATIONS:
   *   YouTube Music allows unauthenticated or partially-authenticated reads
   *   (browse, continuation) but requires a valid `visitorData` for mutations
   *   (edit_playlist). Without it, every edit_playlist call returns HTTP 400
   *   INVALID_ARGUMENT regardless of how correct the action payload is.
   *
   * Strategy (fastest-first, no unnecessary injection):
   *   1. Parse ytcfg.set({...}) calls directly from DOM <script> tags — instant,
   *      no injection, works on content scripts because they can read DOM text.
   *   2. If that yields nothing, fall back to the postMessage injection approach.
   *   3. If that also times out, use hardcoded fallback values (read-only ops only).
   */
  async initialize(): Promise<void> {
    // ── Strategy 1: Read ytcfg from script tags in the DOM ────────────────
    let extracted = this.tryReadYtCfgFromDom();

    // ── Strategy 2: postMessage injection (if DOM read didn't find the key) ─
    if (!extracted.INNERTUBE_API_KEY && !extracted.VISITOR_DATA) {
      logger.debug('DOM ytcfg read found nothing — trying script injection');
      try {
        extracted = await this.extractYtCfg();
      } catch (err) {
        logger.warn('Script injection approach also failed', err);
      }
    }

    this.cfg = {
      INNERTUBE_CONTEXT:
        (extracted as any).INNERTUBE_CONTEXT ?? FALLBACK_CONTEXT,
      INNERTUBE_API_KEY:
        extracted.INNERTUBE_API_KEY ?? FALLBACK.API_KEY,
      INNERTUBE_CLIENT_VERSION:
        extracted.INNERTUBE_CLIENT_VERSION ?? FALLBACK.CLIENT_VERSION,
      INNERTUBE_CONTEXT_CLIENT_NAME:
        extracted.INNERTUBE_CONTEXT_CLIENT_NAME ?? FALLBACK.CLIENT_NAME,
      VISITOR_DATA: extracted.VISITOR_DATA,
    } as YtCfgData;

    logger.info('API client initialised', {
      source: extracted.INNERTUBE_API_KEY ? 'ytcfg' : 'fallback',
      hasVisitorData: !!this.cfg.VISITOR_DATA,
      clientVersion: this.cfg.INNERTUBE_CLIENT_VERSION,
    });

    if (!this.cfg.VISITOR_DATA) {
      // This is the root cause of HTTP 400 on edit_playlist. Warn loudly.
      logger.warn(
        'visitorData not found in ytcfg — edit_playlist calls WILL return 400. ' +
          'Check that ytcfg-bootstrap.js is listed in web_accessible_resources ' +
          'and that the content script runs after DOMContentLoaded.'
      );
    }
  }

  /**
   * Parse ytcfg.set({...}) calls directly from <script> tags in the DOM.
   *
   * Content scripts run in an isolated JS world and cannot read window.ytcfg,
   * but they CAN read DOM node text content — so we parse the raw script text.
   *
   * Uses a bracket-depth counter rather than a regex so nested objects are
   * handled correctly regardless of whitespace or line breaks.
   */
  private tryReadYtCfgFromDom(): Partial<YtCfgData> {
    try {
      const scripts = Array.from(
        document.querySelectorAll<HTMLScriptElement>('script')
      );
      const merged: Record<string, unknown> = {};

      for (const script of scripts) {
        const text = script.textContent ?? '';
        let searchFrom = 0;

        while (true) {
          const callStart = text.indexOf('ytcfg.set(', searchFrom);
          if (callStart === -1) break;

          const braceStart = text.indexOf('{', callStart + 10);
          if (braceStart === -1) {
            searchFrom = callStart + 10;
            break;
          }

          // Walk through characters counting bracket depth to find the
          // matching closing brace (handles nested objects correctly).
          let depth = 0;
          let braceEnd = -1;
          for (let i = braceStart; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') {
              depth--;
              if (depth === 0) {
                braceEnd = i;
                break;
              }
            }
          }

          if (braceEnd !== -1) {
            try {
              const data = JSON.parse(text.slice(braceStart, braceEnd + 1));
              Object.assign(merged, data);
            } catch {
              // Malformed JSON in this ytcfg call — skip it
            }
          }

          searchFrom =
            braceEnd !== -1 ? braceEnd + 1 : callStart + 10;
        }
      }

      if (merged.INNERTUBE_API_KEY || merged.VISITOR_DATA) {
        logger.debug('ytcfg read from DOM script tags', {
          hasApiKey: !!merged.INNERTUBE_API_KEY,
          hasVisitorData: !!merged.VISITOR_DATA,
          clientVersion: merged.INNERTUBE_CLIENT_VERSION,
        });
      }

      return merged as Partial<YtCfgData>;
    } catch (err) {
      logger.warn('tryReadYtCfgFromDom threw unexpectedly', err);
      return {};
    }
  }

  /**
   * Inject a <script> into the page's main world to read window.ytcfg,
   * then receive the data via postMessage.
   */
  private extractYtCfg(): Promise<Partial<YtCfgData>> {
    return new Promise(resolve => {
      const MSG_TYPE = '__YTMS_YTCFG__';

      const handler = (evt: MessageEvent) => {
        if (evt.source !== window) return;
        if (typeof evt.data !== 'object' || evt.data?.type !== MSG_TYPE) return;
        window.removeEventListener('message', handler);
        clearTimeout(fallbackTimer);
        resolve((evt.data.payload as Partial<YtCfgData>) ?? {});
      };

      window.addEventListener('message', handler);

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('ytcfg-bootstrap.js');
      document.documentElement.appendChild(script);
      script.remove();

      // Fallback if the postMessage never arrives
      const fallbackTimer = setTimeout(() => {
        window.removeEventListener('message', handler);
        logger.warn('ytcfg extraction timed out — using fallback config');
        resolve({});
      }, 3000);
    });
  }

  // ─── Auth / Headers ─────────────────────────────────────────────────────

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Origin': 'https://music.youtube.com',
      // Referer must reflect the actual playlist page, not a static origin.
      // YouTube Music validates this on write operations.
      'Referer': window.location.href,
      'X-Goog-AuthUser': '0',
      'X-Youtube-Client-Name': FALLBACK.CLIENT_ID,
      'X-Youtube-Client-Version':
        this.cfg.INNERTUBE_CLIENT_VERSION ??
        (this.cfg as any).INNERTUBE_CONTEXT_CLIENT_VERSION ??
        FALLBACK.CLIENT_VERSION,
    };

    // visitorData is required for edit_playlist — omitting it causes HTTP 400.
    if (this.cfg.VISITOR_DATA) {
      headers['X-Goog-Visitor-Id'] = this.cfg.VISITOR_DATA;
    }

    const sapisid = getSapisid();
    if (sapisid) {
      try {
        headers['Authorization'] = await generateSAPIHASH(sapisid);
      } catch (err) {
        logger.warn('Failed to compute SAPISIDHASH, request may fail', err);
      }
    } else {
      logger.warn('No SAPISID cookie — is the user signed in?');
    }

    return headers;
  }

  /**
   * Build the Innertube context object for this request.
   * Always uses the real current page URL so YouTube Music can validate origin.
   */
  private buildContext(): InnertubeContext {
    const base: InnertubeContext =
      (this.cfg as any).INNERTUBE_CONTEXT ?? FALLBACK_CONTEXT;

    return {
      ...base,
      client: {
        ...base.client,
        // Use the actual page URL — YouTube validates this for mutations.
        originalUrl: window.location.href,
        // Include visitorData in the context body if we have it.
        ...(this.cfg.VISITOR_DATA
          ? { visitorData: this.cfg.VISITOR_DATA }
          : {}),
      },
    };
  }

  // ─── Core request ────────────────────────────────────────────────────────

  /**
   * POST to an Innertube endpoint with automatic retry on transient errors.
   *
   * NOTE: retry() is called here and ONLY here. Callers (editPlaylist,
   * browsePlaylist, etc.) must NOT wrap their calls in an additional retry —
   * doing so creates nested retry loops (3×3 = 9 requests per failure).
   */
  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const apiKey = this.cfg.INNERTUBE_API_KEY ?? FALLBACK.API_KEY;
    const url = `${BASE_URL}/${endpoint}?key=${apiKey}&prettyPrint=false`;

    return retry(async () => {
      // Enforce global rate limit
      const gap = Date.now() - this.lastRequestAt;
      if (gap < REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS - gap);

      const headers = await this.buildHeaders();

      // Use buildContext() so originalUrl and visitorData are always current.
      const payload = {
        context: this.buildContext(),
        ...body,
      };

      logger.debug(`POST /${endpoint}`, {
        bodyKeys: Object.keys(payload).join(', '),
      });

      // For edit_playlist, log the first action so we can confirm the shape
      // without flooding the console with all N actions.
      if (endpoint.includes('edit_playlist')) {
        const actions = (payload as any).actions as unknown[] | undefined;
        logger.info(`[editPlaylist] playlistId=${(payload as any).playlistId}, actions=${actions?.length}, first=`, actions?.[0]);
      }

      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include', // sends all youtube.com cookies automatically
        headers,
        body: JSON.stringify(payload),
      });

      this.lastRequestAt = Date.now();

      if (!res.ok) {
        const text = await res.text();
        const snippet = text.slice(0, 300);
        throw new Error(
          `HTTP ${res.status} ${res.statusText} from /${endpoint}: ${snippet}`
        );
      }

      const json = safeJsonParse<T>(await res.text());
      if (json === null) {
        throw new Error(`Non-JSON response from /${endpoint}`);
      }
      return json;
    }, 3, 1500);
  }

  // ─── Public API methods ──────────────────────────────────────────────────

  /** Fetch the first page of a playlist. browseId = "VL" + playlistId */
  async browsePlaylist(playlistId: string): Promise<BrowseResponse> {
    const browseId = playlistId.startsWith('VL')
      ? playlistId
      : `VL${playlistId}`;

    logger.info(`Browsing playlist: ${browseId}`);

    return this.post<BrowseResponse>('browse', { browseId });
  }

  /** Fetch the next continuation page. */
  async browsePlaylistContinuation(
    continuation: string
  ): Promise<BrowseResponse> {
    return this.post<BrowseResponse>('browse', { continuation });
  }

  /**
   * Edit a playlist (reorder, remove, add tracks).
   *
   * @param playlistId - Raw playlist ID (e.g. "PLxxx"), WITHOUT the "VL" prefix.
   * @param actions    - Array of edit actions (batched for efficiency).
   *
   * IMPORTANT: Do NOT wrap calls to this method in retry(). The underlying
   * post() already retries up to 3 times. A double-wrapped retry produces
   * up to 9 network requests per failed batch, causing confusing log output
   * and thrashing the rate limit.
   */
  async editPlaylist(
    playlistId: string,
    actions: PlaylistEditAction[]
  ): Promise<EditPlaylistResponse> {
    logger.debug(
      `editPlaylist(${playlistId}) — ${actions.length} action(s)`
    );
    return this.post<EditPlaylistResponse>('browse/edit_playlist', {
      playlistId,
      actions,
    });
  }

  // ─── Response parsing ────────────────────────────────────────────────────

  /**
   * Extract PlaylistTrack array and next continuation token from a raw
   * browse (or continuation) API response.
   */
  extractTracks(
    response: BrowseResponse,
    startIndex: number = 0
  ): { tracks: PlaylistTrack[]; continuation: string | null } {
    const tracks: PlaylistTrack[] = [];
    let continuation: string | null = null;

    // ─────────────────────────────────────────────
    // 1. COLLECT ALL POSSIBLE ITEM CONTAINERS
    // ─────────────────────────────────────────────

    const candidates: unknown[] = [];

    const pushIfExists = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      candidates.push(obj);
    };

    pushIfExists(
      response?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
        ?.tabRenderer?.content
    );
    pushIfExists(response?.continuationContents);
    pushIfExists(response?.contents);
    pushIfExists(response);

    // ─────────────────────────────────────────────
    // 2. FIND ALL RENDERERS RECURSIVELY
    // ─────────────────────────────────────────────

    const items: Record<string, unknown>[] = [];

    const findResponsiveItems = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;

      if (obj.musicResponsiveListItemRenderer) {
        items.push(obj.musicResponsiveListItemRenderer);
      }

      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === 'object') {
          findResponsiveItems(val);
        }
      }
    };

    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;

      if (node.musicResponsiveListItemRenderer) {
        items.push(node.musicResponsiveListItemRenderer);
      }

      if (node.musicShelfRenderer?.contents) {
        for (const c of node.musicShelfRenderer.contents) walk(c);
      }

      if (node.musicPlaylistShelfRenderer?.contents) {
        for (const c of node.musicPlaylistShelfRenderer.contents) walk(c);
      }

      if (Array.isArray(node.contents)) {
        for (const c of node.contents) walk(c);
      }

      if (Array.isArray(node.tabs)) {
        for (const t of node.tabs) walk(t);
      }

      if (Array.isArray(node.sectionListRenderer?.contents)) {
        for (const c of node.sectionListRenderer.contents) walk(c);
      }
    };

    findResponsiveItems(response);
    for (const c of candidates) walk(c);

    // ─────────────────────────────────────────────
    // 3. PARSE TRACKS
    // ─────────────────────────────────────────────

    for (let i = 0; i < items.length; i++) {
      const track = this.parseTrackItem(items[i], startIndex + i);
      if (track) tracks.push(track);
    }

    // ─────────────────────────────────────────────
    // 4. CONTINUATION TOKEN (ROBUST)
    // ─────────────────────────────────────────────

    const findContinuation = (obj: any): string | null => {
      if (!obj || typeof obj !== 'object') return null;

      if (obj.continuation) return obj.continuation;

      if (obj.nextContinuationData?.continuation) {
        return obj.nextContinuationData.continuation;
      }

      if (obj.continuations?.[0]?.nextContinuationData?.continuation) {
        return obj.continuations[0].nextContinuationData.continuation;
      }

      for (const key of Object.keys(obj)) {
        const val = findContinuation(obj[key]);
        if (val) return val;
      }

      return null;
    };

    continuation =
      findContinuation(response.continuationContents) ||
      findContinuation(response) ||
      null;

    // ─────────────────────────────────────────────
    // 5. DEBUG LOGGING
    // ─────────────────────────────────────────────

    logger.debug(
      `[extractTracks] found ${tracks.length} tracks, continuation=${!!continuation}`
    );

    if (tracks.length === 0) {
      logger.warn(
        '[extractTracks] ZERO TRACKS FOUND — dumping response shape keys:',
        Object.keys(response || {})
      );
      // FIX: Also log the continuationContents shape so we can diagnose
      // the page-3 zero-track issue. The top-level keys alone aren't enough.
      if (response?.continuationContents) {
        logger.warn(
          '[extractTracks] continuationContents keys:',
          Object.keys(response.continuationContents)
        );
      }
    }

    return { tracks, continuation };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private parseTrackItem(
    renderer: Record<string, unknown> | undefined | null,
    index: number
  ): PlaylistTrack | null {
    if (!renderer) return null;

    // ── 1. playlistItemData (preferred)
    const pid = renderer['playlistItemData'] as
      | Record<string, unknown>
      | undefined;
    let videoId = pid?.['videoId'] as string | undefined;
    let setVideoId = pid?.['playlistSetVideoId'] as string | undefined;

    // ── 2. Overlay watchEndpoint
    if (!setVideoId) {
      const endpoint = this.deepGet<Record<string, unknown>>(renderer, [
        'overlay',
        'musicItemThumbnailOverlayRenderer',
        'content',
        'musicPlayButtonRenderer',
        'playNavigationEndpoint',
        'watchEndpoint',
      ]);
      if (endpoint) {
        videoId = videoId ?? (endpoint['videoId'] as string | undefined);
        setVideoId = endpoint['playlistSetVideoId'] as string | undefined;
      }
    }

    // ── 3. Menu ACTION_REMOVE_VIDEO
    if (!setVideoId) {
      const menuItems =
        this.deepGet<unknown[]>(renderer, [
          'menu',
          'menuRenderer',
          'items',
        ]) ?? [];

      for (const raw of menuItems) {
        const item = raw as Record<string, unknown>;
        const actions =
          this.deepGet<Array<Record<string, unknown>>>(item, [
            'menuServiceItemRenderer',
            'serviceEndpoint',
            'playlistEditEndpoint',
            'actions',
          ]) ?? [];

        for (const action of actions) {
          if (
            action['action'] === 'ACTION_REMOVE_VIDEO' &&
            action['setVideoId']
          ) {
            setVideoId = action['setVideoId'] as string;
            break;
          }
        }
        if (setVideoId) break;
      }
    }

    // ── FIX: Reject the YouTube-internal placeholder value.
    //
    // When YouTube Music hasn't resolved the setVideoId for a track yet (e.g.
    // unavailable videos, podcast episodes, locally-uploaded tracks), it emits
    // the literal string "to_be_updated_by_client" as a sentinel. Sending this
    // value to edit_playlist causes an immediate HTTP 400 INVALID_ARGUMENT for
    // the ENTIRE batch — not just the one bad track. We must drop these tracks
    // at parse time so they never reach the actions array.
    if (setVideoId === PLACEHOLDER_SET_VIDEO_ID) {
      logger.warn(
        `Track at index ${index} has placeholder setVideoId — skipping (videoId=${videoId}). ` +
        'This usually means the track is unavailable, a podcast episode, or a local upload.'
      );
      return null;
    }

    if (!videoId || !setVideoId) {
      logger.debug(`Track at index ${index}: missing videoId or setVideoId`, {
        videoId,
        setVideoId,
        rendererKeys: Object.keys(renderer),
      });
      return null;
    }

    const cols =
      (renderer['flexColumns'] as Array<Record<string, unknown>> | undefined) ??
      [];

    const colText = (colIdx: number): string => {
      const runs =
        this.deepGet<Array<{ text: string }>>(cols[colIdx] ?? {}, [
          'musicResponsiveListItemFlexColumnRenderer',
          'text',
          'runs',
        ]) ?? [];
      return runs.map(r => r.text).join('') || '';
    };

    const title = colText(0) || 'Unknown Title';
    const artist = colText(1) || 'Unknown Artist';
    const duration = colText(cols.length - 1) || '';

    return { videoId, setVideoId, title, artist, duration, index };
  }

  private deepGet<T>(
    obj: Record<string, unknown>,
    path: string[]
  ): T | undefined {
    let cur: unknown = obj;
    for (const key of path) {
      if (cur === null || cur === undefined || typeof cur !== 'object') {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur as T | undefined;
  }
}

// Singleton used throughout the extension
export const apiClient = new YtMusicApiClient();